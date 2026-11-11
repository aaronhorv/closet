"""Optional OpenAI helpers: fill in item details from a photo or shop page, and build outfits.

Active when an OpenAI key is set, either in Settings (stored in the database) or
with the OPENAI_API_KEY environment variable. Everything else works without it.
"""
import base64
import io
import json
import os

from PIL import Image

from . import menswear
from . import rules as rulebook
from .kinds import ALL_KINDS, CATEGORIES, clean_kind, guess_kind

ENV_KEY = os.environ.get("OPENAI_API_KEY", "")
ENV_MODEL = os.environ.get("AI_MODEL", "")
DEFAULT_MODEL = "gpt-6.1-terra"
MODELS = ["gpt-6.1-terra", "gpt-6-luna", "gpt-6.1-sol"]
TRYON_MODEL = os.environ.get("TRYON_MODEL", "gpt-image-2.5-sunburst")

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
    if isinstance(e, openai.BadRequestError) and "moderation" in str(e).lower():
        return AIError("OpenAI's safety filter refused this picture. Try a different photo of yourself.")
    if isinstance(e, openai.RateLimitError):
        return AIError("OpenAI rate limit or quota reached. Try again later.")
    if isinstance(e, openai.APITimeoutError):
        return AIError("OpenAI took too long to answer. Try again.")
    if isinstance(e, openai.APIConnectionError):
        return AIError("Couldn't reach OpenAI. Check the server's internet connection.")
    if isinstance(e, openai.APIStatusError):
        detail = ""
        body = getattr(e, "body", None)
        if isinstance(body, dict):
            detail = str((body.get("error") or body).get("message") or "")
        detail = (detail or getattr(e, "message", "") or "").strip()
        return AIError(f"OpenAI returned an error ({e.status_code})" + (f": {detail[:300]}" if detail else "."))
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
        "kind": {"type": "string", "enum": ALL_KINDS + [""]},
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
    "required": ["is_clothing", "name", "category", "kind", "color", "color2", "pattern", "material", "fit",
                 "brand", "warmth", "formality", "tags"],
    "additionalProperties": False,
}

DESCRIBE_INSTRUCTIONS = """You catalog clothes for a personal closet app. Describe the main clothing item shown.
- is_clothing: false if it isn't a clothing item, shoes or accessory.
- name: short and specific, 2-5 words, e.g. "Navy oxford shirt", "Black leather Chelsea boots". No brand in the name.
- category: top (shirts, t-shirts, sweaters, hoodies), bottom (trousers, jeans, shorts, skirts), dress (dresses, jumpsuits), suit (blazers, suit jackets, waistcoats), outerwear (coats, jackets, parkas), shoes, socks, accessory (bags, belts, hats, scarves, ties, jewelry).
- kind: the type within the category. top: t-shirt, shirt, polo, turtleneck, blouse, tank top, sweater, cardigan, sweatshirt, hoodie. bottom: jeans, chinos, trousers, suit trousers, shorts, skirt, joggers. dress: dress, jumpsuit. suit: suit jacket, blazer, waistcoat. outerwear: coat, jacket, parka, raincoat, overshirt, gilet. shoes: sneakers, formal shoes (oxfords, derbies, brogues, heels), loafers, boots, sandals. socks: dress socks (thin, plain, for work and suits), casual socks, sport socks, no-show socks. accessory: belt, tie, pocket square, scarf, hat, bag, watch, jewelry, gloves. "" if none fits.
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
    if img.mode in ("RGBA", "LA", "P"):
        # cut-out photos are transparent; put them on white so the item stays visible
        rgba = img.convert("RGBA")
        img = Image.new("RGB", rgba.size, (255, 255, 255))
        img.paste(rgba, mask=rgba.split()[3])
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
        "kind": (clean_kind(data.get("kind"), category if category in CATEGORIES else "top")
                 or guess_kind(str(data.get("name") or ""), category if category in CATEGORIES else "top")),
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
                    "occasion": {"type": "integer", "enum": [1, 2, 3]},
                    "reason": {"type": "string"},
                },
                "required": ["name", "item_ids", "occasion", "reason"],
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
- "kind" is the type of each piece (shirt, sweater, formal shoes...).
- Category "suit" is tailoring (blazers, suit jackets) worn over a top; a coat can go over it. At most one per outfit.
- Suits: items with "suit_partner" belong together. Worn together they are formal. The jacket alone is one step less formal (fine for smart casual with chinos or jeans). An item with "only_with_partner" must be worn with its partner.
- occasion: what the outfit is for: 1 casual (everyday), 2 smart casual (work), 3 formal (elegant).
- The user's ground rules are strict: never break them.
- Learn from the user's past outfits: repeat what they rated highly, avoid what they rated low, and follow their notes (on items and outfits).
- Add shoes when the closet has any.
- The outfits are not for today's weather: follow the occasion and season the user asks for (e.g. a summer wedding gets no coat). Only add outerwear when the request or season calls for it.
- Socks and accessories in the closet are statement pieces. Plain neutral socks and basic accessories (a belt matching the shoes, a plain watch) are always available and must NOT be listed. Only include a catalogued sock or accessory when it genuinely improves the outfit (a pocket square with a jacket, a tie for a formal look, a scarf in the cold, patterned socks as the single playful touch of a calm casual or smart-casual look); otherwise leave them out.
- Keep formality consistent (1 casual, 2 smart casual, 3 formal) and warmth roughly consistent (1 very light .. 5 very warm).
- Colors: neutrals go with anything; prefer at most one bold accent color per outfit.
- Patterns: usually at most one patterned piece; pair it with solids.
- Balance fits: a relaxed piece usually goes with a slimmer one. Mix textures/materials sensibly (e.g. no linen with heavy wool).
- Make the outfits clearly different from each other and from the user's existing saved outfits.
- Favor well-rated and favorite pieces, but also bring in pieces that are rarely worn.
- name: 2-4 words, e.g. "Easy Friday", "Rainy commute".
- reason: one short sentence (max 20 words) on why it works."""

