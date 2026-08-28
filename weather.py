"""
Weather for the dashboard's configured location (config.LATITUDE /
config.LONGITUDE / config.TIMEZONE).

Provider priority:
  1. OpenWeatherMap (Current Weather + 5-day/3-hour forecast) -- only when
     OPENWEATHER_API_KEY is set and non-empty.
  2. Open-Meteo -- no key required, used whenever OWM is unconfigured or
     fails.

Both providers are normalized into one JSON shape so the frontend never
needs to know which one answered:

    {
      "provider": "openweathermap" | "open-meteo",
      "temp", "feels_like", "humidity", "wind_speed",
      "weather_code", "condition", "icon",
      "cloud_cover", "pop", "high", "low",
      "forecast": [ {time, temp, pop, icon}, ... ],
    }

A small in-memory cache (WEATHER_CACHE_TTL seconds) keeps the endpoint from
hammering the APIs on every dashboard refresh. All network calls are
blocking stdlib urllib -- run them via asyncio.to_thread from the endpoint.
"""
import datetime
import json
import time
import urllib.parse
import urllib.request

import config

CACHE_TTL: float = float(900)   # 15 minutes

_cache: dict = {"data": None, "fetched_at": 0.0}

# Common icon vocabulary shared by both providers' code mappings.
ICONS = ("sun", "partly-cloudy", "cloudy", "fog", "drizzle", "rain",
         "snow", "thunder")


