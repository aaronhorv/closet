"""Read a shop's product page: fetch it safely, pull out product data and the main photo."""
import ipaddress
import json
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from .kinds import CATEGORIES, guess_kind

MAX_PAGE = 3 * 1024 * 1024
MAX_IMAGE = 15 * 1024 * 1024
TIMEOUT = 12
HEADERS = {
    # Many shops refuse requests that don't look like a browser.
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,image/avif,image/webp,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


class PageError(Exception):
    """A short, user-facing message."""


# Reserved for testing; VPN/proxy tools hand these out as stand-in DNS answers for real sites.
FAKE_IP_RANGE = ipaddress.ip_network("198.18.0.0/15")


# ---------- safe fetching ----------

def _check_host(url: str):
    """Only allow http(s) to public addresses, so a link can't reach devices on the home network."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise PageError("That doesn't look like a web link (it should start with https://).")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except (socket.gaierror, UnicodeError):
        raise PageError("Couldn't find that website. Check the link.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global and ip not in FAKE_IP_RANGE:
            raise PageError("Links to local or private addresses aren't allowed.")


class _CheckedRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_CheckedRedirects())


def fetch(url: str, limit: int):
    """Return (final_url, content_type, body bytes)."""
    _check_host(url)
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with _opener.open(req, timeout=TIMEOUT) as resp:
            body = resp.read(limit + 1)
            if len(body) > limit:
                raise PageError("That page is too large to read.")
            return resp.geturl(), resp.headers.get("Content-Type", ""), body
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 429, 503):
            raise PageError("That shop blocks automatic page reading. Add a photo instead.")
        if e.code == 404:
            raise PageError("That page wasn't found (404). Check the link.")
        raise PageError(f"The shop's website returned an error ({e.code}).")
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError):
        raise PageError("Couldn't load that page. Check the link or try again.")


# ---------- parsing ----------

class _Parser(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta, self.ld, self.text, self.title = {}, [], [], ""
        self._stack, self._ld_buf, self._in_ld, self._in_title = [], [], False, False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").lower()
            if key and a.get("content") and key not in self.meta:
                self.meta[key] = a["content"].strip()
        elif tag == "script" and "ld+json" in a.get("type", "").lower():
            self._in_ld, self._ld_buf = True, []
        elif tag == "title":
            self._in_title = True
        if tag in self.SKIP:
            self._stack.append(tag)

    def handle_endtag(self, tag):
        if tag == "script" and self._in_ld:
            self._in_ld = False
            self.ld.append("".join(self._ld_buf))
        if tag == "title":
            self._in_title = False
        if self._stack and self._stack[-1] == tag:
            self._stack.pop()

    def handle_data(self, data):
        if self._in_ld:
            self._ld_buf.append(data)
        elif self._in_title:
            self.title += data
        elif not self._stack:
            t = data.strip()
            if t:
                self.text.append(t)


def _walk(node):
    if isinstance(node, list):
        for n in node:
            yield from _walk(n)
    elif isinstance(node, dict):
        yield node
        for k in ("@graph", "mainEntity", "itemListElement", "hasVariant", "item"):
            if k in node:
                yield from _walk(node[k])


def _is_product(d: dict) -> bool:
    t = d.get("@type")
    types = t if isinstance(t, list) else [t]
    return any(str(x).lower() in ("product", "productgroup", "individualproduct") for x in types)


def _text(v) -> str:
    if isinstance(v, dict):
        v = v.get("name") or v.get("@value") or ""
    if isinstance(v, list):
        v = ", ".join(_text(x) for x in v if _text(x))
    return re.sub(r"\s+", " ", str(v or "")).strip()


def _image(v) -> str:
    if isinstance(v, list):
        v = v[0] if v else ""
    if isinstance(v, dict):
        v = v.get("url") or v.get("contentUrl") or ""
    return str(v or "").strip()


# Checked in order; whole words only (so "bootcut jeans" isn't shoes, "short sleeve" isn't shorts).
CATEGORY_WORDS = [
    ("socks", r"\b(socks?|no-show)\b"),
    ("dress", r"\b(dress|dresses|jumpsuits?|playsuits?|rompers?|gowns?)\b"),
    ("suit", r"\b(blazers?|suit jackets?|sport ?coats?|waistcoats?|sakkos?)\b"),
    ("outerwear", r"\b(jackets?|coats?|topcoats?|overcoats?|raincoats?|parkas?|anoraks?|gilets?|trench|bombers?|puffers?|windbreakers?|overshirts?|shackets?)\b"),
    ("shoes", r"\b(shoes?|sneakers?|trainers?|boots?|loafers?|sandals?|heels?|pumps|mules|derbys?|derbies|espadrilles?|slippers?|clogs?|brogues?)\b"),
    ("bottom", r"\b(jeans|trousers?|pants|chinos?|shorts|skirts?|leggings|joggers?|cargos?|slacks)\b"),
    ("top", r"\b(shirts?|t-shirts?|tees?|tops?|sweaters?|jumpers?|hoodies?|sweatshirts?|cardigans?|polos?|blouses?|tanks?|knits?|pullovers?|turtlenecks?|vests?)\b"),
    ("accessory", r"\b(bags?|belts?|hats?|caps?|beanies?|scarf|scarves|ties?|watch|necklaces?|bracelets?|earrings?|rings?|sunglasses|gloves?|wallets?|backpacks?|totes?)\b"),
]
PATTERN_WORDS = [
    ("striped", r"\b(stripe|striped|pinstripe|breton)"),
    ("checked", r"\b(check|checked|plaid|gingham|tartan|houndstooth)"),
    ("floral", r"\b(floral|flower)"),
    ("print", r"\b(print|printed|graphic|logo|leopard|camo|paisley|polka)"),
]


def _guess(words: str, table, default=""):
    w = words.lower()
    for value, rx in table:
        if re.search(rx, w):
            return value
    return default


def parse(html: str, base_url: str) -> dict:
    """Pull product facts out of a page. Returns basic fields, an image URL and text for the AI."""
    p = _Parser()
    try:
        p.feed(html)
    except Exception:
        pass

    product = {}
    for raw in p.ld:
        try:
            data = json.loads(raw.strip())
        except ValueError:
            continue
        for node in _walk(data):
            if _is_product(node):
                product = node
                break
        if product:
            break

    m = p.meta
    name = _text(product.get("name"))
    if not name:
        # page titles often end with " | Shop name"
        name = (m.get("og:title") or m.get("twitter:title") or p.title.strip()).split(" | ")[0].strip()
    brand = _text(product.get("brand")) or m.get("product:brand") or m.get("og:brand") or ""
    color = _text(product.get("color")) or m.get("product:color") or ""
    material = _text(product.get("material")) or m.get("product:material") or ""
    pattern = _text(product.get("pattern")) or m.get("product:pattern") or ""
    desc = _text(product.get("description")) or m.get("og:description") or m.get("description") or ""
    image = _image(product.get("image")) or m.get("og:image") or m.get("og:image:url") or m.get("twitter:image") or ""
    if image:
        image = urllib.parse.urljoin(base_url, image)

    words = f"{name} {_text(product.get('category'))} {m.get('product:category', '')}"
    basic = {
        "name": name[:120],
        "brand": brand[:80],
        "color": color.lower()[:40],
        "material": material.lower()[:60],
        "pattern": _guess(f"{pattern} {name}", PATTERN_WORDS),
        "category": _guess(words, CATEGORY_WORDS),
    }

    facts = [f"{k}: {v}" for k, v in (("Shop", m.get("og:site_name", "")), ("Page title", p.title.strip()),
                                      ("Product", name), ("Brand", brand),
                                      ("Color", color), ("Material", material), ("Pattern", pattern),
                                      ("Description", desc)) if v]
    body = re.sub(r"\s+", " ", " ".join(p.text))[:3500]
    page_text = "\n".join(facts) + ("\n\nPage text:\n" + body if body else "")
    return {"basic": basic, "image_url": image, "page_text": page_text, "found": bool(name or product)}


def read_product(url: str) -> dict:
    url = url.strip()
    if url and "://" not in url:
        url = "https://" + url
    final, ctype, body = fetch(url, MAX_PAGE)
    if "html" not in ctype.lower() and not body.lstrip()[:15].lower().startswith((b"<!doctype", b"<html")):
        raise PageError("That link isn't a web page.")
    charset = re.search(r"charset=([\w-]+)", ctype)
    try:
        html = body.decode(charset.group(1) if charset else "utf-8", errors="replace")
    except LookupError:
        html = body.decode("utf-8", errors="replace")
    info = parse(html, final)
    if not info["found"]:
        raise PageError("Couldn't find product details on that page.")
    info["image"] = None
    if info["image_url"]:
        try:
            _, ictype, img = fetch(info["image_url"], MAX_IMAGE)
            info["image"] = img
        except PageError:
            pass  # the details are still useful without the photo
    return info


def guess_defaults(basic: dict) -> dict:
    """Fill the form without AI: page facts plus safe defaults."""
    out = {k: v for k, v in basic.items() if v}
    if out.get("category") not in CATEGORIES:
        out.pop("category", None)  # unknown: the form keeps what's selected
    else:
        kind = guess_kind(out.get("name", ""), out["category"])
        if kind:
            out["kind"] = kind
    return out