ITEM_DETAIL_KEYS = ("kind", "brand", "color2", "pattern", "material", "fit", "tags")


def _item_line(it: dict) -> str:
    slim = {
        "id": it["id"], "name": it["name"], "category": it["category"], "color": it["color"],
        "warmth": it["warmth"], "formality": it["formality"],
    }
    for k in ITEM_DETAIL_KEYS:
        if it.get(k):
            slim[k] = it[k]
    if it.get("match_id"):
        slim["suit_partner"] = it["match_id"]
        if it.get("pair_only"):
            slim["only_with_partner"] = True
    if it.get("notes"):
        slim["notes"] = it["notes"][:400]
    if it.get("favorite"):
        slim["favorite"] = True
    slim["times_worn"] = it.get("times_worn") or 0
    if it.get("last_worn"):
        slim["last_worn"] = it["last_worn"]
    if it.get("avg_rating") is not None:
        slim["avg_rating"] = it["avg_rating"]
    return json.dumps(slim, ensure_ascii=False)


MENSWEAR_GUIDE = """Classic menswear guide (follow it; the user's own rules come first):
- Proportions: slim with slim or a relaxed piece balanced by a slimmer one; trousers should suit the jacket's cut.
- Fabric weight: match weights (no linen trousers with a flannel jacket); smooth fabrics are dressier than textured ones.
- Formality mixes one step at most: blazer with chinos or dark jeans is fine; a suit jacket with jeans is not ideal.
- A blazer or sport coat is made to be worn separately; a suit jacket looks best with its own trousers.
- Colors: build on neutrals (navy, grey, white, light blue, brown, beige); one accent color; darker on the bottom for formal looks.
- Shoes: darker shoes are dressier; brown goes with navy, grey, beige and green; black with charcoal, black and navy for formal.
- Socks: plain socks matching the trousers are assumed; a catalogued (statement) sock only as the single playful piece in casual or smart-casual looks."""


