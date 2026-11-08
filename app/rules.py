"""Ground rules for outfits, e.g. "for work, tops only shirt or turtleneck when colder than 10°".

A rule is a dict:
  type      "only" (that category may only be these kinds), "never" (none of these kinds),
            or "under" (these kinds need a top underneath them)
  occasion  0 any, 1 casual, 2 smart casual / work, 3 formal
  category  the category the kinds belong to
  kinds     list of kinds
  below     optional °C: the rule applies only when it feels colder than this
  above     optional °C: the rule applies only when it feels warmer than this
"""
from .kinds import BASE_KINDS, KINDS, LAYER_KINDS

TYPES = ("only", "never", "under")
OCCASION_WORDS = {0: "", 1: "casual", 2: "work", 3: "formal occasions"}
MAX_RULES = 40


def normalize(rules) -> list:
    """Validate rules from the browser; drops anything malformed."""
    out = []
    for r in rules or []:
        if not isinstance(r, dict):
            continue
        typ, cat = r.get("type"), r.get("category")
        if typ not in TYPES or cat not in KINDS:
            continue
        kinds = [k for k in dict.fromkeys(r.get("kinds") or []) if k in KINDS[cat]]
        if not kinds:
            continue
        try:
            occ = int(r.get("occasion") or 0)
        except (TypeError, ValueError):
            occ = 0
        rule = {"type": typ, "occasion": occ if occ in (0, 1, 2, 3) else 0, "category": cat, "kinds": kinds,
                "below": None, "above": None}
        for k in ("below", "above"):
            v = r.get(k)
            if v is not None and v != "":
                try:
                    rule[k] = round(max(-60.0, min(60.0, float(v))), 1)
                except (TypeError, ValueError):
                    pass
        out.append(rule)
    return out[:MAX_RULES]


def is_conditional(rule) -> bool:
    return rule["below"] is not None or rule["above"] is not None


def applies(rule, occasion, temp) -> bool:
    if rule["occasion"] and rule["occasion"] != occasion:
        return False
    if rule["below"] is not None and (temp is None or not temp < rule["below"]):
        return False
    if rule["above"] is not None and (temp is None or not temp > rule["above"]):
        return False
    return True


def active(rules, occasion, temp) -> list:
    return [r for r in rules if applies(r, occasion, temp)]


def _kind(it):
    return it.get("kind") or ""


def item_ok(it, rules, as_layer=False) -> bool:
    """Can this piece be part of an outfit at all? (as_layer: worn over another top)"""
    k = _kind(it)
    for r in rules:
        if r["category"] != it["category"]:
            continue
        if r["type"] == "never" and k in r["kinds"]:
            return False
        if r["type"] == "only" and k not in r["kinds"] and not (as_layer and k in LAYER_KINDS):
            return False
        if r["type"] == "under" and not as_layer and k in r["kinds"]:
            return False
    return True


def broken(items, rules) -> list:
    """The rules this outfit breaks (empty list = fine)."""
    tops = [i for i in items if i["category"] == "top"]
    has_dress = any(i["category"] == "dress" for i in items)

    def breaks(r, it):
        if it["category"] != r["category"]:
            return False
        k = _kind(it)
        others = [t for t in tops if t is not it]
        if r["type"] == "never":
            return k in r["kinds"]
        if r["type"] == "only":
            # a sweater over an allowed shirt is fine
            return k not in r["kinds"] and not (k in LAYER_KINDS and any(_kind(t) in r["kinds"] for t in others))
        return k in r["kinds"] and not (has_dress or any(_kind(t) in BASE_KINDS for t in others))

    return [r for r in rules if any(breaks(r, it) for it in items)]


def describe(rule) -> str:
    """Plain English, temperatures in °C (for the AI)."""
    kinds = " or ".join(rule["kinds"])
    occ = OCCASION_WORDS[rule["occasion"]]
    if rule["type"] == "only":
        text = f"{rule['category']} must be {kinds} (a sweater/cardigan worn over an allowed top is fine)"
    elif rule["type"] == "never":
        text = f"never wear {kinds}"
    else:
        text = f"{kinds} must always be worn over another top (shirt, t-shirt, turtleneck, polo...)"
    if occ:
        text = f"For {occ}: {text}"
    if rule["below"] is not None:
        text += f", when it feels colder than {rule['below']:g}°C"
    if rule["above"] is not None:
        text += f", when it feels warmer than {rule['above']:g}°C"
    return text[0].upper() + text[1:]
