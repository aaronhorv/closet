"""Rule-based outfit recommender.

Scores each clean item for the day (warmth vs. weather, formality vs. occasion,
how recently it was worn, favorites, past ratings), then scores whole outfits
(color harmony, consistent formality) and returns a few varied picks.
"""
import random
from datetime import date
from itertools import product

CATEGORIES = ["top", "bottom", "dress", "outerwear", "shoes", "accessory"]
DISPLAY_ORDER = ["outerwear", "top", "dress", "bottom", "shoes", "accessory"]

NEUTRALS = (
    "black", "white", "grey", "gray", "charcoal", "navy", "beige", "cream", "ivory",
    "tan", "khaki", "brown", "camel", "denim", "stone", "taupe", "nude", "oatmeal",
    "off-white", "off white", "silver",
)


def is_neutral(color) -> bool:
    c = (color or "").strip().lower()
    return not c or any(n in c for n in NEUTRALS)


def target_warmth(temp):
    """Ideal warmth (1-5) for base layers at a given feels-like °C."""
    if temp is None:
        return 3
    if temp >= 26:
        return 1
    if temp >= 20:
        return 2
    if temp >= 13:
        return 3
    if temp >= 6:
        return 4
    return 5


def outer_target(temp):
    if temp is None or temp >= 12:
        return 2
    if temp >= 6:
        return 3
    if temp >= 0:
        return 4
    return 5


def _days_since(last, on: date):
    if not last:
        return None
    try:
        return (on - date.fromisoformat(last)).days
    except ValueError:
        return None


def _item_score(it, target, occasion, on, rainy):
    gap = abs(it["formality"] - occasion)
    if gap >= 2:
        return None  # e.g. gym tee at a formal event
    warmth_weight = 0.6 if it["category"] == "accessory" else 1.2
    s = -abs(it["warmth"] - target) * warmth_weight - gap * 1.5

    # Jackets, shoes and accessories get re-worn daily, so repeats matter less.
    repeat_weight = 0.3 if it["category"] in ("outerwear", "shoes", "accessory") else 1.0
    days = _days_since(it.get("last_worn"), on)
    if days is None:
        s += 0.8 * repeat_weight          # never worn: give it a chance
    elif days <= 1:
        s -= 2.5 * repeat_weight          # wore it yesterday
    elif days <= 3:
        s -= 1.0 * repeat_weight
    else:
        s += min(days, 21) / 21 * repeat_weight

    if it.get("favorite"):
        s += 0.5
    if it.get("avg_rating"):
        s += (it["avg_rating"] - 3) * 0.3
    if rainy and it["category"] in ("outerwear", "shoes"):
        tags = (it.get("tags") or "").lower()
        if "waterproof" in tags or "rain" in tags:
            s += 1.5
    return s


def _harmony(items):
    bold = {(i.get("color") or "").strip().lower()
            for i in items if i["category"] != "accessory" and not is_neutral(i.get("color"))}
    if not bold:
        return 0.5
    if len(bold) == 1:
        return 0.8
    if len(bold) == 2:
        return -0.4
    return -1.5


def _notes(items, on):
    notes = []
    bold = [(i.get("color") or "").strip().lower()
            for i in items if i["category"] != "accessory" and not is_neutral(i.get("color"))]
    bold = list(dict.fromkeys(bold))
    if not bold:
        notes.append("All neutrals: easy to get right.")
    elif len(bold) == 1:
        notes.append(f"Neutrals with a pop of {bold[0]}.")
    else:
        notes.append(f"{bold[0].capitalize()} and {bold[1]} together: a bolder mix.")

    stalest, stalest_days = None, -1
    for it in items:
        days = _days_since(it.get("last_worn"), on)
        d = 10_000 if days is None else days
        if d > stalest_days:
            stalest, stalest_days = it, d
    if stalest is not None:
        if stalest_days == 10_000:
            notes.append(f"First outing for the {stalest['name']}.")
        elif stalest_days >= 21:
            notes.append(f"You haven't worn the {stalest['name']} in {stalest_days} days.")
    return notes


