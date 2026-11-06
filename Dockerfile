# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    CUTOUT_MODEL=/srv/models/u2net.onnx

WORKDIR /srv

# Background-removal model (u2net, ~170 MB). Baked in so it works offline; checksum-verified.
ADD --checksum=sha256:8d10d2f3bb75ae3b6d527c77944fc5e7dcd94b29809d47a739a7a728a912b491 \
    https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx /srv/models/u2net.onnx

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4)" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
