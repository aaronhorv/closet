"""Classic menswear rules (switchable in Settings). Checked on Today's suggestions and on AI outfits.

Each check only uses what the app knows about a piece: category, type, color, material, pattern, warmth.
"""
from .kinds import is_neutral

BLACK = ("black",)
BROWN = ("brown", "tan", "cognac", "chocolate", "chestnut", "camel", "burgundy", "oxblood", "walnut",
         "mahogany", "espresso", "caramel", "whisky", "whiskey", "coffee", "taupe")
LEATHER_SHOES = {"formal shoes", "loafers", "boots"}
TOO_CASUAL_FOR_SUIT = {"sneakers", "sandals", "hoodie", "sweatshirt", "joggers", "shorts"}
NOT_FOR_WORK = {"shorts", "hoodie", "joggers", "sandals", "tank top"}
NOT_FOR_FORMAL = NOT_FOR_WORK | {"sweatshirt", "sneakers", "t-shirt", "jeans"}
LIGHT_FABRICS = ("linen", "seersucker")
HEAVY_FABRICS = ("flannel", "tweed", "corduroy", "cashmere", "fleece", "down", "shearling", "mohair", "boucle", "bouclé")

# Shown in Settings and sent to the AI.
SUMMARY = [
    "Belt and shoes in the same leather color (black with black, brown with brown).",
    "Black shoes with a black, charcoal or navy suit at formal occasions.",
    "No sneakers, sandals, hoodies, joggers or shorts with a full suit.",
    "No shorts, hoodies, joggers, sandals, tank tops or graphic tees at work; formal also rules out jeans, t-shirts and sneakers.",
    "A tie only with a collared shirt.",
    "A pocket square only with a blazer or suit jacket.",
    "At most one bold pattern per outfit (patterned socks count).",
    "At most two bold colors per outfit; neutrals (navy, grey, white, beige, brown...) don't count.",
    "Fabrics for the season: no linen when it's cold, no flannel, tweed or heavy wool when it's hot.",
    "Socks: plain socks matching the trousers are a given; patterned or colorful socks only as the single playful piece (never at formal occasions); never sport or white socks with formal shoes or a suit; no-show socks only with loafers or sneakers.",
    "Accessories only when they add something: pocket square with a jacket, tie with a shirt for formal looks, scarf and gloves in the cold; a basic belt and watch are a given.",
]


def _c(it):
    return (it.get("color") or "").strip().lower()


def leather_family(color: str):
    c = (color or "").lower()
    if any(w in c for w in BLACK):
        return "black"
    if any(w in c for w in BROWN):
        return "brown"
    return None


def is_patterned(it) -> bool:
    return (it.get("pattern") or "solid") not in ("solid", "") or "pattern" in _c(it)


def bold_colors(items):
    out = []
    for i in items:
        if i["category"] == "accessory":
            continue
        for c in (i.get("color"), i.get("color2")):
            c = (c or "").strip().lower()
            if c and not is_neutral(c) and "pattern" not in c:
                out.append(c)
    return list(dict.fromkeys(out))


def suited_pair(items):
    ids = {i["id"] for i in items}
    for i in items:
        if i["category"] == "suit" and i.get("match_id") in ids:
            return i, next(x for x in items if x["id"] == i["match_id"])
    return None


def broken(items, occasion, temp) -> list:
    """Reasons this outfit breaks classic menswear rules (empty = fine)."""
    out = []
    kinds = {i.get("kind") or "" for i in items}
    by_cat = {}
    for i in items:
        by_cat.setdefault(i["category"], []).append(i)
    shoes = by_cat.get("shoes", [])
    socks = by_cat.get("socks", [])
    belts = [i for i in by_cat.get("accessory", []) if i.get("kind") == "belt"]
    suit = suited_pair(items)

    # leather
    for b in belts:
        for s in shoes:
            if s.get("kind") in LEATHER_SHOES or "leather" in (s.get("material") or "").lower():
                fb, fs = leather_family(_c(b)), leather_family(_c(s))
                if fb and fs and fb != fs:
                    out.append("Belt and shoes should be the same leather color.")
    if suit and occasion == 3 and any(w in _c(suit[0]) for w in ("black", "charcoal", "navy")):
        if shoes and not all(leather_family(_c(s)) == "black" for s in shoes):
            out.append("Black shoes go with a dark suit at formal occasions.")

    # formality
    if suit and kinds & TOO_CASUAL_FOR_SUIT:
        out.append("Too casual for a full suit.")
    if occasion == 2 and kinds & NOT_FOR_WORK:
        out.append("Too casual for work.")
    if occasion == 3 and kinds & NOT_FOR_FORMAL:
        out.append("Too casual for a formal occasion.")
    if occasion >= 2 and any(i.get("kind") == "t-shirt" and (i.get("pattern") == "print") for i in items):
        out.append("No graphic tees at work.")
    if "tie" in kinds and "shirt" not in kinds:
        out.append("A tie needs a collared shirt.")
    if "pocket square" in kinds and not by_cat.get("suit"):
        out.append("A pocket square needs a blazer or suit jacket.")

    # patterns and colors (clothes and socks, not accessories)
    if sum(1 for i in items if i["category"] != "accessory" and is_patterned(i)) >= 2:
        out.append("One bold pattern at a time.")
    if len(bold_colors(items)) > 2:
        out.append("Too many bold colors.")

    # season
    if temp is not None:
        for i in items:
            if i["category"] in ("shoes", "socks", "accessory"):
                continue
            m = (i.get("material") or "").lower()
            if temp < 12 and any(w in m for w in LIGHT_FABRICS):
                out.append(f"{i['name']}: linen is too light for the cold.")
            elif temp > 24 and (any(w in m for w in HEAVY_FABRICS) or ("wool" in m and i.get("warmth", 3) >= 4)):
                out.append(f"{i['name']}: too heavy for the heat.")

    # socks
    formal_shoes = any(s.get("kind") == "formal shoes" for s in shoes)
    for s in socks:
        k = s.get("kind") or ""
        if k == "sport socks" and (formal_shoes or suit or occasion >= 2):
            out.append("No sport socks with formal shoes, a suit or at work.")
        if "white" in _c(s) and (formal_shoes or suit):
            out.append("No white socks with formal shoes or a suit.")
        if k == "no-show socks" and shoes and not all(x.get("kind") in ("loafers", "sneakers") for x in shoes):
            out.append("No-show socks only with loafers or sneakers.")
        if occasion == 3 and (is_patterned(s) or bold_colors([s])):
            out.append("Plain dark socks at formal occasions.")
    return list(dict.fromkeys(out))


