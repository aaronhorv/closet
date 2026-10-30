"""Optional OpenAI helpers: fill in item details from a photo, and build outfits.

Only active when OPENAI_API_KEY is set. Everything else in the app works without it.
"""
import base64
import io
import json
import os

from PIL import Image

from .recommender import CATEGORIES

API_KEY = os.environ.get("OPENAI_API_KEY", "")
MODEL = os.environ.get("AI_MODEL", "") or "gpt-6.1-terra"

_client = None


class AIError(Exception):
    """A short, user-facing message about why the AI call failed."""


def enabled() -> bool:
    return bool(API_KEY)


def _get_client():
    global _client
    if _client is None:
        from openai import OpenAI
        _client = OpenAI(api_key=API_KEY, timeout=60, max_retries=1)
    return _client


def _call(instructions: str, content: list, schema: dict, name: str) -> dict:
    """Run one Responses API call with a strict JSON schema and return the parsed JSON."""
    import openai

    if not enabled():
        raise AIError("AI is not set up. Add OPENAI_API_KEY to enable it.")
    try:
        resp = _get_client().responses.create(
            model=MODEL,
            instructions=instructions,
            input=[{"role": "user", "content": content}],
            text={"format": {"type": "json_schema", "name": name, "schema": schema, "strict": True}},
            store=False,
        )
    except openai.AuthenticationError:
        raise AIError("OpenAI rejected the API key.")
    except openai.RateLimitError:
        raise AIError("OpenAI rate limit or quota reached. Try again later.")
    except openai.APITimeoutError:
        raise AIError("OpenAI took too long to answer. Try again.")
    except openai.APIConnectionError:
        raise AIError("Couldn't reach OpenAI. Check the server's internet connection.")
    except openai.APIStatusError as e:
        raise AIError(f"OpenAI returned an error ({e.status_code}).")

    for out in resp.output or []:
        if getattr(out, "type", None) != "message":
            continue
        for part in out.content or []:
            if getattr(part, "type", None) == "refusal":
                raise AIError("The AI declined this request.")
    try:
        return json.loads(resp.output_text)
    except (TypeError, ValueError):
        raise AIError("The AI gave an answer the app couldn't read. Try again.")


# ---------- fill in an item from a photo ----------

