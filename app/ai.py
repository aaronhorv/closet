"""Optional OpenAI helpers: fill in item details from a photo or shop page, and build outfits.

Active when an OpenAI key is set, either in Settings (stored in the database) or
with the OPENAI_API_KEY environment variable. Everything else works without it.
"""
import base64
import io
import json
import os

from PIL import Image

from .recommender import CATEGORIES

ENV_KEY = os.environ.get("OPENAI_API_KEY", "")
ENV_MODEL = os.environ.get("AI_MODEL", "")
DEFAULT_MODEL = "gpt-6.1-terra"
MODELS = ["gpt-6.1-terra", "gpt-6-luna", "gpt-6.1-sol"]

PATTERNS = ["solid", "striped", "checked", "floral", "print", "other"]
FITS = ["slim", "regular", "relaxed"]

# Values saved in Settings; they win over the environment variables.
_settings_key = ""
_settings_model = ""
_clients: dict = {}


class AIError(Exception):
    """A short, user-facing message about why the AI call failed."""


def set_config(key: str, model: str):
    global _settings_key, _settings_model
    _settings_key = (key or "").strip()
    _settings_model = (model or "").strip()


def api_key() -> str:
    return _settings_key or ENV_KEY


def key_source() -> str:
    return "settings" if _settings_key else ("env" if ENV_KEY else "")


def model() -> str:
    return _settings_model or ENV_MODEL or DEFAULT_MODEL


def enabled() -> bool:
    return bool(api_key())


def _get_client(key: str = None):
    key = key or api_key()
    if key not in _clients:
        from openai import OpenAI
        _clients.clear()  # only keep the client for the current key
        _clients[key] = OpenAI(api_key=key, timeout=60, max_retries=1)
    return _clients[key]


def _friendly(e) -> AIError:
    import openai

    if isinstance(e, openai.AuthenticationError):
        return AIError("OpenAI rejected the API key.")
    if isinstance(e, openai.PermissionDeniedError):
        return AIError("This API key isn't allowed to use that model.")
    if isinstance(e, openai.NotFoundError):
        return AIError(f"OpenAI doesn't know the model “{model()}”. Check the model name in Settings.")
    if isinstance(e, openai.RateLimitError):
        return AIError("OpenAI rate limit or quota reached. Try again later.")
    if isinstance(e, openai.APITimeoutError):
        return AIError("OpenAI took too long to answer. Try again.")
    if isinstance(e, openai.APIConnectionError):
        return AIError("Couldn't reach OpenAI. Check the server's internet connection.")
    if isinstance(e, openai.APIStatusError):
        return AIError(f"OpenAI returned an error ({e.status_code}).")
    return AIError("The AI request failed.")


def test_key(key: str = "", model_name: str = "") -> str:
    """Check a key (and model) without spending tokens. Returns the model name."""
    import openai

    key = (key or "").strip() or api_key()
    name = (model_name or "").strip() or model()
    if not key:
        raise AIError("Enter an API key first.")
    try:
        _get_client(key).models.retrieve(name)
    except openai.NotFoundError:
        raise AIError(f"The key works, but OpenAI doesn't know the model “{name}”.")
    except openai.OpenAIError as e:
        raise _friendly(e)
    return name


def _call(instructions: str, content: list, schema: dict, name: str) -> dict:
    """Run one Responses API call with a strict JSON schema and return the parsed JSON."""
    import openai

    if not enabled():
        raise AIError("AI is not set up. Add an OpenAI API key in Settings.")
    try:
        resp = _get_client().responses.create(
            model=model(),
            instructions=instructions,
            input=[{"role": "user", "content": content}],
            text={"format": {"type": "json_schema", "name": name, "schema": schema, "strict": True}},
            store=False,
        )
    except openai.OpenAIError as e:
        raise _friendly(e)

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


# ---------- fill in an item from a photo or a shop page ----------

