"""Closet tracker + outfit recommender: API and static web UI."""
import base64
import io
import json
import mimetypes
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

from . import ai, cutout, kinds, menswear, pages, recommender, weather
from . import rules as rulebook

mimetypes.add_type("image/webp", ".webp")  # cut-out photos; not in every system's type list

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
CREATE TABLE IF NOT EXISTS discarded_outfits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT NOT NULL,          -- sorted item ids of the clothes (no coats, socks, accessories)
    reason      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS discarded_items (
    discarded_id INTEGER NOT NULL REFERENCES discarded_outfits(id) ON DELETE CASCADE,
    item_id      INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (discarded_id, item_id)
);
-- Photos of whole outfits: your own pictures and AI try-ons. Exactly one of outfit_id / saved_id is set,
-- or neither for a try-on of an AI outfit that hasn't been saved yet (cleaned up after a day).
CREATE TABLE IF NOT EXISTS outfit_photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    outfit_id   INTEGER,
    saved_id    INTEGER,
    file        TEXT NOT NULL,
    original    TEXT,
    source      TEXT NOT NULL DEFAULT 'own',   -- own | tryon
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = {"unit": "C", "location_name": "", "lat": "", "lon": "", "outerwear_below": "16",
                    "ai_prompt": "", "openai_key": "", "ai_model": "", "rules": "[]",
                    "menswear": "1", "tryon_quality": "medium", "tryon_body": "", "tryon_face": ""}
TRYON_QUALITIES = ("low", "medium", "high")

# Item columns added after the first release. init_db adds any that an older database is missing.
EXTRA_ITEM_COLUMNS = {
    "color2": "TEXT NOT NULL DEFAULT ''",
    "pattern": "TEXT NOT NULL DEFAULT ''",
    "material": "TEXT NOT NULL DEFAULT ''",
    "fit": "TEXT NOT NULL DEFAULT ''",
    "photo_original": "TEXT",   # set when the background was removed; lets you undo it
    "kind": "TEXT NOT NULL DEFAULT ''",      # type within the category: shirt, sweater, formal shoes...
    "match_id": "INTEGER",                   # the other half of a suit (jacket <-> trousers)
    "pair_only": "INTEGER NOT NULL DEFAULT 0",  # only wear together with match_id
}
# saved_outfits is the outfit list: status idea (to review), kept (my outfits) or rejected.
EXTRA_SAVED_COLUMNS = {
    "occasion": "INTEGER",
    "status": "TEXT NOT NULL DEFAULT 'kept'",
    "source": "TEXT NOT NULL DEFAULT ''",      # ai | today | own
    "reason": "TEXT NOT NULL DEFAULT ''",      # why it was rejected
    "updated_at": "TEXT",                      # ideas are reviewed oldest first; "Later" bumps this
    "rating": "INTEGER",                       # your own stars for the outfit (1-5)
}
EXTRA_LOG_COLUMNS = {"library_id": "INTEGER"}
EXTRA_PHOTO_COLUMNS = {"review": "TEXT"}         # the AI's outfit check of this photo (JSON)  # the outfit from your list that was worn
STATUSES = ("idea", "kept", "rejected")
# Categories that can be linked as a suit.
PAIRS = {"suit": "bottom", "bottom": "suit"}

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
        have = {r["name"] for r in conn.execute("PRAGMA table_info(items)")}
        for col, decl in EXTRA_ITEM_COLUMNS.items():
            if col not in have:
                conn.execute(f"ALTER TABLE items ADD COLUMN {col} {decl}")
        if "kind" not in have:
            upgrade_kinds(conn)
        have = {r["name"] for r in conn.execute("PRAGMA table_info(saved_outfits)")}
        for col, decl in EXTRA_SAVED_COLUMNS.items():
            if col not in have:
                conn.execute(f"ALTER TABLE saved_outfits ADD COLUMN {col} {decl}")
        have = {r["name"] for r in conn.execute("PRAGMA table_info(outfits)")}
        for col, decl in EXTRA_LOG_COLUMNS.items():
            if col not in have:
                conn.execute(f"ALTER TABLE outfits ADD COLUMN {col} {decl}")
        have = {r["name"] for r in conn.execute("PRAGMA table_info(outfit_photos)")}
        for col, decl in EXTRA_PHOTO_COLUMNS.items():
            if col not in have:
                conn.execute(f"ALTER TABLE outfit_photos ADD COLUMN {col} {decl}")
        migrate_library(conn)
        load_ai_config(conn)


def upgrade_kinds(conn):
    """First start with item types: move blazers to the new suit category and guess every item's type."""
    for r in conn.execute("SELECT id, name, category, tags FROM items").fetchall():
        cat = r["category"]
        if cat in ("outerwear", "top") and kinds.is_tailoring(r["name"]):
            cat = "suit"
        kind = kinds.guess_kind(f"{r['name']} {r['tags']}", cat)
        conn.execute("UPDATE items SET category = ?, kind = ? WHERE id = ?", (cat, kind, r["id"]))


def clothes_keys(conn, link_table: str, owner_col: str) -> dict:
    """owner id -> the set of clothes in it (no coats, socks or accessories), straight from the database."""
    out = {}
    for r in conn.execute(f"SELECT l.{owner_col} AS owner, i.id, i.category FROM {link_table} l "
                          f"JOIN items i ON i.id = l.item_id"):
        if r["category"] not in ("outerwear", "socks", "accessory"):
            out.setdefault(r["owner"], set()).add(r["id"])
    return {k: frozenset(v) for k, v in out.items()}


def link_logs(conn):
    """Connect worn outfits in History to the matching outfit in your list."""
    kept = {r["id"] for r in conn.execute("SELECT id FROM saved_outfits WHERE status = 'kept' ORDER BY id")}
    by_key = {}
    for sid, k in clothes_keys(conn, "saved_outfit_items", "saved_id").items():
        if sid in kept and k:
            by_key.setdefault(k, sid)
    if not by_key:
        return
    unlinked = {r["id"] for r in conn.execute("SELECT id FROM outfits WHERE library_id IS NULL")}
    for oid, k in clothes_keys(conn, "outfit_items", "outfit_id").items():
        if oid in unlinked and k in by_key:
            conn.execute("UPDATE outfits SET library_id = ? WHERE id = ?", (by_key[k], oid))


def migrate_library(conn):
    """Discarded outfits move into the outfit list as rejected ones; History gets linked to your outfits."""
    for d in conn.execute("SELECT * FROM discarded_outfits").fetchall():
        ids = [r["item_id"] for r in conn.execute("SELECT item_id FROM discarded_items WHERE discarded_id = ?", (d["id"],))]
        if ids:
            cur = conn.execute("INSERT INTO saved_outfits (status, source, reason, created_at) VALUES ('rejected', 'today', ?, ?)",
                               (d["reason"], d["created_at"]))
            conn.executemany("INSERT INTO saved_outfit_items (saved_id, item_id) VALUES (?, ?)", [(cur.lastrowid, i) for i in ids])
        conn.execute("DELETE FROM discarded_outfits WHERE id = ?", (d["id"],))
    link_logs(conn)