DESCRIBE_SCHEMA = {
    "type": "object",
    "properties": {
        "is_clothing": {"type": "boolean"},
        "name": {"type": "string"},
        "category": {"type": "string", "enum": CATEGORIES},
        "color": {"type": "string"},
        "warmth": {"type": "integer", "enum": [1, 2, 3, 4, 5]},
        "formality": {"type": "integer", "enum": [1, 2, 3]},
        "tags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["is_clothing", "name", "category", "color", "warmth", "formality", "tags"],
    "additionalProperties": False,
}

DESCRIBE_INSTRUCTIONS = """You catalog clothes for a personal closet app. Look at the photo and describe the main clothing item.
- is_clothing: false if the photo doesn't show a clothing item, shoes or accessory.
- name: short and specific, 2-5 words, e.g. "Navy oxford shirt", "Black leather Chelsea boots".
- category: top (shirts, t-shirts, sweaters, hoodies), bottom (trousers, jeans, shorts, skirts), dress (dresses, jumpsuits), outerwear (jackets, coats, blazers), shoes, accessory (bags, belts, hats, scarves, jewelry).
- color: the main color as one or two plain words, lower case (e.g. "navy", "light blue", "olive"). Use "patterned" for prints, stripes or checks.
- warmth: 1 very light (linen, tank top), 2 light (t-shirt), 3 medium (shirt, jeans), 4 warm (wool sweater), 5 very warm (down coat).
- formality: 1 casual, 2 smart casual, 3 formal.
- tags: 0-4 short lower-case tags that help pick outfits, e.g. material, season, "waterproof", "work". No color or category words."""


def _photo_data_url(raw: bytes) -> str:
    img = Image.open(io.BytesIO(raw))
    img = img.convert("RGB")
    img.thumbnail((1024, 1024))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def describe_photo(raw: bytes) -> dict:
    try:
        url = _photo_data_url(raw)
    except Exception:
        raise AIError("Couldn't read that image. Try a JPEG or PNG.")
    data = _call(
        DESCRIBE_INSTRUCTIONS,
        [{"type": "input_text", "text": "Describe this item."},
         {"type": "input_image", "image_url": url}],
        DESCRIBE_SCHEMA, "closet_item",
    )
    if not data.get("is_clothing"):
        raise AIError("That doesn't look like a clothing item.")
    category = data.get("category")
    tags = [str(t).strip().lower() for t in data.get("tags") or [] if str(t).strip()]
    return {
        "name": str(data.get("name") or "").strip()[:120],
        "category": category if category in CATEGORIES else "top",
        "color": str(data.get("color") or "").strip().lower()[:40],
        "warmth": min(5, max(1, int(data.get("warmth") or 3))),
        "formality": min(3, max(1, int(data.get("formality") or 2))),
        "tags": ", ".join(dict.fromkeys(tags))[:200],
    }


# ---------- build outfits from the closet ----------

OUTFITS_SCHEMA = {
    "type": "object",
    "properties": {
        "outfits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "item_ids": {"type": "array", "items": {"type": "integer"}},
                    "reason": {"type": "string"},
                },
                "required": ["name", "item_ids", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["outfits"],
    "additionalProperties": False,
}

OUTFITS_INSTRUCTIONS = """You are a practical personal stylist. Put together outfits using ONLY items from the user's closet list (JSON, one item per line). Refer to items by their id.
Rules for every outfit:
- Either one dress, or at least one top plus one bottom. Two tops are fine when they layer (e.g. shirt under a sweater).
- Add shoes when the closet has any. Outerwear and one accessory are optional.
- Keep formality consistent (1 casual, 2 smart casual, 3 formal) and warmth roughly consistent (1 very light .. 5 very warm).
- Colors: neutrals go with anything; prefer at most one bold accent color per outfit.
- Make the outfits clearly different from each other and from the user's existing saved outfits.
- Favor well-rated and favorite pieces, but also bring in pieces that are rarely worn.
- name: 2-4 words, e.g. "Easy Friday", "Rainy commute".
- reason: one short sentence (max 20 words) on why it works."""


def _item_line(it: dict) -> str:
    slim = {
        "id": it["id"], "name": it["name"], "category": it["category"], "color": it["color"],
        "warmth": it["warmth"], "formality": it["formality"],
    }
    if it.get("brand"):
        slim["brand"] = it["brand"]
    if it.get("tags"):
        slim["tags"] = it["tags"]
    if it.get("notes"):
        slim["notes"] = it["notes"][:120]
    if it.get("favorite"):
        slim["favorite"] = True
    slim["times_worn"] = it.get("times_worn") or 0
    if it.get("last_worn"):
        slim["last_worn"] = it["last_worn"]
    if it.get("avg_rating") is not None:
        slim["avg_rating"] = it["avg_rating"]
    return json.dumps(slim, ensure_ascii=False)


def build_outfits(items: list, count: int, anchor: dict = None, note: str = "",
                  existing: list = None, style: str = "") -> list:
    """Ask the AI for outfits. Returns raw [{name, item_ids, reason}]; the caller validates."""
    parts = ["Closet:", *(_item_line(i) for i in items)]
    if existing:
        parts.append("\nExisting saved outfits (item ids), don't repeat these:")
        parts.extend(json.dumps(ids) for ids in existing[:30])
    if anchor:
        parts.append(f"\nEvery outfit must include item {anchor['id']} ({anchor['name']}).")
    if style.strip():
        parts.append(f"\nThe user's standing style preferences (follow them unless they break the rules above):\n{style.strip()[:1000]}")
    if note.strip():
        parts.append(f"\nWhat the user wants: {note.strip()[:300]}")
    parts.append(f"\nCreate {count} outfits.")
    data = _call(OUTFITS_INSTRUCTIONS, [{"type": "input_text", "text": "\n".join(parts)}],
                 OUTFITS_SCHEMA, "outfits")
    return data.get("outfits") or []