def _headline(temp, rainy, need_outer, has_outer):
    if need_outer and not has_outer:
        return "It calls for a jacket, but there's no clean outerwear in your closet."
    if rainy and need_outer:
        return "Rain or snow likely: a jacket is included."
    if temp is None:
        return ""
    if temp >= 26:
        return "Hot day: lightest pieces first."
    if temp >= 20:
        return "Warm: light layers."
    if temp >= 13:
        return "Mild: medium layers" + (" plus a light jacket." if need_outer else ".")
    if temp >= 6:
        return "Cool: warmer layers and a jacket."
    return "Cold: bundle up with your warmest pieces."


def _order(items):
    return sorted(items, key=lambda i: DISPLAY_ORDER.index(i["category"]))


def recommend(items, occasion, temp, rainy, on: date, seed, outerwear_below=16.0, count=3):
    rng = random.Random(seed)
    active = [i for i in items if not i["archived"] and not i["in_laundry"]]

    target = target_warmth(temp)
    need_outer = rainy or (temp is not None and temp < outerwear_below)
    base_target = max(1, target - 1) if need_outer else target
    o_target = outer_target(temp)

    pools = {}
    for cat in CATEGORIES:
        tgt = o_target if cat == "outerwear" else base_target
        scored = []
        for it in active:
            if it["category"] != cat:
                continue
            sc = _item_score(it, tgt, occasion, on, rainy)
            if sc is not None:
                scored.append((sc + rng.uniform(0, 1.5), it))  # jitter = variety
        # Drop pieces that are far too warm/cold for the day (t-shirt at 2°C),
        # unless that would leave nothing in the category.
        if cat != "accessory":
            suitable = [p for p in scored if abs(p[1]["warmth"] - tgt) < 3]
            scored = suitable or scored
        scored.sort(key=lambda x: x[0], reverse=True)
        pools[cat] = scored[:6]

    has_outer = bool(pools["outerwear"])
    result = {
        "temp": temp,
        "rainy": rainy,
        "need_outerwear": need_outer,
        "headline": _headline(temp, rainy, need_outer, has_outer),
        "outfits": [],
        "message": "",
    }

    templates = []
    if pools["top"] and pools["bottom"]:
        templates.append(["top", "bottom"])
    if pools["dress"]:
        templates.append(["dress"])
    if not templates:
        if not any(i["category"] in ("top", "bottom", "dress") for i in items if not i["archived"]):
            result["message"] = "Add at least one top and one bottom (or a dress) to get suggestions."
        else:
            result["message"] = ("Not enough clean pieces that suit this occasion. "
                                 "Try another occasion or clear your laundry.")
        return result

    extras = []
    if pools["shoes"]:
        extras.append("shoes")
    if need_outer and has_outer:
        extras.append("outerwear")

    combos = []
    for tpl in templates:
        cats = tpl + extras
        for picks in product(*(pools[c] for c in cats)):
            its = [p[1] for p in picks]
            base = sum(p[0] for p in picks) / len(picks)
            forms = [i["formality"] for i in its]
            total = base + _harmony(its) - 0.5 * (max(forms) - min(forms)) + rng.uniform(0, 0.4)
            combos.append((total, its))
    combos.sort(key=lambda c: c[0], reverse=True)

    def key_piece(its):
        return next(i["id"] for i in its if i["category"] in ("top", "dress"))

    chosen = []
    for strict in (True, False):
        for total, its in combos:
            if len(chosen) >= count:
                break
            ids = {i["id"] for i in its}
            if any(ids == c["ids"] for c in chosen):
                continue
            if strict and any(key_piece(its) == c["key"] or len(ids & c["ids"]) > 2 for c in chosen):
                continue
            chosen.append({"ids": ids, "key": key_piece(its), "items": its, "score": total})

    used_acc = set()
    for c in chosen:
        for sc, acc in pools["accessory"]:
            if acc["id"] not in used_acc and sc > -1:
                c["items"] = c["items"] + [acc]
                used_acc.add(acc["id"])
                break

    result["outfits"] = [
        {"items": _order(c["items"]), "score": round(c["score"], 2), "notes": _notes(c["items"], on)}
        for c in chosen
    ]
    return result