def raw_settings(conn) -> dict:
    s = dict(DEFAULT_SETTINGS)
    s.update({r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")})
    return s


def load_ai_config(conn):
    s = raw_settings(conn)
    ai.set_config(s["openai_key"], s["ai_model"])


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
    d["has_original"] = bool(d.pop("photo_original", None))
    d["pair_only"] = bool(d.get("pair_only"))
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
    """Settings for the browser. The API key itself is never sent back, only its last 4 characters."""
    s = raw_settings(conn)
    key = ai.api_key()
    return {
        "unit": s["unit"] if s["unit"] in ("C", "F") else "C",
        "location_name": s["location_name"],
        "lat": float(s["lat"]) if s["lat"] else None,
        "lon": float(s["lon"]) if s["lon"] else None,
        "outerwear_below": float(s["outerwear_below"] or 16),
        "ai_prompt": s["ai_prompt"],
        "ai_model": s["ai_model"],
        "ai_model_effective": ai.model(),
        "ai_models": ai.MODELS,
        "ai_key_source": ai.key_source(),
        "ai_key_hint": f"…{key[-4:]}" if len(key) >= 8 else ("set" if key else ""),
        "rules": read_rules(s),
        "menswear": s["menswear"] != "0",
        "menswear_rules": menswear.SUMMARY,
        "tryon_quality": s["tryon_quality"] if s["tryon_quality"] in TRYON_QUALITIES else "medium",
        "tryon_body_url": f"/photos/{s['tryon_body']}" if s["tryon_body"] else None,
        "tryon_face_url": f"/photos/{s['tryon_face']}" if s["tryon_face"] else None,
        "tryon_model": ai.TRYON_MODEL,
    }


def read_rules(raw: dict) -> list:
    try:
        return rulebook.normalize(json.loads(raw.get("rules") or "[]"))
    except ValueError:
        return []


def save_photo(upload: UploadFile, max_side: int = 1200) -> str:
    try:
        img = Image.open(upload.file)
        img = ImageOps.exif_transpose(img)
    except Exception:
        raise HTTPException(400, "Couldn't read that image. Try a JPEG or PNG.")
    if img.mode != "RGB":
        rgba = img.convert("RGBA")
        img = Image.new("RGB", rgba.size, (255, 255, 255))
        img.paste(rgba, mask=rgba.split()[3])
    img.thumbnail((max_side, max_side))
    name = f"{uuid.uuid4().hex}.jpg"
    img.save(os.path.join(PHOTO_DIR, name), "JPEG", quality=85, optimize=True)
    return name


def delete_photo(name: Optional[str]):
    if name:
        try:
            os.remove(os.path.join(PHOTO_DIR, os.path.basename(name)))
        except FileNotFoundError:
            pass


def make_cutout(name: str) -> str:
    """Cut the item out of a saved photo; returns the new (transparent WebP) file name."""
    with Image.open(os.path.join(PHOTO_DIR, os.path.basename(name))) as img:
        out = cutout.remove_background(img)
    new = f"{uuid.uuid4().hex}.webp"
    out.save(os.path.join(PHOTO_DIR, new), "WEBP", quality=85, method=4)
    return new


def canonical_brand(conn, brand: str) -> str:
    """Reuse the existing spelling of a brand ("boss" -> "BOSS" if BOSS is already used)."""
    if not brand:
        return brand
    row = conn.execute("SELECT brand FROM items WHERE brand <> '' AND lower(brand) = lower(?) "
                       "GROUP BY brand ORDER BY COUNT(*) DESC LIMIT 1", (brand,)).fetchone()
    return row["brand"] if row else brand


# ---------- items ----------

def item_form(
    name: str = Form(...),
    category: str = Form(...),
    kind: str = Form(""),
    match_id: str = Form(""),
    pair_only: bool = Form(False),
    color: str = Form(""),
    color2: str = Form(""),
    pattern: str = Form(""),
    material: str = Form(""),
    fit: str = Form(""),
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
    if category not in kinds.CATEGORIES:
        raise HTTPException(400, "Unknown category")
    kind = kinds.clean_kind(kind, category) or kinds.guess_kind(f"{name} {tags}", category)
    try:
        match = int(match_id) if match_id.strip() and category in PAIRS else None
    except ValueError:
        match = None
    return {
        "name": name[:120],
        "category": category,
        "kind": kind,
        "match_id": match,
        "pair_only": int(pair_only and match is not None),
        "color": color.strip()[:40],
        "color2": color2.strip()[:40],
        "pattern": pattern if pattern in ai.PATTERNS else "",
        "material": material.strip()[:60],
        "fit": fit if fit in ai.FITS else "",
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


def link_pair(conn, item_id: int, match_id: Optional[int]):
    """Keep suit links two-way: A <-> B. Clears links that no longer hold."""
    row = conn.execute("SELECT category, match_id FROM items WHERE id = ?", (item_id,)).fetchone()
    if match_id is not None:
        mate = conn.execute("SELECT category FROM items WHERE id = ?", (match_id,)).fetchone()
        if not mate or match_id == item_id or PAIRS.get(row["category"]) != mate["category"]:
            raise HTTPException(400, "A suit jacket can only be matched with a bottom, and the other way round.")
    # drop old links that point at either piece (but keep the partner's own settings)
    conn.execute("UPDATE items SET match_id = NULL, pair_only = 0 WHERE match_id = ? AND id IS NOT ?",
                 (item_id, match_id))
    if match_id is not None:
        conn.execute("UPDATE items SET match_id = NULL, pair_only = 0 WHERE match_id = ? AND id <> ?", (match_id, item_id))
        conn.execute("UPDATE items SET match_id = ? WHERE id = ?", (item_id, match_id))
    conn.execute("UPDATE items SET match_id = ? WHERE id = ?", (match_id, item_id))


def apply_cutout(fields: dict) -> Optional[str]:
    """Replace fields["photo"] with a cut-out version, keeping the original. Returns an error message or None."""
    try:
        cut = make_cutout(fields["photo"])
    except cutout.CutoutError as e:
        return str(e)
    fields["photo_original"], fields["photo"] = fields["photo"], cut
    return None


@app.post("/api/items")
def create_item(fields: dict = Depends(item_form), photo: Optional[UploadFile] = File(None),
                cutout_photo: bool = Form(False)):
    warning = None
    if photo is not None and photo.filename:
        fields["photo"] = save_photo(photo)
        if cutout_photo:
            warning = apply_cutout(fields)
    with db() as conn:
        fields["brand"] = canonical_brand(conn, fields["brand"])
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        cur = conn.execute(f"INSERT INTO items ({cols}) VALUES ({marks})", tuple(fields.values()))
        if fields["match_id"] is not None:
            link_pair(conn, cur.lastrowid, fields["match_id"])
        item = get_item(conn, cur.lastrowid)
    item["cutout_error"] = warning
    return item


@app.put("/api/items/{item_id}")
def update_item(
    item_id: int,
    fields: dict = Depends(item_form),
    photo: Optional[UploadFile] = File(None),
    remove_photo: bool = Form(False),
    cutout_photo: bool = Form(False),
):
    warning = None
    with db() as conn:
        old = get_item(conn, item_id)
        old_files = photo_files(conn, item_id)
        if photo is not None and photo.filename:
            fields["photo"] = save_photo(photo)
            fields["photo_original"] = None
            if cutout_photo:
                warning = apply_cutout(fields)
            for f in old_files:
                delete_photo(f)
        elif remove_photo:
            fields["photo"] = fields["photo_original"] = None
            for f in old_files:
                delete_photo(f)
        fields["brand"] = canonical_brand(conn, fields["brand"])
        sets = ", ".join(f"{k} = ?" for k in fields)
        conn.execute(f"UPDATE items SET {sets} WHERE id = ?", (*fields.values(), item_id))
        link_pair(conn, item_id, fields["match_id"])
        item = get_item(conn, item_id)
    item["cutout_error"] = warning
    return item


def photo_files(conn, item_id: int) -> list:
    row = conn.execute("SELECT photo, photo_original FROM items WHERE id = ?", (item_id,)).fetchone()
    return [f for f in (row["photo"], row["photo_original"]) if f] if row else []


@app.post("/api/items/{item_id}/cutout")
def cutout_item(item_id: int):
    """Remove the background of an item's photo (always starting from the original)."""
    with db() as conn:
        get_item(conn, item_id)
        row = conn.execute("SELECT photo, photo_original FROM items WHERE id = ?", (item_id,)).fetchone()
    if not row["photo"]:
        raise HTTPException(400, "This item has no photo.")
    source = row["photo_original"] or row["photo"]
    try:
        new = make_cutout(source)
    except cutout.CutoutError as e:
        raise HTTPException(400, str(e))
    with db() as conn:
        conn.execute("UPDATE items SET photo = ?, photo_original = ? WHERE id = ?", (new, source, item_id))
        item = get_item(conn, item_id)
    if row["photo_original"]:
        delete_photo(row["photo"])  # the previous cut-out
    return item


@app.post("/api/items/{item_id}/restore-photo")
def restore_photo(item_id: int):
    with db() as conn:
        get_item(conn, item_id)
        row = conn.execute("SELECT photo, photo_original FROM items WHERE id = ?", (item_id,)).fetchone()
        if not row["photo_original"]:
            raise HTTPException(400, "There's no original photo to go back to.")
        conn.execute("UPDATE items SET photo = photo_original, photo_original = NULL WHERE id = ?", (item_id,))
        item = get_item(conn, item_id)
    delete_photo(row["photo"])
    return item


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
        get_item(conn, item_id)
        old_files = photo_files(conn, item_id)
        conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
        conn.execute("UPDATE items SET match_id = NULL, pair_only = 0 WHERE match_id = ?", (item_id,))
        conn.execute("DELETE FROM outfits WHERE id NOT IN (SELECT outfit_id FROM outfit_items)")
        conn.execute("DELETE FROM saved_outfits WHERE id NOT IN (SELECT saved_id FROM saved_outfit_items)")
        conn.execute("DELETE FROM discarded_outfits WHERE id NOT IN (SELECT discarded_id FROM discarded_items)")
        purge_outfit_photos(conn)
    for f in old_files:
        delete_photo(f)
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
        history = outfit_history(conn)
        discarded = discarded_keys(conn)
        library = fetch_library(conn, "kept")
        known = {recommender.history_key(o["items"]) for o in fetch_library(conn)}

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
        rules=settings["rules"], history=history, classic=settings["menswear"], discarded=discarded,
        library=library, known=known,
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
    library_id: Optional[int] = None


def outfit_history(conn, limit=300) -> list:
    """Logged outfits (newest first), then saved ones: what you thought of each combination."""
    out = []
    for o in fetch_outfits(conn, limit):
        if o["rating"] or o["notes"]:
            out.append({"key": recommender.history_key(o["items"]), "rating": o["rating"], "notes": o["notes"],
                        "items": [i["id"] for i in o["items"]], "worn_on": o["worn_on"]})
    for s in fetch_saved(conn):
        if s["notes"]:
            out.append({"key": recommender.history_key(s["items"]), "rating": None, "notes": s["notes"],
                        "items": [i["id"] for i in s["items"]], "name": s["name"]})
    return out


def check_items(conn, ids):
    if not ids:
        raise HTTPException(400, "Pick at least one item")
    marks = ",".join("?" for _ in ids)
    found = conn.execute(f"SELECT COUNT(*) FROM items WHERE id IN ({marks})", ids).fetchone()[0]
    if found != len(ids):
        raise HTTPException(400, "Unknown item in outfit")


def check_occasion(o):
    if o is not None and o not in (1, 2, 3):
        raise HTTPException(400, "Occasion must be 1-3")


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
        f"""SELECT oi.outfit_id, i.id, i.name, i.category, i.kind, i.color, i.photo, i.match_id, i.pair_only
            FROM outfit_items oi JOIN items i ON i.id = oi.item_id
            WHERE oi.outfit_id IN ({marks})""", ids).fetchall()
    by_outfit = {}
    for r in rows:
        it = {"id": r["id"], "name": r["name"], "category": r["category"], "kind": r["kind"], "color": r["color"],
              "match_id": r["match_id"], "pair_only": bool(r["pair_only"]),
              "photo_url": f"/photos/{r['photo']}" if r["photo"] else None}
        by_outfit.setdefault(r["outfit_id"], []).append(it)
    photos = outfit_photos(conn, "outfit_id", ids)
    names = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM saved_outfits")}
    for o in outfits:
        o["library_name"] = (names.get(o["library_id"]) or "Outfit") if o.get("library_id") in names else None
        o["items"] = sorted(by_outfit.get(o["id"], []),
                            key=lambda i: recommender.DISPLAY_ORDER.index(i["category"]))
        o["photos"] = photos.get(o["id"], [])
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
    check_occasion(body.occasion)
    try:
        worn_on = date.fromisoformat(body.worn_on) if body.worn_on else date.today()
    except ValueError:
        raise HTTPException(400, "Bad date")
    with db() as conn:
        marks = ",".join("?" for _ in ids)
        found = conn.execute(f"SELECT COUNT(*) FROM items WHERE id IN ({marks})", ids).fetchone()[0]
        if found != len(ids):
            raise HTTPException(400, "Unknown item in outfit")
        lib = body.library_id
        if lib is not None and not conn.execute("SELECT 1 FROM saved_outfits WHERE id = ?", (lib,)).fetchone():
            lib = None
        cur = conn.execute(
            "INSERT INTO outfits (worn_on, occasion, rating, notes, library_id) VALUES (?, ?, ?, ?, ?)",
            (worn_on.isoformat(), body.occasion, body.rating, body.notes.strip()[:1000], lib))
        conn.executemany("INSERT INTO outfit_items (outfit_id, item_id) VALUES (?, ?)",
                         [(cur.lastrowid, i) for i in ids])
        if lib is None:
            link_logs(conn)
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


@app.put("/api/outfits/{outfit_id}")
def update_outfit(outfit_id: int, body: OutfitIn):
    ids = sorted(set(body.item_ids))
    _check_rating(body.rating)
    check_occasion(body.occasion)
    try:
        worn_on = date.fromisoformat(body.worn_on) if body.worn_on else None
    except ValueError:
        raise HTTPException(400, "Bad date")
    with db() as conn:
        if not conn.execute("SELECT 1 FROM outfits WHERE id = ?", (outfit_id,)).fetchone():
            raise HTTPException(404, "Outfit not found")
        check_items(conn, ids)
        conn.execute("UPDATE outfits SET worn_on = COALESCE(?, worn_on), occasion = ?, rating = ?, notes = ? WHERE id = ?",
                     (worn_on.isoformat() if worn_on else None, body.occasion, body.rating,
                      body.notes.strip()[:1000], outfit_id))
        conn.execute("DELETE FROM outfit_items WHERE outfit_id = ?", (outfit_id,))
        conn.executemany("INSERT INTO outfit_items (outfit_id, item_id) VALUES (?, ?)", [(outfit_id, i) for i in ids])
    return {"ok": True}


@app.delete("/api/outfits/{outfit_id}")
def delete_outfit(outfit_id: int):
    with db() as conn:
        conn.execute("DELETE FROM outfits WHERE id = ?", (outfit_id,))
        purge_outfit_photos(conn)
    return {"ok": True}


# ---------- saved outfits ----------

def ordered(items):
    return sorted(items, key=lambda i: (recommender.DISPLAY_ORDER.index(i["category"]), i["name"]))


def fetch_saved(conn):
    return fetch_library(conn, "kept")


def fetch_library(conn, status: Optional[str] = None):
    """Your outfit list. Ideas oldest first (review order), the rest newest first."""
    rows = conn.execute("SELECT * FROM saved_outfits" + (" WHERE status = ?" if status else ""),
                        (status,) if status else ()).fetchall()
    saved = [dict(r) for r in rows]
    if not saved:
        return []
    saved.sort(key=lambda o: (0, o["updated_at"] or o["created_at"], o["id"]) if o["status"] == "idea"
               else (1, "", -o["id"]))
    stats = {r["library_id"]: r for r in conn.execute(
        "SELECT library_id, COUNT(*) AS n, MAX(worn_on) AS last, AVG(rating) AS avg FROM outfits "
        "WHERE library_id IS NOT NULL GROUP BY library_id")}
    for o in saved:
        st = stats.get(o["id"])
        o["times_worn"] = st["n"] if st else 0
        o["last_worn"] = st["last"] if st else None
        worn_avg = round(st["avg"], 1) if st and st["avg"] is not None else None
        # your own stars win; otherwise the average of the days you wore it
        o["avg_rating"] = o["rating"] if o.get("rating") else worn_avg
    items = {i["id"]: i for i in fetch_items(conn)}
    links = {}
    for r in conn.execute("SELECT saved_id, item_id FROM saved_outfit_items"):
        if r["item_id"] in items:
            links.setdefault(r["saved_id"], []).append(items[r["item_id"]])
    photos = outfit_photos(conn, "saved_id", [s["id"] for s in saved])
    for s in saved:
        s["items"] = ordered(links.get(s["id"], []))
        s["photos"] = photos.get(s["id"], [])
    return saved


class SavedIn(BaseModel):
    item_ids: List[int]
    name: str = ""
    notes: str = ""
    occasion: Optional[int] = None
    photo_ids: List[int] = []   # try-ons of this outfit made before it was saved


def outfit_warnings(conn, items: list, occasion: Optional[int]) -> list:
    """Which of your rules (and classic menswear rules) an outfit breaks; weather-dependent rules are skipped."""
    settings = get_settings(conn)
    occ = occasion or 2
    out = [rulebook.describe(r) for r in rulebook.broken(items, rulebook.active(settings["rules"], occ, None))]
    if settings["menswear"]:
        out += menswear.broken(items, occ, None)
    if any(i.get("pair_only") and i.get("match_id") not in {x["id"] for x in items} for i in items):
        out.append("A piece that's only worn with its suit partner is on its own.")
    return out


class LibraryIn(BaseModel):
    item_ids: List[int]
    name: str = ""
    notes: str = ""
    occasion: Optional[int] = None
    status: str = "kept"
    source: str = ""
    reason: str = ""
    photo_ids: List[int] = []


class LibraryPatch(BaseModel):
    status: Optional[str] = None
    reason: Optional[str] = None
    later: bool = False
    rating: Optional[int] = None   # 0 clears it


class WearIn(BaseModel):
    worn_on: Optional[str] = None
    occasion: Optional[int] = None


def auto_name(items: list) -> str:
    """A readable default name from the main pieces, e.g. "White oxford shirt & Grey trousers"."""
    main = [i for i in items if i["category"] in ("dress", "suit")] or [i for i in items if i["category"] == "top"][:1]
    rest = [i for i in items if i["category"] == "bottom"]
    return " & ".join(i["name"] for i in (main + rest)[:2])[:80] or "Outfit"


def library_add(conn, ids, name="", notes="", occasion=None, status="kept", source="", reason="", photo_ids=()):
    """Add an outfit to the list, or update the one with exactly these pieces. Returns (id, existed)."""
    if status not in STATUSES:
        raise HTTPException(400, "Unknown status")
    ids = sorted(set(ids))
    check_items(conn, ids)
    check_occasion(occasion)
    want = frozenset(ids)
    row = None
    for r in conn.execute("SELECT id, status FROM saved_outfits").fetchall():
        have = {x["item_id"] for x in conn.execute("SELECT item_id FROM saved_outfit_items WHERE saved_id = ?", (r["id"],))}
        if have == want:
            row = r
            break
    if row:
        oid = row["id"]
        if status != "idea":  # an idea never overrides a decision you made
            conn.execute("UPDATE saved_outfits SET status = ?, reason = ?, updated_at = datetime('now') WHERE id = ?",
                         (status, reason.strip()[:300] if status == "rejected" else "", oid))
        if name.strip():
            conn.execute("UPDATE saved_outfits SET name = ? WHERE id = ? AND name = ''", (name.strip()[:80], oid))
    else:
        cur = conn.execute(
            "INSERT INTO saved_outfits (name, notes, occasion, status, source, reason) VALUES (?, ?, ?, ?, ?, ?)",
            (name.strip()[:80] or auto_name([get_item(conn, i) for i in ids]), notes.strip()[:1000], occasion,
             status, source[:20], reason.strip()[:300]))
        oid = cur.lastrowid
        conn.executemany("INSERT INTO saved_outfit_items (saved_id, item_id) VALUES (?, ?)", [(oid, i) for i in ids])
    for pid in list(photo_ids)[:20]:
        conn.execute("UPDATE outfit_photos SET saved_id = ? WHERE id = ? AND saved_id IS NULL AND outfit_id IS NULL",
                     (oid, pid))
    if status == "kept":
        link_logs(conn)
    return oid, bool(row)


def library_entry(conn, oid: int) -> dict:
    o = next((x for x in fetch_library(conn) if x["id"] == oid), None)
    if o is None:
        raise HTTPException(404, "Outfit not found")
    return o


@app.get("/api/library")
def list_library(status: Optional[str] = None):
    if status is not None and status not in STATUSES:
        raise HTTPException(400, "Unknown status")
    with db() as conn:
        return fetch_library(conn, status)


@app.post("/api/library")
def add_to_library(body: LibraryIn):
    with db() as conn:
        oid, existed = library_add(conn, body.item_ids, body.name, body.notes, body.occasion, body.status,
                                   body.source, body.reason, body.photo_ids)
        o = library_entry(conn, oid)
        o["existed"] = existed
        o["warnings"] = outfit_warnings(conn, o["items"], o["occasion"]) if body.status == "kept" else []
        return o


@app.put("/api/library/{oid}")
def edit_library(oid: int, body: LibraryIn):
    ids = sorted(set(body.item_ids))
    check_occasion(body.occasion)
    with db() as conn:
        library_entry(conn, oid)
        check_items(conn, ids)
        conn.execute("UPDATE saved_outfits SET name = ?, notes = ?, occasion = ? WHERE id = ?",
                     (body.name.strip()[:80], body.notes.strip()[:1000], body.occasion, oid))
        conn.execute("DELETE FROM saved_outfit_items WHERE saved_id = ?", (oid,))
        conn.executemany("INSERT INTO saved_outfit_items (saved_id, item_id) VALUES (?, ?)", [(oid, i) for i in ids])
        o = library_entry(conn, oid)
        o["warnings"] = outfit_warnings(conn, o["items"], o["occasion"])
        return o


@app.patch("/api/library/{oid}")
def patch_library(oid: int, body: LibraryPatch):
    with db() as conn:
        library_entry(conn, oid)
        if body.status is not None:
            if body.status not in STATUSES:
                raise HTTPException(400, "Unknown status")
            conn.execute("UPDATE saved_outfits SET status = ?, updated_at = datetime('now') WHERE id = ?", (body.status, oid))
            if body.status != "rejected":
                conn.execute("UPDATE saved_outfits SET reason = '' WHERE id = ?", (oid,))
            if body.status == "kept":
                link_logs(conn)
        if body.reason is not None:
            conn.execute("UPDATE saved_outfits SET reason = ? WHERE id = ?", (body.reason.strip()[:300], oid))
        if body.later:
            conn.execute("UPDATE saved_outfits SET updated_at = datetime('now', '+1 second') WHERE id = ?", (oid,))
        if body.rating is not None:
            if not 0 <= body.rating <= 5:
                raise HTTPException(400, "Rating must be 1-5")
            conn.execute("UPDATE saved_outfits SET rating = ? WHERE id = ?", (body.rating or None, oid))
        return library_entry(conn, oid)


@app.delete("/api/library/{oid}")
def delete_library(oid: int):
    with db() as conn:
        conn.execute("DELETE FROM saved_outfits WHERE id = ?", (oid,))
        conn.execute("UPDATE outfits SET library_id = NULL WHERE library_id = ?", (oid,))
        purge_outfit_photos(conn)
    return {"ok": True}


@app.post("/api/library/{oid}/wear")
def wear_library(oid: int, body: WearIn):
    with db() as conn:
        o = library_entry(conn, oid)
    occasion = body.occasion or o["occasion"]
    if occasion is None:
        forms = [i["formality"] for i in o["items"]]
        occasion = round(sum(forms) / len(forms)) if forms else 2
    return log_outfit(OutfitIn(item_ids=[i["id"] for i in o["items"]], worn_on=body.worn_on,
                               occasion=occasion, library_id=oid))


@app.post("/api/library/{oid}/photos")
def add_library_photo(oid: int, photo: UploadFile = File(...), cutout_photo: bool = Form(False)):
    return add_outfit_photo("saved_outfits", "saved_id", oid, photo, cutout_photo)


@app.get("/api/library/{oid}/swap")
def swap_options(oid: int, item_id: int):
    """Other pieces that could replace item_id in this outfit, with any rules they'd break."""
    with db() as conn:
        o = library_entry(conn, oid)
        current = next((i for i in o["items"] if i["id"] == item_id), None)
        if current is None:
            raise HTTPException(404, "That piece isn't in this outfit")
        rest = [i for i in o["items"] if i["id"] != item_id]
        in_outfit = {i["id"] for i in o["items"]}
        options = []
        for it in fetch_items(conn, "i.archived = 0 AND i.category = ?", (current["category"],)):
            if it["id"] in in_outfit:
                continue
            problems = outfit_warnings(conn, rest + [it], o["occasion"])
            options.append({"item": it, "ok": not problems, "problems": problems[:3]})
    options.sort(key=lambda x: (not x["ok"], x["item"]["in_laundry"], x["item"]["name"].lower()))
    return {"current": current, "options": options,
            "removable": current["category"] in ("outerwear", "suit", "socks", "accessory")}


@app.get("/api/saved")
def list_saved():
    with db() as conn:
        return fetch_saved(conn)


@app.post("/api/saved")
def save_outfit(body: SavedIn):
    ids = sorted(set(body.item_ids))
    check_occasion(body.occasion)
    with db() as conn:
        check_items(conn, ids)
        cur = conn.execute("INSERT INTO saved_outfits (name, notes, occasion, status) VALUES (?, ?, ?, 'kept')",
                           (body.name.strip()[:80], body.notes.strip()[:1000], body.occasion))
        conn.executemany("INSERT INTO saved_outfit_items (saved_id, item_id) VALUES (?, ?)",
                         [(cur.lastrowid, i) for i in ids])
        for pid in body.photo_ids[:20]:
            conn.execute("UPDATE outfit_photos SET saved_id = ? WHERE id = ? AND saved_id IS NULL AND outfit_id IS NULL",
                         (cur.lastrowid, pid))
        return {"id": cur.lastrowid}


@app.put("/api/saved/{saved_id}")
def update_saved(saved_id: int, body: SavedIn):
    ids = sorted(set(body.item_ids))
    check_occasion(body.occasion)
    with db() as conn:
        if not conn.execute("SELECT 1 FROM saved_outfits WHERE id = ?", (saved_id,)).fetchone():
            raise HTTPException(404, "Outfit not found")
        check_items(conn, ids)
        conn.execute("UPDATE saved_outfits SET name = ?, notes = ?, occasion = ? WHERE id = ?",
                     (body.name.strip()[:80], body.notes.strip()[:1000], body.occasion, saved_id))
        conn.execute("DELETE FROM saved_outfit_items WHERE saved_id = ?", (saved_id,))
        conn.executemany("INSERT INTO saved_outfit_items (saved_id, item_id) VALUES (?, ?)",
                         [(saved_id, i) for i in ids])
    return {"ok": True}


@app.delete("/api/saved/{saved_id}")
def delete_saved(saved_id: int):
    with db() as conn:
        conn.execute("DELETE FROM saved_outfits WHERE id = ?", (saved_id,))
        purge_outfit_photos(conn)
    return {"ok": True}


# ---------- discarded outfits ----------

def key_of(ids) -> str:
    return ",".join(str(i) for i in sorted(ids))


def discarded_keys(conn) -> set:
    rejected = {r["id"] for r in conn.execute("SELECT id FROM saved_outfits WHERE status = 'rejected'")}
    return {k for sid, k in clothes_keys(conn, "saved_outfit_items", "saved_id").items() if sid in rejected}


def fetch_discarded(conn):
    return fetch_library(conn, "rejected")


class DiscardIn(BaseModel):
    item_ids: List[int]
    reason: str = ""


class DiscardPatch(BaseModel):
    reason: str = ""


@app.get("/api/discarded")
def list_discarded():
    with db() as conn:
        return fetch_discarded(conn)


@app.post("/api/discarded")
def discard_outfit(body: DiscardIn):
    ids = sorted(set(body.item_ids))
    with db() as conn:
        check_items(conn, ids)
        if not recommender.history_key([get_item(conn, i) for i in ids]):
            raise HTTPException(400, "Nothing to discard")
        oid, _ = library_add(conn, ids, status="rejected", source="today", reason=body.reason)
        return {"id": oid}


@app.patch("/api/discarded/{discarded_id}")
def discard_reason(discarded_id: int, body: DiscardPatch):
    with db() as conn:
        conn.execute("UPDATE saved_outfits SET reason = ? WHERE id = ? AND status = 'rejected'",
                     (body.reason.strip()[:300], discarded_id))
    return {"ok": True}


@app.delete("/api/discarded/{discarded_id}")
def restore_discarded(discarded_id: int):
    with db() as conn:
        conn.execute("DELETE FROM saved_outfits WHERE id = ? AND status = 'rejected'", (discarded_id,))
        purge_outfit_photos(conn)
    return {"ok": True}


# ---------- outfit photos (your own pictures and AI try-ons) ----------

def photo_dict(r) -> dict:
    review = None
    if "review" in r.keys() and r["review"]:
        try:
            review = json.loads(r["review"])
        except ValueError:
            review = None
    return {"id": r["id"], "url": f"/photos/{r['file']}", "source": r["source"],
            "has_original": bool(r["original"]), "created_at": r["created_at"], "review": review}


def outfit_photos(conn, column: str, ids) -> dict:
    if not ids:
        return {}
    marks = ",".join("?" for _ in ids)
    out = {}
    for r in conn.execute(f"SELECT * FROM outfit_photos WHERE {column} IN ({marks}) ORDER BY id", list(ids)):
        out.setdefault(r[column], []).append(photo_dict(r))
    return out


def purge_outfit_photos(conn):
    """Delete photos whose outfit is gone, and unsaved try-ons older than a day."""
    rows = conn.execute("""SELECT id, file, original FROM outfit_photos
        WHERE (outfit_id IS NOT NULL AND outfit_id NOT IN (SELECT id FROM outfits))
           OR (saved_id IS NOT NULL AND saved_id NOT IN (SELECT id FROM saved_outfits))
           OR (outfit_id IS NULL AND saved_id IS NULL AND created_at < datetime('now', '-1 day'))""").fetchall()
    for r in rows:
        delete_photo(r["file"])
        delete_photo(r["original"])
        conn.execute("DELETE FROM outfit_photos WHERE id = ?", (r["id"],))


def add_outfit_photo(table: str, column: str, owner_id: int, photo: UploadFile, cutout_photo: bool):
    with db() as conn:
        if not conn.execute(f"SELECT 1 FROM {table} WHERE id = ?", (owner_id,)).fetchone():
            raise HTTPException(404, "Outfit not found")
    fields = {"photo": save_photo(photo, max_side=1600)}
    warning = apply_cutout(fields) if cutout_photo else None
    with db() as conn:
        cur = conn.execute(f"INSERT INTO outfit_photos ({column}, file, original, source) VALUES (?, ?, ?, 'own')",
                           (owner_id, fields["photo"], fields.get("photo_original")))
        row = conn.execute("SELECT * FROM outfit_photos WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {**photo_dict(row), "cutout_error": warning}


@app.post("/api/outfits/{outfit_id}/photos")
def add_logged_photo(outfit_id: int, photo: UploadFile = File(...), cutout_photo: bool = Form(False)):
    return add_outfit_photo("outfits", "outfit_id", outfit_id, photo, cutout_photo)


@app.post("/api/saved/{saved_id}/photos")
def add_saved_photo(saved_id: int, photo: UploadFile = File(...), cutout_photo: bool = Form(False)):
    return add_outfit_photo("saved_outfits", "saved_id", saved_id, photo, cutout_photo)


def get_outfit_photo(conn, photo_id: int):
    row = conn.execute("SELECT * FROM outfit_photos WHERE id = ?", (photo_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Photo not found")
    return row


@app.delete("/api/outfit-photos/{photo_id}")
def delete_outfit_photo(photo_id: int):
    with db() as conn:
        row = get_outfit_photo(conn, photo_id)
        conn.execute("DELETE FROM outfit_photos WHERE id = ?", (photo_id,))
    delete_photo(row["file"])
    delete_photo(row["original"])
    return {"ok": True}


@app.post("/api/outfit-photos/{photo_id}/cutout")
def cutout_outfit_photo(photo_id: int):
    with db() as conn:
        row = get_outfit_photo(conn, photo_id)
    source = row["original"] or row["file"]
    try:
        new = make_cutout(source)
    except cutout.CutoutError as e:
        raise HTTPException(400, str(e))
    with db() as conn:
        conn.execute("UPDATE outfit_photos SET file = ?, original = ? WHERE id = ?", (new, source, photo_id))
        row2 = get_outfit_photo(conn, photo_id)
    if row["original"]:
        delete_photo(row["file"])
    return photo_dict(row2)


@app.post("/api/outfit-photos/{photo_id}/restore")
def restore_outfit_photo(photo_id: int):
    with db() as conn:
        row = get_outfit_photo(conn, photo_id)
        if not row["original"]:
            raise HTTPException(400, "There's no original photo to go back to.")
        conn.execute("UPDATE outfit_photos SET file = original, original = NULL WHERE id = ?", (photo_id,))
        row2 = get_outfit_photo(conn, photo_id)
    delete_photo(row["file"])
    return photo_dict(row2)


class CheckIn(BaseModel):
    occasion: Optional[int] = None


@app.post("/api/outfit-photos/{photo_id}/check")
def check_outfit_photo(photo_id: int, body: Optional[CheckIn] = None):
    """A critical AI look at a photo of you wearing the outfit it belongs to."""
    require_ai()
    body = body or CheckIn()
    check_occasion(body.occasion)
    with db() as conn:
        row = get_outfit_photo(conn, photo_id)
        if row["source"] != "own":
            raise HTTPException(400, "Only your own photos can be checked.")
        settings = get_settings(conn)
        if row["saved_id"]:
            o = library_entry(conn, row["saved_id"])
            ids, occ = [i["id"] for i in o["items"]], o["occasion"]
        elif row["outfit_id"]:
            log = next((x for x in fetch_outfits(conn, 1000) if x["id"] == row["outfit_id"]), None)
            if log is None:
                raise HTTPException(404, "Outfit not found")
            ids, occ = [i["id"] for i in log["items"]], log["occasion"]
        else:
            raise HTTPException(400, "This photo doesn't belong to an outfit.")
        items = [get_item(conn, i) for i in ids]
        closet = fetch_items(conn, "i.archived = 0")
    occ = body.occasion or occ
    if not occ:
        forms = [i["formality"] for i in items if i["category"] not in ("accessory", "socks")]
        occ = round(sum(forms) / len(forms)) if forms else 2
    temp = today_temp(settings)
    photo = _read_photo(row["original"] or row["file"])
    if not photo:
        raise HTTPException(404, "Photo file is missing.")
    try:
        review = ai.check_look(photo, items, closet, occ, temp, rulebook.active(settings["rules"], occ, temp),
                               settings["menswear"], settings["ai_prompt"])
    except ai.AIError as e:
        raise HTTPException(502, str(e))
    review["checked_on"] = date.today().isoformat()
    with db() as conn:
        conn.execute("UPDATE outfit_photos SET review = ? WHERE id = ?", (json.dumps(review), photo_id))
        return photo_dict(get_outfit_photo(conn, photo_id))


# ---------- try-on: you wearing an outfit (OpenAI image model) ----------

@app.post("/api/tryon/photo/{which}")
def set_tryon_photo(which: str, photo: UploadFile = File(...)):
    if which not in ("body", "face"):
        raise HTTPException(404, "Unknown photo")
    name = save_photo(photo, max_side=1600)
    with db() as conn:
        old = raw_settings(conn)[f"tryon_{which}"]
        conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                     (f"tryon_{which}", name))
        out = get_settings(conn)
    delete_photo(old)
    return out


@app.delete("/api/tryon/photo/{which}")
def delete_tryon_photo(which: str):
    if which not in ("body", "face"):
        raise HTTPException(404, "Unknown photo")
    with db() as conn:
        old = raw_settings(conn)[f"tryon_{which}"]
        conn.execute("DELETE FROM settings WHERE key = ?", (f"tryon_{which}",))
        out = get_settings(conn)
    delete_photo(old)
    return out


class TryOnIn(BaseModel):
    item_ids: List[int]
    saved_id: Optional[int] = None


def _read_photo(name: str) -> Optional[bytes]:
    try:
        with open(os.path.join(PHOTO_DIR, os.path.basename(name)), "rb") as fh:
            return fh.read()
    except OSError:
        return None


@app.post("/api/tryon")
def try_on(body: TryOnIn):
    require_ai()
    ids = list(dict.fromkeys(body.item_ids))
    with db() as conn:
        s = raw_settings(conn)
        check_items(conn, ids)
        its = ordered([get_item(conn, i) for i in ids])
        if body.saved_id is not None and not conn.execute(
                "SELECT 1 FROM saved_outfits WHERE id = ?", (body.saved_id,)).fetchone():
            raise HTTPException(404, "Outfit not found")
    body_photo = _read_photo(s["tryon_body"]) if s["tryon_body"] else None
    if not body_photo:
        raise HTTPException(400, "Add a full-body photo of yourself in Settings → Try-on first.")
    face = _read_photo(s["tryon_face"]) if s["tryon_face"] else None
    pieces = []
    for it in its:
        photo = _read_photo(it["photo"]) if it.get("photo") else None
        pieces.append((it, photo))
    quality = s["tryon_quality"] if s["tryon_quality"] in TRYON_QUALITIES else "medium"
    try:
        image = ai.try_on(body_photo, face, pieces, quality)
    except ai.AIError as e:
        raise HTTPException(502, str(e))
    try:
        img = Image.open(io.BytesIO(image)).convert("RGB")
    except Exception:
        raise HTTPException(502, "The AI's picture couldn't be read. Try again.")
    name = f"{uuid.uuid4().hex}.jpg"
    img.save(os.path.join(PHOTO_DIR, name), "JPEG", quality=90)
    with db() as conn:
        cur = conn.execute("INSERT INTO outfit_photos (saved_id, file, source) VALUES (?, ?, 'tryon')",
                           (body.saved_id, name))
        row = conn.execute("SELECT * FROM outfit_photos WHERE id = ?", (cur.lastrowid,)).fetchone()
    return photo_dict(row)


# ---------- AI (optional, needs OPENAI_API_KEY) ----------

@app.get("/api/config")
def config():
    with db() as conn:
        saved = conn.execute("SELECT COUNT(*) FROM saved_outfits WHERE status = 'kept'").fetchone()[0]
        thrown = conn.execute("SELECT COUNT(*) FROM saved_outfits WHERE status = 'rejected'").fetchone()[0]
        ideas = conn.execute("SELECT COUNT(*) FROM saved_outfits WHERE status = 'idea'").fetchone()[0]
    return {"ai_enabled": ai.enabled(), "ai_model": ai.model(), "saved_count": saved, "discarded_count": thrown, "idea_count": ideas,
            "cutout_enabled": cutout.available(), "kinds": kinds.KINDS,
            "layer_kinds": sorted(kinds.LAYER_KINDS), "base_kinds": sorted(kinds.BASE_KINDS)}


class AITestIn(BaseModel):
    openai_key: str = ""
    ai_model: str = ""


@app.post("/api/ai/test")
def ai_test(body: AITestIn):
    """Check a key and model. Uses the typed key if given, otherwise the saved one."""
    try:
        name = ai.test_key(body.openai_key, body.ai_model)
    except ai.AIError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "model": name}


# ---------- add an item from a shop link ----------

class ImportIn(BaseModel):
    url: str


def _photo_preview(raw: bytes) -> Optional[str]:
    """Resize a downloaded product photo and return it as a data URL for the item form."""
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
        if img.mode != "RGB":
            rgba = img.convert("RGBA")
            img = Image.new("RGB", rgba.size, (255, 255, 255))
            img.paste(rgba, mask=rgba.split()[3])
        img.thumbnail((1200, 1200))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=85)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None


@app.post("/api/import-url")
def import_url(body: ImportIn):
    try:
        info = pages.read_product(body.url)
    except pages.PageError as e:
        raise HTTPException(400, str(e))
    photo = _photo_preview(info["image"]) if info["image"] else None
    fields = pages.guess_defaults(info["basic"])
    used_ai, ai_error = False, None
    if ai.enabled():
        try:
            described = ai.describe_page(info["page_text"], info["image"] if photo else None)
            # the AI saw the page facts too; only fill gaps it left from them
            fields = {**described, **{k: v for k, v in info["basic"].items() if v and not described.get(k)}}
            used_ai = True
        except ai.AIError as e:
            ai_error = str(e)
    return {"fields": fields, "photo": photo, "used_ai": used_ai, "ai_error": ai_error}


def require_ai():
    if not ai.enabled():
        raise HTTPException(400, "AI is not set up. Add an OpenAI API key in Settings.")


class NameIn(BaseModel):
    item_ids: List[int]
    occasion: Optional[int] = None
    notes: str = ""


@app.post("/api/ai/name")
def ai_name(body: NameIn):
    """Three name ideas for an outfit you put together."""
    require_ai()
    ids = list(dict.fromkeys(body.item_ids))
    with db() as conn:
        check_items(conn, ids)
        items = [get_item(conn, i) for i in ids]
        taken = [r["name"] for r in conn.execute("SELECT name FROM saved_outfits WHERE name <> '' ORDER BY id DESC LIMIT 60")]
    try:
        return {"names": ai.suggest_names(items, body.occasion, body.notes, taken)}
    except ai.AIError as e:
        raise HTTPException(502, str(e))


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
OUTFIT_LIMITS = {"top": 2, "bottom": 1, "dress": 1, "suit": 1, "outerwear": 1, "shoes": 1, "socks": 1, "accessory": 2}


def check_outfit(ids, allowed: dict, anchor_id=None, rules=None, classic=None):
    """Keep only known, clean items; return the item list or None if it isn't a full outfit
    or breaks a ground rule or a suit that must be worn together."""
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
    ids_in = {i["id"] for i in picked}
    if anchor_id is not None and anchor_id not in ids_in:
        return None
    if any(i.get("pair_only") and i.get("match_id") not in ids_in for i in picked):
        return None
    if rules and rulebook.broken(picked, rules):
        return None
    if classic is not None and menswear.broken(picked, *classic):
        return None
    return ordered(picked)


def today_temp(settings) -> Optional[float]:
    if settings["lat"] is None or settings["lon"] is None:
        return None
    try:
        return weather.forecast(settings["lat"], settings["lon"])["days"][0]["effective"]
    except Exception:
        return None


class AIOutfitsIn(BaseModel):
    anchor_id: Optional[int] = None
    note: str = ""


@app.post("/api/ai/outfits")
def ai_outfits(body: AIOutfitsIn):
    require_ai()
    with db() as conn:
        settings = get_settings(conn)
        items = fetch_items(conn, "i.archived = 0")
        history = outfit_history(conn, 60)
        discarded = fetch_discarded(conn)[:40]
        existing = [
            [r["item_id"] for r in conn.execute(
                "SELECT item_id FROM saved_outfit_items WHERE saved_id = ? ORDER BY item_id", (s["id"],))]
            for s in conn.execute("SELECT id FROM saved_outfits WHERE status <> 'rejected' "
                                  "ORDER BY id DESC LIMIT 60").fetchall()
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
    temp = today_temp(settings)
    try:
        raw = ai.build_outfits(list(allowed.values()), count, anchor, body.note, existing,
                              settings["ai_prompt"], rules=settings["rules"], history=history, temp=temp,
                              classic=settings["menswear"],
                              discarded=[{"item_ids": [i["id"] for i in d["items"]], "reason": d["reason"]}
                                         for d in discarded])
    except ai.AIError as e:
        raise HTTPException(502, str(e))

    seen = {frozenset(ids) for ids in existing}
    thrown = {recommender.history_key(d["items"]) for d in discarded}
    outfits = []
    for o in raw:
        occasion = o.get("occasion") if o.get("occasion") in (1, 2, 3) else 2
        its = check_outfit(o.get("item_ids") or [], allowed, anchor["id"] if anchor else None,
                           rulebook.active(settings["rules"], occasion, temp),
                           (occasion, temp) if settings["menswear"] else None)
        if not its or recommender.history_key(its) in thrown:
            continue
        key = frozenset(i["id"] for i in its)
        if key in seen:
            continue
        seen.add(key)
        outfits.append({"name": str(o.get("name") or "").strip()[:80],
                        "reason": str(o.get("reason") or "").strip()[:300],
                        "occasion": occasion, "items": its})
        if len(outfits) >= count:
            break
    if not outfits:
        raise HTTPException(502, "The AI's outfits didn't match your closet or your rules. Try again.")
    # they go into the list as ideas to review
    with db() as conn:
        for o in outfits:
            oid, _ = library_add(conn, [i["id"] for i in o["items"]], o["name"], o["reason"], o["occasion"],
                                 "idea", "ai")
            o["id"] = oid
        listed = {x["id"]: x for x in fetch_library(conn)}
    for o in outfits:
        o["status"] = listed[o["id"]]["status"] if o["id"] in listed else "idea"
    return {"outfits": outfits}


# ---------- settings ----------

class SettingsIn(BaseModel):
    unit: Optional[str] = None
    location_name: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    outerwear_below: Optional[float] = None
    ai_prompt: Optional[str] = None
    openai_key: Optional[str] = None    # "" removes the saved key
    ai_model: Optional[str] = None      # "" = default
    rules: Optional[list] = None
    menswear: Optional[bool] = None
    tryon_quality: Optional[str] = None


@app.get("/api/settings")
def read_settings():
    with db() as conn:
        return get_settings(conn)


@app.put("/api/settings")
def write_settings(body: SettingsIn):
    data = body.model_dump(exclude_unset=True)
    if "unit" in data and data["unit"] not in ("C", "F"):
        raise HTTPException(400, "Unit must be C or F")
    for k, limit in (("ai_prompt", 1000), ("openai_key", 300), ("ai_model", 80)):
        if data.get(k) is not None:
            data[k] = data[k].strip()[:limit]
    if "rules" in data:
        data["rules"] = json.dumps(rulebook.normalize(data["rules"]))
    if "menswear" in data:
        data["menswear"] = "0" if data["menswear"] is False else "1"
    if "tryon_quality" in data and data["tryon_quality"] not in TRYON_QUALITIES:
        raise HTTPException(400, "Quality must be low, medium or high")
    with db() as conn:
        for k, v in data.items():
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                         (k, "" if v is None else str(v)))
        load_ai_config(conn)
        return get_settings(conn)


@app.get("/api/geocode")
def geocode(q: str):
    if len(q.strip()) < 2:
        return []
    try:
        return weather.geocode(q.strip())
    except Exception:
        raise HTTPException(502, "Location search is unavailable right now")


with db() as _conn:  # leftovers from deleted outfits and unsaved try-ons
    purge_outfit_photos(_conn)


# ---------- static files (keep last) ----------

app.mount("/photos", StaticFiles(directory=PHOTO_DIR), name="photos")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
