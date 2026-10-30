# Closet

A small self-hosted closet tracker and outfit recommender. It runs as one Docker container with a SQLite database, and the web page works well on a phone.

## What it does

- **Closet**: add clothes with a photo, category, main color, brand, warmth (1–5) and formality (casual / smart casual / formal). Mark things as in the laundry, favorite them, or archive them.
- **Today**: suggests 3 outfits from clean clothes, using simple rules (no AI):
  - the forecast for your city (free [Open-Meteo](https://open-meteo.com) data, no API key needed)
  - the occasion you pick
  - what you've worn recently (it avoids repeats and brings back neglected pieces)
  - simple color rules (neutrals plus at most one accent color)
  - your favorites and how you've rated past outfits
  - a jacket when it's cold or wet; items tagged `waterproof` get a boost on rainy days
- **History**: tap "Wear this" to log an outfit, or log one by hand. Rate outfits with stars, and future suggestions take the ratings into account.
- **Outfits** (optional AI, see below): saved outfits, plus AI-made outfits you can save or wear.

## Optional AI features (OpenAI)

Set `OPENAI_API_KEY` to turn these on. Without it the app works the same, just without these buttons.

- **Fill in with AI**: in the Add/Edit item form, after picking a photo. The photo is sent to OpenAI, which fills in name, category, color, warmth, formality and tags. You check them and save.
- **Build outfits with this**: open an item in the closet. The AI suggests 3 outfits that include it.
- **Create outfits**: on the Outfits tab. The AI makes 5 outfits from your clean clothes. You can add a note like "work week".
- **Outfit instructions for AI** (gear icon → Settings): your standing style preferences, e.g. "minimal looks, no shorts for work". They're added to every outfit request, on top of the built-in rules.

Only the photo you're filling in is sent. Outfit building sends item details as text (name, category, color, brand, warmth, formality, tags, notes, wear count, ratings), never photos. The app only keeps outfits that use real, clean items from your closet.

The default model is `gpt-6.1-terra`. To use another one, set `AI_MODEL`, for example `gpt-6-luna` (cheaper) or `gpt-6.1-sol` (smarter). Get a key at <https://platform.openai.com/api-keys>.

## Set up on your server

You need Docker with the compose plugin. Check with `docker compose version`.

```bash
mkdir -p ~/closet && cd ~/closet
curl -O https://raw.githubusercontent.com/aaronhorv/closet/main/docker-compose.yml
```

Optionally create a `.env` file in the same folder:

```
PORT=8080
APP_PASSWORD=choose-something-long
OPENAI_API_KEY=sk-...
AI_MODEL=
```

Protect it with `chmod 600 .env`. Then start it:

```bash
docker compose up -d
```

Open `http://<server-ip>:<PORT>` (8080 unless you changed it), tap the gear icon, and set your city. If you set a password, the browser asks for it, and any username works.

The image is built for both amd64 and arm64, so it runs on a regular PC or a Raspberry Pi.

**Tip:** on your phone, use "Add to Home Screen" so it opens like an app.

**If `docker compose up` says "denied" or "unauthorized"**, the image on GitHub is still private. On GitHub go to your profile → Packages → closet → Package settings → Change visibility → Public.

## Updating

```bash
cd ~/closet
docker compose pull
docker compose up -d
```

Your data in `./data` is kept. Every push to `main` builds a new `latest` image. To pin a version instead, tag a release (`git tag v1.0.0 && git push --tags`) and use `ghcr.io/aaronhorv/closet:1.0.0` in `docker-compose.yml`.

## Your data

Everything lives in `./data` next to `docker-compose.yml`:

- `closet.db`: the SQLite database
- `photos/`: resized JPEG photos (max 1200px)

To back up, copy that folder (ideally with the container stopped: `docker compose stop`). To move servers, copy `docker-compose.yml`, `.env` and `data/`.

## Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `APP_PASSWORD` | empty (no password) | Asks for a password in the browser. `/healthz` stays open for health checks. |
| `OPENAI_API_KEY` | empty (AI off) | Turns on the AI features. |
| `AI_MODEL` | `gpt-6.1-terra` | OpenAI model for the AI features. |
| `PORT` | `8080` | Port on the server. Only used by `docker-compose.yml`. Check it's free with `ss -ltn | grep -w :8080` (no output = free). |
| `DATA_DIR` | `/data` | Where the database and photos go inside the container. |

## Run without Docker (for development)

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt        # Windows: .venv\Scripts\pip
DATA_DIR=./data .venv/bin/uvicorn app.main:app --reload --port 8080
```

To build the image locally instead of pulling it: `docker build -t ghcr.io/aaronhorv/closet:latest .`

## How suggestions are scored

See `app/recommender.py`. Each clean item gets a score for warmth vs. the day's feels-like temperature, formality vs. the occasion, days since it was last worn, favorite status, and past ratings. Then whole outfits are scored for color harmony and consistent formality, with a little randomness so "Show different outfits" gives you new ideas. Suggestions stay the same for a given day and occasion until you shuffle.
