# Closet

A small self-hosted closet tracker and outfit recommender. It runs as one Docker container with a SQLite database, and the web page works well on a phone.

## What it does

- **Closet**: add clothes with a photo, category, main and second color, pattern, material, fit, brand, warmth (1–5) and formality (casual / smart casual / formal). Mark things as in the laundry, favorite them, or archive them.
- **Clean photos**: backgrounds are removed on your server when you add a photo (free, no AI or key needed). The original is kept, so "Restore original photo" undoes it. Settings → "Remove background from all photos" cleans up existing ones. Works best on a plain or tidy background.
- **Add many at once**: for the first setup, tap "Add many" on the Closet tab (or drop several photos on it) and pick up to 50 photos. Each becomes an item; check the names and categories, then "Save". With AI on, every photo is filled in automatically (roughly $0.002 per photo with the default model).
- **Drag and drop**: drop a photo onto the photo box in "Add item", or paste a copied image with Ctrl+V.
- **Brand picker**: start typing and pick from brands you've used before, or add a new one.
- **Add from a shop link**: paste a product page link in "Add item" and the app fills in the details and downloads the photo. It works without AI too (it reads the product data most shops put in their pages), but some shops block this.
- **Today**: suggests 3 outfits from clean clothes, using simple rules (no AI):
  - the forecast for your city (free [Open-Meteo](https://open-meteo.com) data, no API key needed)
  - the occasion you pick
  - what you've worn recently (it avoids repeats and brings back neglected pieces)
  - simple color rules (neutrals plus at most one accent color or one patterned piece)
  - your favorites and how you've rated past outfits
  - a jacket when it's cold or wet; items tagged `waterproof` get a boost on rainy days
- **History**: tap "Wear this" to log an outfit, or log one by hand. Rate outfits with stars, and future suggestions take the ratings into account.
- **Outfits** (optional AI, see below): saved outfits, plus AI-made outfits you can save or wear.

## Optional AI features (OpenAI)

Add your OpenAI API key in the app: gear icon → Settings → AI. Use "Test key" to check it, then Save. Get a key at <https://platform.openai.com/api-keys>. Without a key the app works the same, just without these buttons.

The key is stored in the app's database (`data/closet.db`), and the browser only ever sees its last 4 characters. Keep backups of `data/` private, and set `APP_PASSWORD` if others use your network. You can also set `OPENAI_API_KEY` in `.env` instead; a key saved in Settings takes priority.

- **Fill in with AI**: in the Add/Edit item form, after picking a photo. "Add many" does this for every photo automatically. The photo is sent to OpenAI, which fills in name, category, colors, pattern, material, fit, warmth, formality and tags. You check them and save.
- **Shop links get smarter**: with AI on, the page text and photo go to OpenAI, so links fill in every field.
- **Build outfits with this**: open an item in the closet. The AI suggests 3 outfits that include it.
- **Create outfits**: on the Outfits tab. The AI makes 5 outfits from your clean clothes. You can add a note like "work week".
- **Outfit instructions for AI** (gear icon → Settings): your standing style preferences, e.g. "minimal looks, no shorts for work". They're added to every outfit request, on top of the built-in rules.

Only the photo or shop page you're filling in is sent. Outfit building sends item details as text (name, category, colors, pattern, material, fit, brand, warmth, formality, tags, notes, wear count, ratings), never photos. The app only keeps outfits that use real, clean items from your closet.

The default model is `gpt-6.1-terra`. To use another one, pick it in Settings, for example `gpt-6-luna` (cheaper) or `gpt-6.1-sol` (smarter).

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
```

Protect it with `chmod 600 .env`. Then start it:

```bash
docker compose up -d
```

Open `http://<server-ip>:<PORT>` (8080 unless you changed it), tap the gear icon, and set your city. If you set a password, the browser asks for it, and any username works.

The image is built for both amd64 and arm64, so it runs on a regular PC or a Raspberry Pi. It's about 0.5–1 GB because it includes the background-removal model. Removing a background takes about a second on a normal PC (longer on a Pi) and briefly uses about 500 MB of memory, which is freed after 2 minutes of no use.

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
| `OPENAI_API_KEY` | empty | Optional. Fallback OpenAI key; a key saved in Settings wins. |
| `AI_MODEL` | `gpt-6.1-terra` | Optional. Fallback model; a model picked in Settings wins. |
| `PORT` | `8080` | Port on the server. Only used by `docker-compose.yml`. Check it's free with `ss -ltn \| grep -w :8080` (no output = free). |
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