def sock_score(sock, items, occasion, temp) -> float:
    """How well a pair of socks fits an outfit (higher = better)."""
    score = 0.0
    k = sock.get("kind") or ""
    sc = _c(sock)
    bottoms = [i for i in items if i["category"] in ("bottom", "dress")]
    shoes = [i for i in items if i["category"] == "shoes"]
    if occasion >= 2:
        if k == "dress socks":
            score += 1.0
        if bottoms and sc and sc == _c(bottoms[0]):
            score += 2.0
        elif shoes and sc and sc == _c(shoes[0]):
            score += 1.0
    if k == "no-show socks" and shoes and all(s.get("kind") in ("loafers", "sneakers") for s in shoes):
        score += 1.5 if temp is not None and temp > 20 else 0.3
    if k == "sport socks" and any(s.get("kind") == "sneakers" for s in shoes) and occasion == 1:
        score += 0.8
    return score


# ---------- extras: socks and accessories are only added when they add something ----------
# Plain neutral socks and basic accessories (a belt matching the shoes, a plain watch) are assumed;
# the catalogued ones are statement pieces.
WEATHER_EXTRAS = {"scarf", "gloves", "hat"}


def statement_count(items) -> int:
    """Patterned pieces plus bold colors in the outfit (accessories and socks don't count)."""
    clothes = [i for i in items if i["category"] not in ("accessory", "socks")]
    return sum(1 for i in clothes if is_patterned(i)) + len(bold_colors([i for i in clothes if not is_patterned(i)]))


def _echo(piece, items):
    """A bold color of the piece that already appears elsewhere in the outfit."""
    mine = [c for c in (_c(piece), (piece.get("color2") or "").strip().lower()) if c and not is_neutral(c)]
    others = {c for i in items for c in (_c(i), (i.get("color2") or "").strip().lower()) if c}
    return next((c for c in mine if any(c in o or o in c for o in others)), None)


def extra_value(piece, items, occasion, temp):
    """(score, note) when this sock or accessory genuinely improves the outfit, else None."""
    kind = piece.get("kind") or ""
    name = piece["name"]
    statement = is_patterned(piece) or bool(bold_colors([piece]))
    has_jacket = any(i["category"] == "suit" for i in items)
    has_coat = any(i["category"] == "outerwear" for i in items)
    kinds = {i.get("kind") or "" for i in items}

    if piece["category"] == "socks":
        if occasion == 3 or not statement:
            return None  # plain socks are a given; formal looks keep them plain
        echo = _echo(piece, items)
        if echo:
            return 2.5, f"The {name} pick up the {echo}."
        if statement_count(items) == 0:
            return 2.0, f"The {name} add the one playful touch to a calm outfit."
        return None

    if kind == "pocket square":
        return (3.0, f"Finish the jacket with the {name}.") if has_jacket else None
    if kind == "tie":
        if "shirt" in kinds and (occasion == 3 or suited_pair(items)):
            return 2.5, f"Add the {name}."
        return None
    if kind in WEATHER_EXTRAS:
        if temp is None or not has_coat:
            return None
        if kind == "scarf" and temp < 8:
            return 2.0, f"Take the {name}: it's cold."
        if kind in ("gloves", "hat") and temp < 3 and not (kind == "hat" and occasion == 3):
            return 1.5, f"Take the {name}: it's freezing."
        return None
    # belt, watch, bag, jewelry: the plain versions are assumed; only a statement piece with room for it
    if statement and occasion < 3:
        echo = _echo(piece, items)
        if echo:
            return 1.5, f"The {name} picks up the {echo}."
        if statement_count(items) == 0:
            return 1.5, f"The {name} adds some interest to a calm outfit."
    return None