def build_outfits(items: list, count: int, anchor: dict = None, note: str = "",
                  existing: list = None, style: str = "", rules: list = None, history: list = None,
                  temp: float = None, classic: bool = True, discarded: list = None) -> list:
    """Ask the AI for outfits. Returns raw [{name, item_ids, occasion, reason}]; the caller validates."""
    parts = ["Closet:", *(_item_line(i) for i in items)]
    known = {i["id"] for i in items}
    past = []
    for h in history or []:
        ids = [i for i in h["items"] if i in known]
        if not ids:
            continue
        entry = {"item_ids": ids}
        if h.get("rating"):
            entry["rating"] = h["rating"]
        if h.get("notes"):
            entry["note"] = h["notes"][:300]
        past.append(json.dumps(entry, ensure_ascii=False))
    if past:
        parts.append("\nPast outfits with the user's rating (1-5 stars) and notes:")
        parts.extend(past[:40])
    if discarded:
        parts.append("\nOutfits the user rejected (never suggest these combinations; learn from the reasons):")
        for d in discarded[:40]:
            entry = {"item_ids": [i for i in d["item_ids"] if i in known]}
            if d.get("reason"):
                entry["reason"] = d["reason"][:200]
            if entry["item_ids"]:
                parts.append(json.dumps(entry, ensure_ascii=False))
    if classic:
        parts.append("\nClassic menswear rules (strict):")
        parts.extend(f"- {r}" for r in menswear.SUMMARY)
        parts.append(MENSWEAR_GUIDE)
    if rules:
        parts.append("\nThe user's ground rules (strict):")
        parts.extend(f"- {rulebook.describe(r)}" for r in rules)
    if temp is not None:
        parts.append(f"\nToday it feels like {round(temp)}°C.")
    if existing:
        parts.append("\nExisting saved outfits (item ids), don't repeat these:")
        parts.extend(json.dumps(ids) for ids in existing[:30])
    if anchor:
        parts.append(f"\nEvery outfit must include item {anchor['id']} ({anchor['name']}) and be built around it. "
                     "This overrides the guidance that socks and accessories are optional.")
        if anchor.get("kind") == "pocket square":
            parts.append("A pocket square needs a blazer or suit jacket in the outfit.")
        elif anchor.get("kind") == "tie":
            parts.append("A tie needs a collared shirt, ideally with a jacket.")
    if style.strip():
        parts.append(f"\nThe user's standing style preferences (follow them unless they break the rules above):\n{style.strip()[:1000]}")
    if note.strip():
        parts.append(f"\nWhat the user wants: {note.strip()[:300]}")
    parts.append(f"\nCreate {count} outfits.")
    data = _call(OUTFITS_INSTRUCTIONS, [{"type": "input_text", "text": "\n".join(parts)}],
                 OUTFITS_SCHEMA, "outfits")
    return data.get("outfits") or []


# ---------- try-on: the user wearing an outfit ----------

TRYON_PROMPT = """Create a realistic full-length photo of the person in image 1 wearing exactly the outfit listed below.
- Keep the person's face, hair, skin tone, body shape and height exactly as in image 1{face_note}.
- Dress them in these pieces only, true to the reference images: same colors, patterns, fabric texture and cut:
{pieces}
- Layer them naturally (shirt under sweater, jacket on top{tuck}). Fit as listed; if not listed, a clean regular fit.
- Do not add any clothing, logos or accessories that aren't listed.
- Standing relaxed, facing the camera, whole body visible from head to shoes, plain light-grey studio background, soft even daylight.
- Photorealistic, like a catalog photo. No text."""


def _jpeg(raw: bytes, max_side: int = 1024) -> bytes:
    img = Image.open(io.BytesIO(raw))
    if img.mode in ("RGBA", "LA", "P"):
        rgba = img.convert("RGBA")
        img = Image.new("RGB", rgba.size, (255, 255, 255))
        img.paste(rgba, mask=rgba.split()[3])
    img = img.convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return buf.getvalue()


def _piece_text(it: dict) -> str:
    bits = [it.get("kind") or it["category"], it.get("color") or ""]
    if it.get("color2"):
        bits.append(f"with {it['color2']}")
    for k in ("pattern", "material", "fit"):
        if it.get(k) and it.get(k) != "solid":
            bits.append(it[k] + (" fit" if k == "fit" else ""))
    return f"{it['name']} ({', '.join(b for b in bits if b)})"


def tryon_prompt(pieces: list, has_face: bool) -> tuple:
    """pieces: [(item, photo_bytes_or_None)]. Returns (prompt, [(filename, bytes)] of the piece photos)."""
    first = 3 if has_face else 2
    lines, files = [], []
    for it, photo in pieces[:10]:
        if photo:
            try:
                files.append((f"piece{len(files) + 1}.jpg", _jpeg(photo, 768)))
                lines.append(f"  - {_piece_text(it)}: see image {first + len(files) - 1}")
                continue
            except Exception:
                pass
        lines.append(f"  - {_piece_text(it)}")
    tuck = ", shirt tucked in" if any(it.get("kind") == "shirt" for it, _ in pieces) and \
        any(it["category"] == "suit" for it, _ in pieces) else ""
    prompt = TRYON_PROMPT.format(face_note=" (image 2 is a close-up of their face: match it)" if has_face else "",
                                 pieces="\n".join(lines), tuck=tuck)
    return prompt, files


