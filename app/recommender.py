"""Rule-based outfit recommender.

Scores each clean item for the day (warmth vs. weather, formality vs. occasion,
how recently it was worn, favorites, past ratings), then scores whole outfits
(color harmony, consistent formality) and returns a few varied picks.
"""
import random
from datetime import date
from itertools import product

from . import menswear
from . import rules as rulebook
from .kinds import BASE_KINDS, CATEGORIES, LAYER_KINDS, is_neutral  # noqa: F401

DISPLAY_ORDER = ["outerwear", "suit", "top", "dress", "bottom", "shoes", "socks", "accessory"]

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


def _item_score(it, target, occasion, on, rainy, formality=None):
    gap = abs((it["formality"] if formality is None else formality) - occasion)
    if gap >= 2:
        return None  # e.g. gym tee at a formal event
    warmth_weight = 0.6 if it["category"] in ("accessory", "socks") else 1.2
    s = -abs(it["warmth"] - target) * warmth_weight - gap * 1.5

    # Jackets, shoes and accessories get re-worn daily, so repeats matter less.
    repeat_weight = 0.3 if it["category"] in ("outerwear", "suit", "shoes", "socks", "accessory") else 1.0
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


def is_patterned(it) -> bool:
    return (it.get("pattern") or "solid") != "solid" or "pattern" in (it.get("color") or "").lower()


def _accents(items, skip_patterned=False):
    """Bold colors (main and second color) of the clothes, ignoring accessories."""
    out = []
    for i in items:
        if i["category"] == "accessory" or (skip_patterned and is_patterned(i)):
            continue
        for c in (i.get("color"), i.get("color2")):
            c = (c or "").strip().lower()
            if c and not is_neutral(c) and "pattern" not in c:
                out.append(c)
    return list(dict.fromkeys(out))


def _harmony(items):
    patterned = sum(1 for i in items if i["category"] != "accessory" and is_patterned(i))
    if patterned >= 2:
        return -1.5  # two patterns rarely work
    # a patterned piece is one statement, whatever its colors
    n = len(_accents(items, skip_patterned=True)) + patterned
    if n == 0:
        return 0.5
    if n == 1:
        return 0.8
    if n == 2:
        return -0.4
    return -1.5


def _notes(items, on):
    notes = []
    bold = _accents(items)
    pat = next((i for i in items if i["category"] != "accessory" and is_patterned(i)), None)
    if pat is not None:
        notes.append(f"The {pat['name']} is the statement piece; the rest keeps it calm.")
    elif not bold:
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


def history_key(items):
    """What makes two outfits 'the same': the clothes, ignoring coats, socks and accessories."""
    return frozenset((i["id"] if isinstance(i, dict) else i) for i in items
                     if not isinstance(i, dict) or i["category"] not in ("outerwear", "socks", "accessory"))


