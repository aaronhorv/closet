"""Remove photo backgrounds on the server with the u2net model (free, no AI tokens).

The model file is baked into the Docker image. Without it (e.g. local development
without the download) the feature is simply turned off.
"""
import os
import threading

from PIL import Image

MODEL_PATH = os.environ.get("CUTOUT_MODEL", "/srv/models/u2net.onnx")
SIZE = 320                       # u2net's input size
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)
IDLE_UNLOAD = 120                # seconds; the model holds ~500 MB of memory while loaded
MAX_SIDE = 1000                  # output size
PAD = 0.06                       # space around the item, as a share of the canvas

_session = None
_lock = threading.Lock()
_timer = None


class CutoutError(Exception):
    """A short, user-facing message."""


def available() -> bool:
    return os.path.isfile(MODEL_PATH)


def _unload():
    global _session
    with _lock:
        _session = None


def _get_session():
    global _session, _timer
    with _lock:
        if _session is None:
            import onnxruntime as ort
            _session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
        if _timer is not None:
            _timer.cancel()
        _timer = threading.Timer(IDLE_UNLOAD, _unload)
        _timer.daemon = True
        _timer.start()
        return _session


def _mask(img: Image.Image) -> Image.Image:
    import numpy as np

    sess = _get_session()
    x = np.asarray(img.convert("RGB").resize((SIZE, SIZE), Image.Resampling.LANCZOS), dtype=np.float32)
    x = x / max(float(x.max()), 1e-6)
    x = (x - np.array(MEAN, dtype=np.float32)) / np.array(STD, dtype=np.float32)
    x = x.transpose(2, 0, 1)[None].astype(np.float32)
    pred = sess.run(None, {sess.get_inputs()[0].name: x})[0][0, 0]
    if float(pred.max()) < 0.5:
        # the model isn't sure anything is there (blank or very busy photo)
        raise CutoutError("Couldn't find a clear item in this photo.")
    pred = (pred - pred.min()) / max(float(pred.max() - pred.min()), 1e-6)
    # firm up the edges a little so faint haze around the item disappears
    pred = ((pred - 0.08) / 0.84).clip(0, 1)
    m = Image.fromarray((pred * 255).astype("uint8"), "L")
    return m.resize(img.size, Image.Resampling.LANCZOS)


def remove_background(img: Image.Image) -> Image.Image:
    """Return the item cut out, centered on a transparent square canvas."""
    if not available():
        raise CutoutError("Background removal isn't available on this server.")
    img = img.convert("RGB")
    try:
        mask = _mask(img)
    except CutoutError:
        raise
    except Exception:
        raise CutoutError("Background removal failed for this photo.")
    solid = mask.point(lambda v: 255 if v > 127 else 0)
    coverage = solid.histogram()[255] / (mask.width * mask.height)
    box = mask.point(lambda v: 255 if v > 24 else 0).getbbox()
    if not box or coverage < 0.02:
        # nothing clear to cut out (e.g. a plain or very busy photo): keep the original
        raise CutoutError("Couldn't find a clear item in this photo.")
    rgba = img.copy()
    rgba.putalpha(mask)
    item = rgba.crop(box)
    w, h = item.size
    side = int(max(w, h) / (1 - 2 * PAD))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(item, ((side - w) // 2, (side - h) // 2))
    if side > MAX_SIDE:
        canvas = canvas.resize((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
    return canvas