def try_on(body: bytes, face, pieces: list, quality: str = "medium") -> bytes:
    """Picture of the user wearing the pieces. Returns image bytes."""
    import openai

    if not enabled():
        raise AIError("AI is not set up. Add an OpenAI API key in Settings.")
    try:
        images = [("person.jpg", _jpeg(body, 1536))]
        if face:
            images.append(("face.jpg", _jpeg(face, 1024)))
    except Exception:
        raise AIError("Couldn't read your photo. Upload it again in Settings.")
    prompt, files = tryon_prompt(pieces, bool(face))
    images += files
    try:
        resp = _get_client().with_options(timeout=240).images.edit(
            model=TRYON_MODEL,
            image=[(name, data, "image/jpeg") for name, data in images],
            prompt=prompt,
            quality=quality,
            size="1024x1536",
            # no input_fidelity: newer image models reject it (they always keep faces closely)
        )
    except openai.NotFoundError:
        raise AIError(f"OpenAI doesn't know the image model “{TRYON_MODEL}”.")
    except openai.OpenAIError as e:
        raise _friendly(e)
    try:
        return base64.b64decode(resp.data[0].b64_json)
    except Exception:
        raise AIError("The AI didn't send a picture back. Try again.")


# ---------- outfit check: a critical look at a photo of the user wearing an outfit ----------

CHECK_SCHEMA = {
    "type": "object",
    "properties": {
        "person_visible": {"type": "boolean"},
        "verdict": {"type": "string", "enum": ["works", "almost", "doesnt_work"]},
        "score": {"type": "integer", "enum": list(range(1, 11))},
        "summary": {"type": "string"},
        "problems": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"issue": {"type": "string"}, "fix": {"type": "string"}},
                "required": ["issue", "fix"],
                "additionalProperties": False,
            },
        },
        "works": {"type": "array", "items": {"type": "string"}},
        "swaps": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"out_id": {"type": "integer"}, "in_id": {"type": "integer"}, "reason": {"type": "string"}},
                "required": ["out_id", "in_id", "reason"],
                "additionalProperties": False,
            },
        },
        "mismatch": {"type": "string"},
    },
    "required": ["person_visible", "verdict", "score", "summary", "problems", "works", "swaps", "mismatch"],
    "additionalProperties": False,
}

CHECK_INSTRUCTIONS = """You are a demanding, honest menswear stylist reviewing a real photo of the user wearing an outfit.
Judge what the photo actually shows, not how good the outfit could be in theory. Be direct and specific. No flattery,
no softening phrases, never call anything perfect. Even a strong look gets at least one concrete improvement.

Check, in this order of importance:
1. Fit: shoulder seams, chest and waist (pulling or excess fabric), sleeve length (shirt cuff vs jacket sleeve),
   jacket length, trouser rise, waist, leg width and taper, length and break on the shoes, tightness or bagginess.
2. Proportions and silhouette: top vs bottom balance, tucked vs untucked, layer lengths.
3. Colors and patterns together, contrast with the user's skin and hair, too many accents, clashing tones or textures.
4. Condition: wrinkles, creases, pilling, stains, scuffed or dirty shoes, visible wear.
5. Suitability for the stated occasion; the user's ground rules and classic menswear rules.
   Judge only how the outfit looks: ignore the weather and the season.
6. Details: collar under the jacket, belt and shoe match, sock visibility, tie or pocket square, untidy tucks.

Output:
- person_visible: false if no person wearing clothes is clearly visible (then leave the rest minimal).
- verdict: works (would look good in real life as is), almost (one or two fixes needed), doesnt_work.
- score: 1-10. Be calibrated: 5 is an ordinary, unremarkable look; 7 is good; 8+ only for genuinely sharp looks.
- summary: one blunt sentence.
- problems: the biggest problems first, max 5. issue = what is wrong and where; fix = exactly what to do.
- works: max 3 short points that genuinely work (may be empty).
- swaps: up to 3 replacements from the user's closet list (ids): out_id must be a piece of this outfit,
  in_id a closet piece of the same category. Only when the swap clearly fixes a problem.
- mismatch: if the photo clearly shows different pieces than the listed outfit, say which; otherwise ""."""