def recommend(items, occasion, temp, rainy, on: date, seed, outerwear_below=16.0, count=3,
              rules=None, history=None, classic=True, discarded=None, library=None, known=None):
    """history: [{"key": frozenset, "rating": int|None, "notes": str}] from logged and saved outfits.
    classic: apply the classic menswear rules. discarded: set of history keys never to suggest.
    library: your kept outfits (with items and stats); up to 2 that suit the day come first.
    known: history keys of every outfit in your list, so new ideas are really new."""
    discarded = discarded or set()
    rng = random.Random(seed)
    active = [i for i in items if not i["archived"] and not i["in_laundry"]]
    by_id = {i["id"]: i for i in active}
    rules = rulebook.active(rules or [], occasion, temp)

    target = target_warmth(temp)
    need_outer = rainy or (temp is not None and temp < outerwear_below)
    base_target = max(1, target - 1) if need_outer else target
    o_target = outer_target(temp)
    can_layer = temp is None or temp < 18
    can_blazer = temp is None or temp < 25

    def pool(cat, tgt, keep, as_layer=False, formality_of=None):
        scored = []
        for it in active:
            if it["category"] != cat or not rulebook.item_ok(it, rules, as_layer):
                continue
            if as_layer and (it.get("kind") or "") not in LAYER_KINDS:
                continue
            f = formality_of(it) if formality_of else None
            sc = _item_score(it, tgt, occasion, on, rainy, f)
            if sc is not None:
                scored.append((sc + rng.uniform(0, 1.5), it))  # jitter = variety
        # Drop pieces that are far too warm/cold for the day (t-shirt at 2°C),
        # unless that would leave nothing in the category.
        if cat not in ("accessory", "socks"):
            suitable = [p for p in scored if abs(p[1]["warmth"] - tgt) < 3]
            scored = suitable or scored
        scored.sort(key=lambda x: x[0], reverse=True)
        return scored[:keep]

    under_kinds = {k for r in rules if r["type"] == "under" for k in r["kinds"]}
    pools = {
        "top": [p for p in pool("top", base_target, 8) if (p[1].get("kind") or "") not in under_kinds][:6],
        "layer": pool("top", base_target, 4, as_layer=True) if can_layer else [],
        "bottom": pool("bottom", base_target, 6),
        "dress": pool("dress", base_target, 6),
        # a blazer alone counts one step less formal than as part of its suit
        "suit": pool("suit", base_target, 4, formality_of=lambda it: max(1, it["formality"] - 1)) if can_blazer else [],
        "outerwear": pool("outerwear", o_target, 4),
        "shoes": pool("shoes", base_target, 5),
        "accessory": pool("accessory", base_target, 6),
        "socks": pool("socks", base_target, 8),
    }

    def fine(its):
        return not (rules and rulebook.broken(its, rules)) and not (classic and menswear.broken(its, occasion, temp))

    # scores of a jacket worn with its own trousers (full formality)
    suit_scores = {}
    for _, jacket in pools["suit"]:
        sc = _item_score(jacket, base_target, occasion, on, rainy)
        if sc is not None:
            suit_scores[jacket["id"]] = sc + rng.uniform(0, 1.5)
        mate = by_id.get(jacket.get("match_id"))
        # make sure the matching trousers are on the table
        if (mate and mate["category"] == "bottom" and rulebook.item_ok(mate, rules)
                and all(p[1]["id"] != mate["id"] for p in pools["bottom"])):
            sc = _item_score(mate, base_target, occasion, on, rainy)
            if sc is not None:
                pools["bottom"].append((sc, mate))
    # a pair-only bottom whose jacket can't come along is out
    pools["bottom"] = [p for p in pools["bottom"] if not (
        p[1].get("pair_only") and not any(j["id"] == p[1].get("match_id") for _, j in pools["suit"]))]
    pools["suit"] = [p for p in pools["suit"] if p[1]["id"] in suit_scores or not p[1].get("pair_only")]

    has_outer = bool(pools["outerwear"])
    result = {
        "temp": temp,
        "rainy": rainy,
        "need_outerwear": need_outer,
        "headline": _headline(temp, rainy, need_outer, has_outer),
        "outfits": [],
        "message": "",
    }

    def key_piece(its):
        return next((i["id"] for i in its if i["category"] in ("top", "dress")), its[0]["id"])

    def add_socks(its):
        """The best-matching pair of socks that keeps the outfit within the rules (or none)."""
        if any(i["category"] == "socks" for i in its):
            return its
        ranked = sorted(pools["socks"], reverse=True,
                        key=lambda p: p[0] + (menswear.sock_score(p[1], its, occasion, temp) * 2 if classic else 0))
        for _, sock in ranked:
            if fine(its + [sock]):
                return its + [sock]
        return its

    # ---- 1. your own outfits that suit today ----
    mine = []
    want_mine = min(2, max(0, count - 1))
    if library and want_mine:
        cand = []
        for lo in library:
            its = [by_id.get(i["id"]) for i in lo["items"]]
            if not its or any(x is None for x in its):
                continue  # a piece is in the wash or archived
            if lo.get("occasion") and lo["occasion"] != occasion:
                continue
            forms = [x["formality"] for x in its if x["category"] not in ("accessory", "socks")]
            if not lo.get("occasion") and forms and abs(sum(forms) / len(forms) - occasion) >= 0.75:
                continue
            wear_its, notes = list(its), []
            if not need_outer and temp is not None and any(x["category"] == "outerwear" for x in its):
                wear_its = [x for x in its if x["category"] != "outerwear"]
                notes.append("Coat left at home: it's mild enough without.")
            scores, fits = [], True
            for x in wear_its:
                tgt = o_target if x["category"] == "outerwear" else base_target
                if x["category"] not in ("accessory", "socks") and abs(x["warmth"] - tgt) >= 3:
                    fits = False
                    break
                sc = _item_score(x, tgt, occasion, on, rainy)
                scores.append(-2.0 if sc is None else sc)
            if not fits or not scores or not fine(wear_its):
                continue
            total = sum(scores) / len(scores) + ((lo.get("avg_rating") or 3) - 3) * 0.4 + rng.uniform(0, 1.0)
            cand.append((total, lo, wear_its, notes))
        cand.sort(key=lambda c: c[0], reverse=True)
        for total, lo, its, notes in cand:
            if len(mine) >= want_mine:
                break
            if any(key_piece(its) == m["key"] for m in mine):
                continue
            if need_outer and not any(x["category"] == "outerwear" for x in its):
                for _, coat in pools["outerwear"]:
                    if fine(its + [coat]):
                        its = its + [coat]
                        notes.append(f"Added the {coat['name']} for the weather.")
                        break
            its = add_socks(its)
            mine.append({"key": key_piece(its), "items": its, "score": total, "lo": lo, "notes": notes})

    def mine_out(m):
        lo = m["lo"]
        notes = ([f"Your note: “{lo['notes'][:200]}”"] if lo.get("notes") else []) + m["notes"]
        return {"items": _order(m["items"]), "score": round(m["score"], 2), "notes": notes, "source": "mine",
                "library_id": lo["id"], "name": lo.get("name") or "", "times_worn": lo.get("times_worn") or 0,
                "last_worn": lo.get("last_worn"), "avg_rating": lo.get("avg_rating")}

    want_ideas = count - len(mine)
    known = known or set()

    def finish(message):
        result["outfits"] = [mine_out(m) for m in mine]
        if not mine:
            result["message"] = message
        return result

    # ---- 2. new ideas ----
    bases = []
    if pools["top"] and pools["bottom"]:
        bases.append(("top", [None] + pools["layer"]))
    if pools["dress"]:
        bases.append(("dress", [None]))
    if not bases:
        if not any(i["category"] in ("top", "bottom", "dress") for i in items if not i["archived"]):
            return finish("Add at least one top and one bottom (or a dress) to get suggestions.")
        if rules or classic:
            return finish("No outfit fits your rules for this occasion and weather. Check Settings → "
                          "Outfit rules, or the types of your clothes.")
        return finish("Not enough clean pieces that suit this occasion. Try another occasion or clear your laundry.")

    shoes = pools["shoes"] or [None]
    outers = pools["outerwear"] if need_outer and has_outer else [None]
    jackets = [None] + pools["suit"]
    hist = {}
    for h in history or []:
        hist.setdefault(h["key"], h)  # newest first
    mine_keys = {history_key(m["items"]) for m in mine}

    combos = []
    for kind, layers in bases:
        main = pools["top"] if kind == "top" else pools["dress"]
        bottoms = pools["bottom"] if kind == "top" else [None]
        for picks in product(main, layers, bottoms, jackets, shoes, outers):
            chosen = [p for p in picks if p is not None]
            its = [p[1] for p in chosen]
            if len({i["id"] for i in its}) < len(its):
                continue  # the same sweater as base and layer
            scores = [p[0] for p in chosen]
            forms = [i["formality"] for i in its]
            bonus = 0.0
            suited = None
            jacket = picks[3][1] if picks[3] else None
            bottom = picks[2][1] if picks[2] else None
            if jacket is not None:
                j = its.index(jacket)
                if bottom is not None and jacket.get("match_id") == bottom["id"]:
                    if jacket["id"] not in suit_scores:
                        continue
                    scores[j] = suit_scores[jacket["id"]]
                    bonus += 0.8
                    suited = (jacket, bottom)
                else:
                    if jacket.get("pair_only"):
                        continue
                    forms[j] = max(1, jacket["formality"] - 1)
            if bottom is not None and bottom.get("pair_only") and not (jacket and jacket["id"] == bottom.get("match_id")):
                continue
            key = history_key(its)
            # new ideas only: nothing you rejected, already have, or just got from your own outfits
            if key in discarded or key in known or key in mine_keys or not fine(its):
                continue
            past = hist.get(key)
            if past and past.get("rating"):
                bonus += 0.6 if past["rating"] >= 4 else (-1.2 if past["rating"] <= 2 else 0)
            total = (sum(scores) / len(scores) + _harmony(its) - 0.5 * (max(forms) - min(forms))
                     + bonus + rng.uniform(0, 0.4))
            combos.append((total, its, suited, past))
    combos.sort(key=lambda c: c[0], reverse=True)

    if not combos:
        return finish("No new outfit fits your rules for this occasion and weather (or you've already kept or "
                      "rejected them all). Check Settings → Outfit rules, or the types of your clothes.")

    chosen = []
    taken = [m["key"] for m in mine]
    for strict in (True, False):
        for total, its, suited, past in combos:
            if len(chosen) >= want_ideas:
                break
            ids = {i["id"] for i in its}
            if any(ids == c["ids"] for c in chosen):
                continue
            if strict and (key_piece(its) in taken or any(
                    key_piece(its) == c["key"] or len(ids & c["ids"]) > 2 for c in chosen)):
                continue
            chosen.append({"ids": ids, "key": key_piece(its), "items": its, "score": total,
                           "suited": suited, "past": past})

    for c in chosen:
        c["items"] = add_socks(c["items"])

    used_acc = set()
    for c in chosen:
        for sc, acc in pools["accessory"]:
            if acc["id"] not in used_acc and sc > -1 and fine(c["items"] + [acc]):
                c["items"] = c["items"] + [acc]
                used_acc.add(acc["id"])
                break

    out = [mine_out(m) for m in mine]
    for c in chosen:
        notes = _notes(c["items"], on)
        if c["suited"]:
            notes.insert(0, f"Worn as a suit: {c['suited'][0]['name']} with {c['suited'][1]['name']}.")
        past = c["past"]
        if past:
            if past.get("notes"):
                notes.insert(0, f"Your note: “{past['notes'][:200]}”")
            if past.get("rating"):
                notes.append(f"You rated this {past['rating']}★ last time.")
        out.append({"items": _order(c["items"]), "score": round(c["score"], 2), "notes": notes, "source": "idea"})
    result["outfits"] = out
    return result
