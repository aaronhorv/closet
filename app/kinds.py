"""Item types within each category (shirt, sweater, formal shoes, ...), and guessing them from names."""
import re

CATEGORIES = ["top", "bottom", "dress", "suit", "outerwear", "shoes", "accessory"]

KINDS = {
    "top": ["t-shirt", "shirt", "polo", "turtleneck", "blouse", "tank top", "sweater", "cardigan", "sweatshirt", "hoodie"],
    "bottom": ["jeans", "chinos", "trousers", "suit trousers", "shorts", "skirt", "joggers"],
    "dress": ["dress", "jumpsuit"],
    "suit": ["suit jacket", "blazer", "waistcoat"],
    "outerwear": ["coat", "jacket", "parka", "raincoat", "overshirt", "gilet"],
    "shoes": ["sneakers", "formal shoes", "loafers", "boots", "sandals"],
    "accessory": ["belt", "tie", "scarf", "hat", "bag", "watch", "jewelry", "gloves"],
}
ALL_KINDS = sorted({k for ks in KINDS.values() for k in ks})

# Tops that go over another top, and tops that can be worn underneath one.
LAYER_KINDS = {"sweater", "cardigan", "sweatshirt", "hoodie"}
BASE_KINDS = {"t-shirt", "shirt", "polo", "turtleneck", "blouse", "tank top"}

# First match wins; a kind is only used if it belongs to the item's category.
_GUESS = [
    ("suit jacket", r"suit (jacket|coat)s?|sakkos?|tuxedo jackets?|dinner jackets?"),
    ("blazer", r"blazers?|sport ?coats?|sports jackets?"),
    ("waistcoat", r"waistcoats?"),
    ("suit trousers", r"suit (trousers|pants)|dress (trousers|pants)|tuxedo (trousers|pants)"),
    ("turtleneck", r"turtle ?necks?|roll ?necks?|polo ?necks?|mock ?necks?"),
    ("t-shirt", r"t-? ?shirts?|tees?"),
    ("polo", r"polos?"),
    ("hoodie", r"hoodies?|hooded"),
    ("sweatshirt", r"sweatshirts?|crew ?necks?"),
    ("cardigan", r"cardigans?"),
    ("sweater", r"sweaters?|jumpers?|pullovers?|knit|knitted|knitwear"),
    ("blouse", r"blouses?"),
    ("tank top", r"tanks?|tank tops?|camis?|singlets?"),
    ("overshirt", r"overshirts?|shackets?"),
    ("shirt", r"shirts?|oxford|flannel|button[- ]down"),
    ("jeans", r"jeans|denims?"),
    ("chinos", r"chinos?"),
    ("joggers", r"joggers?|sweatpants|track ?pants"),
    ("shorts", r"shorts"),
    ("skirt", r"skirts?"),
    ("trousers", r"trousers?|pants|slacks"),
    ("jumpsuit", r"jumpsuits?|playsuits?|overalls"),
    ("dress", r"dress(es)?|gowns?"),
    ("raincoat", r"raincoats?|rain jackets?"),
    ("parka", r"parkas?|puffers?|down jackets?"),
    ("coat", r"coats?|overcoats?|topcoats?|trench"),
    ("gilet", r"gilets?|vests?|bodywarmers?"),
    ("jacket", r"jackets?|bombers?|anoraks?|windbreakers?"),
    ("sneakers", r"sneakers?|trainers?|runners?"),
    ("loafers", r"loafers?"),
    ("boots", r"boots?"),
    ("sandals", r"sandals?|slides|flip ?flops?"),
    ("formal shoes", r"oxfords?|derbys?|derbies|brogues?|monks?|monk ?straps?|dress shoes?|pumps|heels?"),
    ("belt", r"belts?"),
    ("tie", r"ties?|neckties?|bow ?ties?"),
    ("scarf", r"scarf|scarves"),
    ("hat", r"hats?|caps?|beanies?"),
    ("bag", r"bags?|backpacks?|totes?"),
    ("watch", r"watch(es)?"),
    ("gloves", r"gloves?"),
    ("jewelry", r"necklaces?|bracelets?|earrings?|rings?"),
]
_GUESS = [(k, re.compile(rf"\b(?:{p})\b", re.I)) for k, p in _GUESS]


def guess_kind(text: str, category: str) -> str:
    allowed = KINDS.get(category, [])
    text = text or ""
    for kind, rx in _GUESS:
        if kind in allowed and rx.search(text):
            return kind
    return ""


def clean_kind(kind: str, category: str) -> str:
    kind = (kind or "").strip().lower()
    return kind if kind in KINDS.get(category, []) else ""


def is_tailoring(name: str) -> bool:
    """Blazers and suit jackets filed as outerwear or tops before the suit category existed."""
    return bool(guess_kind(name, "suit"))