def _http_get_json(url: str, timeout: float = 8.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ---------------------------------------------------------------------------
# Icon mapping
# ---------------------------------------------------------------------------
def _icon_from_open_meteo(code: int, is_day: bool = True) -> str:
    """WMO weather interpretation codes -> common icon set."""
    if not is_day:
        return "partly-cloudy"
    if code == 0:
        return "sun"
    if code in (1, 2):
        return "partly-cloudy"
    if code in (3, 45, 48):
        return "cloudy" if code == 3 else "fog"
    if code in (51, 53, 55, 56, 57):
        return "drizzle"
    if code in (61, 63, 65, 66, 67, 80, 81, 82):
        return "rain"
    if code in (71, 73, 75, 77, 85, 86):
        return "snow"
    if code in (95, 96, 99):
        return "thunder"
    return "cloudy"


def _icon_from_owm(icon_id: str) -> str:
    """OpenWeatherMap icon codes (e.g. '10d') -> common icon set."""
    n = icon_id[:2]
    if icon_id == "01n":
        return "partly-cloudy"
    return {
        "01": "sun",
        "02": "partly-cloudy",
        "03": "cloudy",
        "04": "cloudy",
        "09": "drizzle",
        "10": "rain",
        "11": "thunder",
        "13": "snow",
        "50": "fog",
    }.get(n, "cloudy")


def _condition_from_icon(icon: str) -> str:
    return {
        "sun": "Clear",
        "partly-cloudy": "Partly cloudy",
        "cloudy": "Cloudy",
        "fog": "Foggy",
        "drizzle": "Drizzle",
        "rain": "Rain",
        "snow": "Snow",
        "thunder": "Thunderstorm",
    }.get(icon, "Unknown")


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
def _fetch_open_meteo() -> dict:
    params = urllib.parse.urlencode({
        "latitude": config.LATITUDE,
        "longitude": config.LONGITUDE,
        "timezone": config.TIMEZONE,
        "current": ",".join([
            "temperature_2m", "apparent_temperature", "relative_humidity_2m",
            "wind_speed_10m", "weather_code", "cloud_cover",
            "is_day", "precipitation_probability",
        ]),
        "hourly": ",".join([
            "temperature_2m", "precipitation_probability", "weather_code",
        ]),
        "daily": ",".join(["temperature_2m_max", "temperature_2m_min"]),
        "forecast_days": 3,
        "forecast_hours": 12,
    })
    data = _http_get_json(f"https://api.open-meteo.com/v1/forecast?{params}")

    cur = data["current"]
    hourly = data["hourly"]
    daily = data["daily"]
    now_iso = cur["time"]

    # Next few hours from "now" onward (hourly is already local-time strings).
    forecast = []
    for i, t in enumerate(hourly["time"]):
        if t <= now_iso:
            continue
        forecast.append({
            "time": f"{t}:00",
            "temp": hourly["temperature_2m"][i],
            "pop": hourly["precipitation_probability"][i],
            "icon": _icon_from_open_meteo(hourly["weather_code"][i]),
        })
        if len(forecast) >= 6:
            break

    icon = _icon_from_open_meteo(cur["weather_code"], cur.get("is_day", 1))
    return {
        "provider": "open-meteo",
        "temp": round(cur["temperature_2m"], 1),
        "feels_like": round(cur["apparent_temperature"], 1),
        "humidity": cur["relative_humidity_2m"],
        "wind_speed": round(cur["wind_speed_10m"], 1),
        "weather_code": cur["weather_code"],
        "condition": _condition_from_icon(icon),
        "icon": icon,
        "cloud_cover": cur.get("cloud_cover"),
        "pop": cur.get("precipitation_probability") or 0,
        "high": daily["temperature_2m_max"][0],
        "low": daily["temperature_2m_min"][0],
        "forecast": forecast,
    }


def _fetch_openweathermap() -> dict:
    lat, lon = config.LATITUDE, config.LONGITUDE
    key = config.OPENWEATHER_API_KEY
    base = "https://api.openweathermap.org"

    cur = _http_get_json(
        f"{base}/data/2.5/weather?lat={lat}&lon={lon}&appid={key}&units=metric")
    fc = _http_get_json(
        f"{base}/data/2.5/forecast?lat={lat}&lon={lon}&appid={key}&units=metric")

    tz_offset = cur.get("timezone", 0)

    def _local_hhmm(epoch: int) -> str:
        """City-local HH:MM from a UTC epoch (OWM returns the city offset)."""
        return datetime.datetime.fromtimestamp(
            epoch + tz_offset, datetime.timezone.utc).strftime("%H:%M")

    # Next few 3-hour steps after the current observation.
    forecast = []
    obs_time = cur.get("dt", 0)
    for entry in fc.get("list", []):
        if entry.get("dt", 0) <= obs_time:
            continue
        wicon = (entry.get("weather") or [{}])[0].get("icon", "")
        forecast.append({
            "time": _local_hhmm(entry["dt"]),
            "temp": round(entry["main"]["temp"], 1),
            "pop": round(entry.get("pop", 0) * 100),
            "icon": _icon_from_owm(wicon),
        })
        if len(forecast) >= 6:
            break

    main = cur["main"]
    wind = cur.get("wind", {})
    w = (cur.get("weather") or [{}])[0]
    icon = _icon_from_owm(w.get("icon", ""))

    # Today's high/low from the remaining forecast entries for today.
    today = datetime.datetime.fromtimestamp(
        cur["dt"] + tz_offset, datetime.timezone.utc).date().isoformat()
    highs, lows = [], []
    for entry in fc.get("list", []):
        day = datetime.datetime.fromtimestamp(
            entry["dt"] + tz_offset, datetime.timezone.utc).date().isoformat()
        if day != today:
            continue
        highs.append(entry["main"]["temp_max"])
        lows.append(entry["main"]["temp_min"])

    return {
        "provider": "openweathermap",
        "temp": round(main["temp"], 1),
        "feels_like": round(main.get("feels_like", main["temp"]), 1),
        "humidity": main.get("humidity"),
        "wind_speed": round(wind.get("speed", 0.0), 1),
        "weather_code": w.get("id"),
        "condition": w.get("description", "").capitalize() or _condition_from_icon(icon),
        "icon": icon,
        "cloud_cover": cur.get("clouds", {}).get("all"),
        "pop": round((fc.get("list") or [{}])[0].get("pop", 0) * 100),
        "high": round(max([main["temp_max"], *highs]), 1) if highs else round(main["temp_max"], 1),
        "low": round(min([main["temp_min"], *lows]), 1) if lows else round(main["temp_min"], 1),
        "forecast": forecast,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
class WeatherUnavailableError(Exception):
    """Both providers failed (or none was usable)."""


def get_weather(force: bool = False) -> dict:
    """
    Cached current weather. Raises WeatherUnavailableError when no provider
    could produce a result.
    """
    if not force and _cache["data"] is not None \
            and (time.monotonic() - _cache["fetched_at"]) < CACHE_TTL:
        return _cache["data"]

    errors = []

    if config.OPENWEATHER_API_KEY:
        try:
            data = _fetch_openweathermap()
        except Exception as e:                       # noqa: BLE001 - fallback path
            print(f"[WEATHER] openweathermap failed: {e!r}; falling back to open-meteo")
            errors.append(f"openweathermap: {e}")
            data = None
    else:
        print("[WEATHER] OPENWEATHER_API_KEY not set; using open-meteo")
        data = None

    if data is None:
        try:
            data = _fetch_open_meteo()
        except Exception as e:                       # noqa: BLE001 - reported below
            errors.append(f"open-meteo: {e}")
            raise WeatherUnavailableError("; ".join(errors) or "no provider available") from e

    _cache["data"] = data
    _cache["fetched_at"] = time.monotonic()
    return data
