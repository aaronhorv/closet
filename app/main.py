"""Closet tracker + outfit recommender: API and static web UI."""
import base64
import os
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date
from typing import List, Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel

from . import ai, recommender, weather

DATA_DIR = os.environ.get("DATA_DIR", "/data")
PHOTO_DIR = os.path.join(DATA_DIR, "photos")
DB_PATH = os.path.join(DATA_DIR, "closet.db")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    color       TEXT NOT NULL DEFAULT '',
    warmth      INTEGER NOT NULL DEFAULT 3,   -- 1 very light .. 5 very warm
    formality   INTEGER NOT NULL DEFAULT 2,   -- 1 casual, 2 smart casual, 3 formal
    brand       TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    photo       TEXT,
    favorite    INTEGER NOT NULL DEFAULT 0,
    in_laundry  INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS outfits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    worn_on     TEXT NOT NULL,
    occasion    INTEGER,
    rating      INTEGER,
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS outfit_items (
    outfit_id   INTEGER NOT NULL REFERENCES outfits(id) ON DELETE CASCADE,
    item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (outfit_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_outfit_items_item ON outfit_items(item_id);
CREATE TABLE IF NOT EXISTS saved_outfits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS saved_outfit_items (
    saved_id    INTEGER NOT NULL REFERENCES saved_outfits(id) ON DELETE CASCADE,
    item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (saved_id, item_id)
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = {"unit": "C", "location_name": "", "lat": "", "lon": "", "outerwear_below": "16", "ai_prompt": ""}

ITEM_SELECT = """
SELECT i.*, COUNT(o.id) AS times_worn, MAX(o.worn_on) AS last_worn, AVG(o.rating) AS avg_rating
FROM items i
LEFT JOIN outfit_items oi ON oi.item_id = i.id
LEFT JOIN outfits o ON o.id = oi.outfit_id
"""


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    os.makedirs(PHOTO_DIR, exist_ok=True)
    with db() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)


init_db()
app = FastAPI(title="Closet", docs_url=None, redoc_url=None)


# ---------- optional password ----------

@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if APP_PASSWORD and request.url.path != "/healthz":
        ok = False
        header = request.headers.get("authorization", "")
        if header.lower().startswith("basic "):
            try:
                _, _, pw = base64.b64decode(header[6:]).decode("utf-8").partition(":")
                ok = secrets.compare_digest(pw.encode(), APP_PASSWORD.encode())
            except Exception:
                ok = False
        if not ok:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="Closet"'})
    response = await call_next(request)
    if request.url.path.startswith("/photos/"):
        # photo names are random and never reused, so they can be cached for good
        response.headers["Cache-Control"] = "private, max-age=31536000, immutable"
    else:
        # always check for a newer app version after updates
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/healthz")
def healthz():
    return {"ok": True}


# ---------- helpers ----------

def item_dict(row) -> dict:
    d = dict(row)
    d["photo_url"] = f"/photos/{d['photo']}" if d.get("photo") else None
    for k in ("favorite", "in_laundry", "archived"):
        d[k] = bool(d[k])
    if d.get("avg_rating") is not None:
        d["avg_rating"] = round(d["avg_rating"], 2)
    return d


def fetch_items(conn, where="", params=()):
    sql = ITEM_SELECT + (f" WHERE {where}" if where else "") + " GROUP BY i.id ORDER BY i.category, i.name"
    return [item_dict(r) for r in conn.execute(sql, params)]


def get_item(conn, item_id: int) -> dict:
    rows = fetch_items(conn, "i.id = ?", (item_id,))
    if not rows:
        raise HTTPException(404, "Item not found")
    return rows[0]


def get_settings(conn) -> dict:
    s = dict(DEFAULT_SETTINGS)
    s.update({r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")})
    return {
        "unit": s["unit"] if s["unit"] in ("C", "F") else "C",
        "location_name": s["location_name"],
        "lat": float(s["lat"]) if s["lat"] else None,
        "lon": float(s["lon"]) if s["lon"] else None,
        "outerwear_below": float(s["outerwear_below"] or 16),
        "ai_prompt": s["ai_prompt"],
    }


def save_photo(upload: UploadFile) -> str:
    try:
        img = Image.open(upload.file)
        img = ImageOps.exif_transpose(img)
    except Exception:
        raise HTTPException(400, "Couldn't read that image. Try a JPEG or PNG.")
    if img.mode != "RGB":
        rgba = img.convert("RGBA")
        img = Image.new("RGB", rgba.size, (255, 255, 255))
        img.paste(rgba, mask=rgba.split()[3])
    img.thumbnail((1200, 1200))
    name = f"{uuid.uuid4().hex}.jpg"
    img.save(os.path.join(PHOTO_DIR, name), "JPEG", quality=85, optimize=True)
    return name


def delete_photo(name: Optional[str]):
    if name:
        try:
            os.remove(os.path.join(PHOTO_DIR, os.path.basename(name)))
        except FileNotFoundError:
            pass


# ---------- items ----------

def item_form(
    name: str = Form(...),
    category: str = Form(...),
    color: str = Form(""),
    warmth: int = Form(3),
    formality: int = Form(2),
    brand: str = Form(""),
    tags: str = Form(""),
    notes: str = Form(""),
    favorite: bool = Form(False),
) -> dict:
    name = name.strip()
    if not name:
        raise HTTPException(400, "Name is required")
    if category not in recommender.CATEGORIES:
        raise HTTPException(400, "Unknown category")
    return {
        "name": name[:120],
        "category": category,
        "color": color.strip()[:40],
        "warmth": min(5, max(1, warmth)),
        "formality": min(3, max(1, formality)),
        "brand": brand.strip()[:80],
        "tags": tags.strip()[:200],
        "notes": notes.strip()[:1000],
        "favorite": int(favorite),
    }


@app.get("/api/items")
def list_items(include_archived: bool = False):
    with db() as conn:
        return fetch_items(conn, "" if include_archived else "i.archived = 0")


@app.post("/api/items")
def create_item(fields: dict = Depends(item_form), photo: Optional[UploadFile] = File(None)):
    if photo is not None and photo.filename:
        fields["photo"] = save_photo(photo)
    cols = ", ".join(fields)
    marks = ", ".join("?" for _ in fields)
    with db() as conn:
        cur = conn.execute(f"INSERT INTO items ({cols}) VALUES ({marks})", tuple(fields.values()))
        return get_item(conn, cur.lastrowid)


@app.put("/api/items/{item_id}")
def update_item(
    item_id: int,
    fields: dict = Depends(item_form),
    photo: Optional[UploadFile] = File(None),
    remove_photo: bool = Form(False),
):
    with db() as conn:
        old = get_item(conn, item_id)
        if photo is not None and photo.filename:
            fields["photo"] = save_photo(photo)
            delete_photo(old["photo"])
        elif remove_photo:
            fields["photo"] = None
            delete_photo(old["photo"])
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE items SET {sets} WHERE id = ?", (*fields.values(), item_id))
        return get_item(conn, item_id)


class ItemFlags(BaseModel):
    favorite: Optional[bool] = None
    in_laundry: Optional[bool] = None
    archived: Optional[bool] = None


@app.patch("/api/items/{item_id}")
def patch_item(item_id: int, flags: ItemFlags):
    changes = {k: int(v) for k, v in flags.model_dump().items() if v is not None}
    with db() as conn:
        get_item(conn, item_id)
        if changes:
            sets = ", ".join(f"{k} = ?" for k in changes)
            conn.execute(f"UPDATE items SET {sets} WHERE id = ?", (*changes.values(), item_id))
        return get_item(conn, item_id)


@app.delete("/api/items/{item_id}")
def delete_item(item_id: int):
    with db() as conn:
        old = get_item(conn, item_id)
        conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
        conn.execute("DELETE FROM outfits WHERE id NOT IN (SELECT outfit_id FROM outfit_items)")
        conn.execute("DELETE FROM saved_outfits WHERE id NOT IN (SELECT saved_id FROM saved_outfit_items)")
    delete_photo(old["photo"])
    return {"ok": True}


@app.post("/api/laundry/clear")
def clear_laundry():
    with db() as conn:
        n = conn.execute("UPDATE items SET in_laundry = 0 WHERE in_laundry = 1").rowcount
    return {"cleared": n}


# ---------- recommendations ----------

@app.get("/api/recommend")
def recommend(
    occasion: int = 2,
    on: Optional[str] = None,
    seed: str = "",
    temp: Optional[float] = None,
    rain: Optional[bool] = None,
):
    try:
        target = date.fromisoformat(on) if on else date.today()
    except ValueError:
        raise HTTPException(400, "Bad date")
    occasion = min(3, max(1, occasion))

    with db() as conn:
        settings = get_settings(conn)
        items = fetch_items(conn, "i.archived = 0")

    day_wx, wx_error = None, None
    if settings["lat"] is not None and settings["lon"] is not None:
        try:
            fc = weather.forecast(settings["lat"], settings["lon"])
            day_wx = next((d for d in fc["days"] if d["date"] == target.isoformat()), fc["days"][0])
        except Exception as e:  # network trouble shouldn't break suggestions
            wx_error = str(e)

    if temp is None and day_wx:
        temp = day_wx["effective"]
    if rain is None:
        rain = bool(day_wx and day_wx["rainy"])

    result = recommender.recommend(
        items, occasion=occasion, temp=temp, rainy=rain, on=target,
        seed=f"{target}-{occasion}-{seed}", outerwear_below=settings["outerwear_below"],
    )
    result["weather"] = day_wx
    result["weather_error"] = wx_error
    return result


# ---------- outfit log ----------

class OutfitIn(BaseModel):
    item_ids: List[int]
    worn_on: Optional[str] = None
    occasion: Optional[int] = None
    rating: Optional[int] = None
    notes: str = ""


class OutfitPatch(BaseModel):
    rating: Optional[int] = None
    notes: Optional[str] = None


def _check_rating(r):
    if r is not None and not 1 <= r <= 5:
        raise HTTPException(400, "Rating must be 1-5")


def fetch_outfits(conn, limit=200):
    outfits = [dict(r) for r in conn.execute(
        "SELECT * FROM outfits ORDER BY worn_on DESC, id DESC LIMIT ?", (limit,))]
    if not outfits:
        return []
    ids = [o["id"] for o in outfits]
    marks = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""SELECT oi.outfit_id, i.id, i.name, i.category, i.color, i.photo
            FROM outfit_items oi JOIN items i ON i.id = oi.item_id
            WHERE oi.outfit_id IN ({marks})""", ids).fetchall()
    by_outfit = {}
    for r in rows:
        it = {"id": r["id"], "name": r["name"], "category": r["category"], "color": r["color"],
              "photo_url": f"/photos/{r['photo']}" if r["photo"] else None}
        by_outfit.setdefault(r["outfit_id"], []).append(it)
    for o in outfits:
        o["items"] = sorted(by_outfit.get(o["id"], []),
                            key=lambda i: recommender.DISPLAY_ORDER.index(i["category"]))
    return outfits


@app.get("/api/outfits")
def list_outfits(limit: int = 200):
    with db() as conn:
        return fetch_outfits(conn, min(max(limit, 1), 1000))


@app.post("/api/outfits")
def log_outfit(body: OutfitIn):
    ids = sorted(set(body.item_ids))
    if not ids:
        raise HTTPException(400, "Pick at least one item")
    _check_rating(body.rating)
    try:
        worn_on = date.fromisoformat(body.worn_on) if body.worn_on else date.today()
    except ValueError:
        raise HTTPException(400, "Bad date")
    with db() as conn:
        marks = ",".join("?" for _ in ids)
        found = conn.execute(f"SELECT COUNT(*) FROM items WHERE id IN ({marks})", ids).fetchone()[0]
        if found != len(ids):
            raise HTTPException(400, "Unknown item in outfit")
        cur = conn.execute(
            "INSERT INTO outfits (worn_on, occasion, rating, notes) VALUES (?, ?, ?, ?)",
            (worn_on.isoformat(), body.occasion, body.rating, body.notes.strip()[:1000]))
        conn.executemany("INSERT INTO outfit_items (outfit_id, item_id) VALUES (?, ?)",
                         [(cur.lastrowid, i) for i in ids])
        return {"id": cur.lastrowid}


@app.patch("/api/outfits/{outfit_id}")
def patch_outfit(outfit_id: int, body: OutfitPatch):
    _check_rating(body.rating)
    with db() as conn:
        if not conn.execute("SELECT 1 FROM outfits WHERE id = ?", (outfit_id,)).fetchone():
            raise HTTPException(404, "Outfit not found")
        if body.rating is not None:
            conn.execute("UPDATE outfits SET rating = ? WHERE id = ?", (body.rating, outfit_id))
        if body.notes is not None:
            conn.execute("UPDATE outfits SET notes = ? WHERE id = ?", (body.notes.strip()[:1000], outfit_id))
    return {"ok": True}


@app.delete("/api/outfits/{outfit_id}")
def delete_outfit(outfit_id: int):
    with db() as conn:
        conn.execute("DELETE FROM outfits WHERE id = ?", (outfit_id,))
    return {"ok": True}


# ---------- saved outfits ----------

def ordered(items):
    return sorted(items, key=lambda i: (recommender.DISPLAY_ORDER.index(i["category"]), i["name"]))


def fetch_saved(conn):
    saved = [dict(r) for r in conn.execute("SELECT * FROM saved_outfits ORDER BY id DESC")]
    if not saved:
        return []
    items = {i["id"]: i for i in fetch_items(conn)}
    links = {}
    for r in conn.execute("SELECT saved_id, item_id FROM saved_outfit_items"):
        if r["item_id"] in items:
            links.setdefault(r["saved_id"], []).append(items[r["item_id"]])
    for s in saved:
        s["items"] = ordered(links.get(s["id"], []))
    return saved


class SavedIn(BaseModel):
    item_ids: List[int]
    name: str = ""
    notes: str = ""


@app.get("/api/saved")
def list_saved():
    with db() as conn:
        return fetch_saved(conn)


@app.post("/api/saved")
def save_outfit(body: SavedIn):
    ids = sorted(set(body.item_ids))
    if not ids:
        raise HTTPException(400, "Pick at least one item")
    with db() as conn:
        marks = ",".join("?" for _ in ids)
        found = conn.execute(f"SELECT COUNT(*) FROM items WHERE id IN ({marks})", ids).fetchone()[0]
        if found != len(ids):
            raise HTTPException(400, "Unknown item in outfit")
        cur = conn.execute("INSERT INTO saved_outfits (name, notes) VALUES (?, ?)",
                           (body.name.strip()[:80], body.notes.strip()[:500]))
        conn.executemany("INSERT INTO saved_outfit_items (saved_id, item_id) VALUES (?, ?)",
                         [(cur.lastrowid, i) for i in ids])
        return {"id": cur.lastrowid}


@app.delete("/api/saved/{saved_id}")
def delete_saved(saved_id: int):
    with db() as conn:
        conn.execute("DELETE FROM saved_outfits WHERE id = ?", (saved_id,))
    return {"ok": True}


# ---------- AI (optional, needs OPENAI_API_KEY) ----------

@app.get("/api/config")
def config():
    with db() as conn:
        saved = conn.execute("SELECT COUNT(*) FROM saved_outfits").fetchone()[0]
    return {"ai_enabled": ai.enabled(), "saved_count": saved}


def require_ai():
    if not ai.enabled():
        raise HTTPException(400, "AI is not set up. Add OPENAI_API_KEY to enable it.")


@app.post("/api/ai/describe")
def ai_describe(photo: UploadFile = File(...)):
    require_ai()
    raw = photo.file.read(25 * 1024 * 1024 + 1)
    if len(raw) > 25 * 1024 * 1024:
        raise HTTPException(400, "That photo is too large.")
    try:
        return ai.describe_photo(raw)
    except ai.AIError as e:
        raise HTTPException(502, str(e))


# How many pieces of each category one outfit may hold (two tops = layering).
OUTFIT_LIMITS = {"top": 2, "bottom": 1, "dress": 1, "outerwear": 1, "shoes": 1, "accessory": 2}


def check_outfit(ids, allowed: dict, anchor_id=None):
    """Keep only known, clean items; return the item list or None if it isn't a full outfit."""
    picked, counts = [], {}
    for i in dict.fromkeys(ids):
        it = allowed.get(i)
        if it is None:
            continue
        c = it["category"]
        if counts.get(c, 0) >= OUTFIT_LIMITS[c]:
            continue
        counts[c] = counts.get(c, 0) + 1
        picked.append(it)
    if not (counts.get("dress") or (counts.get("top") and counts.get("bottom"))):
        return None
    if anchor_id is not None and anchor_id not in {i["id"] for i in picked}:
        return None
    return ordered(picked)


class AIOutfitsIn(BaseModel):
    anchor_id: Optional[int] = None
    note: str = ""


@app.post("/api/ai/outfits")
def ai_outfits(body: AIOutfitsIn):
    require_ai()
    with db() as conn:
        settings = get_settings(conn)
        items = fetch_items(conn, "i.archived = 0")
        existing = [
            [r["item_id"] for r in conn.execute(
                "SELECT item_id FROM saved_outfit_items WHERE saved_id = ? ORDER BY item_id", (s["id"],))]
            for s in conn.execute("SELECT id FROM saved_outfits ORDER BY id DESC LIMIT 30").fetchall()
        ]
    allowed = {i["id"]: i for i in items if not i["in_laundry"]}
    anchor = None
    if body.anchor_id is not None:
        anchor = next((i for i in items if i["id"] == body.anchor_id), None)
        if anchor is None:
            raise HTTPException(404, "Item not found")
        allowed[anchor["id"]] = anchor  # you can plan around a piece even if it's in the wash
    if not any(i["category"] in ("top", "dress") for i in allowed.values()):
        raise HTTPException(400, "Add some clean tops and bottoms (or dresses) first.")

    count = 3 if anchor else 5
    try:
        raw = ai.build_outfits(list(allowed.values()), count, anchor, body.note, existing,
                              settings["ai_prompt"])
    except ai.AIError as e:
        raise HTTPException(502, str(e))

    seen = {frozenset(ids) for ids in existing}
    outfits = []
    for o in raw:
        its = check_outfit(o.get("item_ids") or [], allowed, anchor["id"] if anchor else None)
        if not its:
            continue
        key = frozenset(i["id"] for i in its)
        if key in seen:
            continue
        seen.add(key)
        outfits.append({"name": str(o.get("name") or "").strip()[:80],
                        "reason": str(o.get("reason") or "").strip()[:300],
                        "items": its})
        if len(outfits) >= count:
            break
    if not outfits:
        raise HTTPException(502, "The AI's outfits didn't match your closet. Try again.")
    return {"outfits": outfits}


# ---------- settings ----------

class SettingsIn(BaseModel):
    unit: Optional[str] = None
    location_name: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    outerwear_below: Optional[float] = None
    ai_prompt: Optional[str] = None


@app.get("/api/settings")
def read_settings():
    with db() as conn:
        return get_settings(conn)


@app.put("/api/settings")
def write_settings(body: SettingsIn):
    data = body.model_dump(exclude_unset=True)
    if "unit" in data and data["unit"] not in ("C", "F"):
        raise HTTPException(400, "Unit must be C or F")
    if data.get("ai_prompt") is not None:
        data["ai_prompt"] = data["ai_prompt"].strip()[:1000]
    with db() as conn:
        for k, v in data.items():
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                         (k, "" if v is None else str(v)))
        return get_settings(conn)


@app.get("/api/geocode")
def geocode(q: str):
    if len(q.strip()) < 2:
        return []
    try:
        return weather.geocode(q.strip())
    except Exception:
        raise HTTPException(502, "Location search is unavailable right now")


# ---------- static files (keep last) ----------

app.mount("/photos", StaticFiles(directory=PHOTO_DIR), name="photos")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