DESCRIBE_SCHEMA = {
    "type": "object",
    "properties": {
        "is_clothing": {"type": "boolean"},
        "name": {"type": "string"},
        "category": {"type": "string", "enum": CATEGORIES},
        "color": {"type": "string"},
        "color2": {"type": "string"},
        "pattern": {"type": "string", "enum": PATTERNS},
        "material": {"type": "string"},
        "fit": {"type": "string", "enum": FITS + [""]},
        "brand": {"type": "string"},
        "warmth": {"type": "integer", "enum": [1, 2, 3, 4, 5]},
        "formality": {"type": "integer", "enum": [1, 2, 3]},
        "tags": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["is_clothing", "name", "category", "color", "color2", "pattern", "material", "fit",
                 "brand", "warmth", "formality", "tags"],
    "additionalProperties": False,
}

DESCRIBE_INSTRUCTIONS = """You catalog clothes for a personal closet app. Describe the main clothing item shown.
- is_clothing: false if it isn't a clothing item, shoes or accessory.
- name: short and specific, 2-5 words, e.g. "Navy oxford shirt", "Black leather Chelsea boots". No brand in the name.
- category: top (shirts, t-shirts, sweaters, hoodies), bottom (trousers, jeans, shorts, skirts), dress (dresses, jumpsuits), outerwear (jackets, coats, blazers), shoes, accessory (bags, belts, hats, scarves, jewelry).
- color: the main color as one or two plain words, lower case (e.g. "navy", "light blue", "olive").
- color2: a clearly visible second color (e.g. the stripes or a contrasting trim), lower case, or "" if there isn't one.
- pattern: solid, striped, checked (incl. plaid, gingham, houndstooth), floral, print (graphic, logo, animal, abstract), or other.
- material: the main fabric in 1-3 plain lower-case words, e.g. "cotton", "wool", "linen", "denim", "leather", "suede", "polyester". If unsure, give your best guess from the texture.
- fit: slim, regular or relaxed (relaxed includes oversized and wide-leg). "" for shoes and accessories.
- brand: only if clearly visible or stated, otherwise "".
- warmth: 1 very light (linen, tank top), 2 light (t-shirt), 3 medium (shirt, jeans), 4 warm (wool sweater), 5 very warm (down coat).
- formality: 1 casual, 2 smart casual, 3 formal.
- tags: 0-4 short lower-case tags that help pick outfits, e.g. season, "waterproof", "work", "gym". No color, material or category words."""


def _photo_data_url(raw: bytes) -> str:
    img = Image.open(io.BytesIO(raw))
    img = img.convert("RGB")
    img.thumbnail((1024, 1024))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _clean_description(data: dict) -> dict:
    if not data.get("is_clothing"):
        raise AIError("That doesn't look like a clothing item.")
    category = data.get("category")
    tags = [str(t).strip().lower() for t in data.get("tags") or [] if str(t).strip()]
    pattern = data.get("pattern")
    fit = data.get("fit")
    return {
        "name": str(data.get("name") or "").strip()[:120],
        "category": category if category in CATEGORIES else "top",
        "color": str(data.get("color") or "").strip().lower()[:40],
        "color2": str(data.get("color2") or "").strip().lower()[:40],
        "pattern": pattern if pattern in PATTERNS else "",
        "material": str(data.get("material") or "").strip().lower()[:60],
        "fit": fit if fit in FITS else "",
        "brand": str(data.get("brand") or "").strip()[:80],
        "warmth": min(5, max(1, int(data.get("warmth") or 3))),
        "formality": min(3, max(1, int(data.get("formality") or 2))),
        "tags": ", ".join(dict.fromkeys(tags))[:200],
    }


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
    return _clean_description(data)


def describe_page(page_text: str, photo: bytes = None) -> dict:
    """Describe a product from a shop page's text (and its main photo, if we have one)."""
    content = [{"type": "input_text", "text":
                "Describe the product sold on this shop page. Facts stated on the page (brand, material, "
                "color) win over what the photo suggests.\n\n" + page_text[:6000]}]
    if photo:
        try:
            content.append({"type": "input_image", "image_url": _photo_data_url(photo)})
        except Exception:
            pass
    return _clean_description(_call(DESCRIBE_INSTRUCTIONS, content, DESCRIBE_SCHEMA, "closet_item"))


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
- Patterns: usually at most one patterned piece; pair it with solids.
- Balance fits: a relaxed piece usually goes with a slimmer one. Mix textures/materials sensibly (e.g. no linen with heavy wool).
- Make the outfits clearly different from each other and from the user's existing saved outfits.
- Favor well-rated and favorite pieces, but also bring in pieces that are rarely worn.
- name: 2-4 words, e.g. "Easy Friday", "Rainy commute".
- reason: one short sentence (max 20 words) on why it works."""

ITEM_DETAIL_KEYS = ("brand", "color2", "pattern", "material", "fit", "tags")


def _item_line(it: dict) -> str:
    slim = {
        "id": it["id"], "name": it["name"], "category": it["category"], "color": it["color"],
        "warmth": it["warmth"], "formality": it["formality"],
    }
    for k in ITEM_DETAIL_KEYS:
        if it.get(k):
            slim[k] = it[k]
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