def check_look(photo: bytes, outfit: list, closet: list, occasion: int, temp=None, rules: list = None,
               classic: bool = True, style: str = "") -> dict:
    """A critical review of a photo of the user wearing an outfit. Returns the parsed review."""
    try:
        url = "data:image/jpeg;base64," + base64.b64encode(_jpeg(photo, 1536)).decode()
    except Exception:
        raise AIError("Couldn't read that photo.")
    occ = {1: "casual (everyday)", 2: "smart casual (work)", 3: "formal (elegant)"}.get(occasion, "smart casual (work)")
    parts = [f"Occasion: {occ}."]
    parts.append("The outfit in the photo (closet pieces):")
    parts.extend(_item_line(i) for i in outfit)
    parts.append("\nThe rest of the closet (for swaps):")
    in_outfit = {i["id"] for i in outfit}
    parts.extend(_item_line(i) for i in closet if i["id"] not in in_outfit)
    if rules:
        parts.append("\nThe user's ground rules:")
        parts.extend(f"- {rulebook.describe(r)}" for r in rules)
    if classic:
        parts.append("\nClassic menswear rules the user follows:")
        parts.extend(f"- {r}" for r in menswear.SUMMARY if "season" not in r.lower() and "cold" not in r.lower())
    if style.strip():
        parts.append(f"\nThe user's style preferences: {style.strip()[:1000]}")
    data = _call(CHECK_INSTRUCTIONS,
                 [{"type": "input_text", "text": "\n".join(parts)}, {"type": "input_image", "image_url": url}],
                 CHECK_SCHEMA, "outfit_check")
    if not data.get("person_visible"):
        raise AIError("Couldn't see you wearing the outfit in this photo. Try a full-length photo in good light.")
    closet_by_id = {i["id"]: i for i in closet}
    swaps = []
    for s in data.get("swaps") or []:
        out_it, in_it = closet_by_id.get(s.get("out_id")), closet_by_id.get(s.get("in_id"))
        if out_it and in_it and out_it["id"] in in_outfit and in_it["id"] not in in_outfit \
                and out_it["category"] == in_it["category"]:
            swaps.append({"out_id": out_it["id"], "out_name": out_it["name"], "in_id": in_it["id"],
                          "in_name": in_it["name"], "reason": str(s.get("reason") or "")[:200]})
    return {
        "verdict": data.get("verdict") if data.get("verdict") in ("works", "almost", "doesnt_work") else "almost",
        "score": min(10, max(1, int(data.get("score") or 5))),
        "summary": str(data.get("summary") or "")[:300],
        "problems": [{"issue": str(p.get("issue") or "")[:300], "fix": str(p.get("fix") or "")[:300]}
                     for p in (data.get("problems") or [])[:5]],
        "works": [str(w)[:200] for w in (data.get("works") or [])[:3]],
        "swaps": swaps[:3],
        "mismatch": str(data.get("mismatch") or "")[:300],
        "occasion": occasion,
    }


# ---------- outfit names ----------

NAMES_SCHEMA = {
    "type": "object",
    "properties": {"names": {"type": "array", "items": {"type": "string"}}},
    "required": ["names"],
    "additionalProperties": False,
}

NAMES_INSTRUCTIONS = """Suggest 3 different names for an outfit in a personal closet app.
Each 2-4 words, easy to recognise at a glance in a list (hint at the occasion, key colors or the main piece),
with a little character, e.g. "Navy Boardroom", "Weekend Denim", "Grey Flannel Friday". No brand names, no emojis,
no quotes. Avoid names the user already uses."""


def suggest_names(items: list, occasion=None, notes: str = "", taken: list = None) -> list:
    parts = ["Outfit pieces:", *(_item_line(i) for i in items)]
    if occasion:
        parts.append(f"Occasion: {({1: 'casual', 2: 'work', 3: 'formal'}).get(occasion, '')}")
    if notes.strip():
        parts.append(f"User's note: {notes.strip()[:300]}")
    if taken:
        parts.append("Names already used: " + ", ".join(taken[:60]))
    data = _call(NAMES_INSTRUCTIONS, [{"type": "input_text", "text": "\n".join(parts)}], NAMES_SCHEMA, "outfit_names")
    out = []
    for n in data.get("names") or []:
        n = str(n).strip().strip('"“”').strip()[:60]
        if n and n.lower() not in {x.lower() for x in out}:
            out.append(n)
    return out[:3]
