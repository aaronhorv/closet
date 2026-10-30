"""Weather lookups via Open-Meteo (free, no API key)."""
import json
import time
import urllib.parse
import urllib.request

_CACHE: dict = {}
_TTL = 1800  # seconds

CODES = {
    0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Showers", 81: "Showers", 82: "Heavy showers",
    85: "Snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm",
}
WET_CODES = set(range(51, 68)) | set(range(71, 78)) | set(range(80, 87)) | {95, 96, 99}


def _get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "closet-app"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.load(resp)


def forecast(lat: float, lon: float) -> dict:
    key = (round(lat, 2), round(lon, 2))
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]

    query = urllib.parse.urlencode({
        "latitude": lat,
        "longitude": lon,
        "daily": "temperature_2m_max,temperature_2m_min,apparent_temperature_max,"
                 "apparent_temperature_min,precipitation_probability_max,weather_code",
        "current": "temperature_2m,apparent_temperature,weather_code",
        "timezone": "auto",
        "forecast_days": 3,
    })
    data = _get("https://api.open-meteo.com/v1/forecast?" + query)

    d = data["daily"]
    days = []
    for i, day in enumerate(d["time"]):
        tmax, tmin = d["temperature_2m_max"][i], d["temperature_2m_min"][i]
        fmax, fmin = d["apparent_temperature_max"][i], d["apparent_temperature_min"][i]
        hi = fmax if fmax is not None else tmax
        lo = fmin if fmin is not None else tmin
        # Weight toward the daytime high: that's when you're out and about.
        effective = None if hi is None or lo is None else round((lo + 2 * hi) / 3, 1)
        code = d["weather_code"][i]
        precip = d["precipitation_probability_max"][i]
        days.append({
            "date": day,
            "temp_max": tmax,
            "temp_min": tmin,
            "effective": effective,
            "precip_prob": precip,
            "code": code,
            "summary": CODES.get(code, ""),
            "rainy": code in WET_CODES or (precip is not None and precip >= 50),
        })

    cur = data.get("current") or {}
    result = {
        "days": days,
        "current": {
            "temp": cur.get("temperature_2m"),
            "feels": cur.get("apparent_temperature"),
            "summary": CODES.get(cur.get("weather_code"), ""),
        },
    }
    _CACHE[key] = (time.time(), result)
    return result


def geocode(name: str) -> list:
    query = urllib.parse.urlencode({"name": name, "count": 6, "language": "en", "format": "json"})
    data = _get("https://geocoding-api.open-meteo.com/v1/search?" + query)
    out = []
    for r in data.get("results") or []:
        label = ", ".join(x for x in (r.get("name"), r.get("admin1"), r.get("country")) if x)
        out.append({"name": r.get("name"), "label": label,
                    "lat": r.get("latitude"), "lon": r.get("longitude")})
    return out
