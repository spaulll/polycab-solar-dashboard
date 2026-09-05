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

TOMORROW_TTL: float = float(3600)  # 1 hour

_tomorrow_cache: dict = {"data": None, "fetched_at": 0.0}

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
# Tomorrow estimate (provider-agnostic daylight derate of the typical day)
# ---------------------------------------------------------------------------
def _tomorrow_daylight_window(tomorrow_local):
    """(sunrise_aware, sunset_aware) for tomorrow via inverter sun math."""
    import inverter as _inv  # deferred: avoids import cycles at module load
    info = _inv.get_day_sun(tomorrow_local)
    sunrise = datetime.datetime.fromisoformat(info["sunrise"])
    sunset = datetime.datetime.fromisoformat(info["sunset"])
    return sunrise, sunset


def _tomorrow_typical():
    """(typical_total_kwh|None, day_count) from the 15-min typical-day curve."""
    import solar as _solar  # deferred: solar imports database/inverter
    try:
        proj = _solar.get_today_projection()
    except Exception:
        return None, 0
    typical = proj.get("typical_total_kwh")
    try:
        day_count = int(proj.get("day_count") or 0)
    except (TypeError, ValueError):
        day_count = 0
    if typical is None:
        return None, day_count
    try:
        return float(typical), day_count
    except (TypeError, ValueError):
        return None, day_count


def _derate_expected(typical_kwh: float, cloud_frac: float, pop_frac: float):
    """
    Shared method (both providers):
        expected = typical_total x (1 - 0.7 x cloud_frac) - rain_penalty,
        clamped >= 0, where rain_penalty = typical_total x 0.3 x pop_frac.
    """
    try:
        rain_penalty = typical_kwh * 0.3 * max(0.0, min(1.0, float(pop_frac)))
        expected = typical_kwh * (1.0 - 0.7 * max(0.0, min(1.0, float(cloud_frac)))) - rain_penalty
    except (TypeError, ValueError):
        return None
    return max(0.0, expected)


def _tomorrow_via_open_meteo(tomorrow_local, sunrise, sunset, typical_kwh):
    """Mean daylight cloud/pop for tomorrow via Open-Meteo hourly."""
    try:
        from zoneinfo import ZoneInfo as _ZI
    except ImportError:
        _ZI = None
    try:
        tz = _ZI(config.TIMEZONE) if _ZI is not None else None
    except Exception:
        tz = None

    day_iso = tomorrow_local.isoformat()
    params = urllib.parse.urlencode({
        "latitude": config.LATITUDE,
        "longitude": config.LONGITUDE,
        "timezone": config.TIMEZONE,
        "hourly": ",".join(["cloud_cover", "precipitation_probability", "shortwave_radiation"]),
        "start_date": day_iso,
        "end_date": day_iso,
    })
    data = _http_get_json(f"https://api.open-meteo.com/v1/forecast?{params}")
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    clouds = hourly.get("cloud_cover") or []
    pops = hourly.get("precipitation_probability") or []

    c_vals, p_vals = [], []
    for i, t in enumerate(times):
        try:
            # Hourly times are location-local ISO without offset.
            naive = datetime.datetime.fromisoformat(t)
            aware = naive.replace(tzinfo=tz) if tz is not None else naive.replace(tzinfo=datetime.timezone.utc)
        except (TypeError, ValueError):
            continue
        # Compare in a common frame (UTC) so naive-vs-aware never slips.
        try:
            a_utc = aware.astimezone(datetime.timezone.utc) if aware.tzinfo is not None else aware
            sr_utc = sunrise.astimezone(datetime.timezone.utc)
            ss_utc = sunset.astimezone(datetime.timezone.utc)
        except Exception:
            continue
        if not (sr_utc <= a_utc <= ss_utc):
            continue
        try:
            if i < len(clouds) and clouds[i] is not None:
                c_vals.append(float(clouds[i]))
            if i < len(pops) and pops[i] is not None:
                p_vals.append(float(pops[i]))
        except (TypeError, ValueError):
            continue
    if not c_vals:
        return None
    cloud_frac = (sum(c_vals) / len(c_vals)) / 100.0
    pop_frac = (sum(p_vals) / len(p_vals) / 100.0) if p_vals else 0.0
    expected = _derate_expected(typical_kwh, cloud_frac, pop_frac)
    if expected is None:
        return None
    return {
        "cloud_pct": round(cloud_frac * 100.0, 1),
        "pop": round(pop_frac * 100.0, 1),
        "expected_kwh": round(expected, 2),
        "provider": "open-meteo",
    }


def _tomorrow_via_owm(tomorrow_local, sunrise, sunset, typical_kwh):
    """Mean daylight cloud/pop for tomorrow via OWM 3-hour forecast."""
    lat, lon = config.LATITUDE, config.LONGITUDE
    key = config.OPENWEATHER_API_KEY
    if not key:
        return None
    base = "https://api.openweathermap.org"
    fc = _http_get_json(
        f"{base}/data/2.5/forecast?lat={lat}&lon={lon}&appid={key}&units=metric")

    city_offset = ((fc.get("city") or {}).get("timezone", 0)) or 0
    try:
        sr_epoch = sunrise.timestamp()
        ss_epoch = sunset.timestamp()
    except Exception:
        return None

    c_vals, p_vals = [], []
    for entry in fc.get("list", []) or []:
        try:
            dt_epoch = int(entry.get("dt", 0))
        except (TypeError, ValueError):
            continue
        # City-local date (epoch + offset pattern already used in code).
        local_date = datetime.datetime.fromtimestamp(
            dt_epoch + city_offset, datetime.timezone.utc).date()
        if local_date != tomorrow_local:
            continue
        if not (sr_epoch <= dt_epoch <= ss_epoch):
            continue
        try:
            clouds = (entry.get("clouds") or {}).get("all")
            if clouds is not None:
                c_vals.append(float(clouds))
            pop = entry.get("pop", 0)
            p_vals.append(float(pop) * 100.0 if float(pop) <= 1.0 else float(pop))
        except (TypeError, ValueError):
            continue
    if not c_vals:
        return None
    cloud_frac = (sum(c_vals) / len(c_vals)) / 100.0
    # OWM pop is 0..1 fraction; normalize defensively (already x100 above).
    pop_mean = (sum(p_vals) / len(p_vals)) if p_vals else 0.0
    pop_frac = (pop_mean / 100.0) if pop_mean > 1.0 else pop_mean
    expected = _derate_expected(typical_kwh, cloud_frac, pop_frac)
    if expected is None:
        return None
    return {
        "cloud_pct": round(cloud_frac * 100.0, 1),
        "pop": round(pop_frac * 100.0, 1),
        "expected_kwh": round(expected, 2),
        "provider": "openweathermap",
    }


def get_tomorrow_estimate(force: bool = False) -> dict:
    """
    Expected tomorrow kWh via provider-agnostic daylight derate of the
    typical day: expected = typical_total x (1 - 0.7 x cloud_frac) -
    rain_penalty, clamped >= 0 (rain_penalty = typical_total x 0.3 x pop).

    Daylight-only: forecast hours filtered to tomorrow's sunrise->sunset
    from inverter.get_day_sun(tomorrow) so night clouds don't dilute.
    day_count < 3 -> expected None -> UI hides (same honesty rule as pace).
    1h TTL. Never raises for provider issues — returns nulls so the UI can
    degrade to `collecting data…` instead of erroring.
    """
    if not force and _tomorrow_cache["data"] is not None \
            and (time.monotonic() - _tomorrow_cache["fetched_at"]) < TOMORROW_TTL:
        return _tomorrow_cache["data"]

    # Tomorrow in the configured location (not the server's system date).
    try:
        import inverter as _inv
        tz = _inv.local_tz()
        today_local = datetime.datetime.now(tz).date()
        tomorrow_local = today_local + datetime.timedelta(days=1)
    except Exception:
        tomorrow_local = datetime.date.today() + datetime.timedelta(days=1)

    typical_kwh, day_count = _tomorrow_typical()
    date_iso = tomorrow_local.isoformat()

    def _nulls(provider=None):
        return {
            "date": date_iso,
            "expected_kwh": None,
            "typical_kwh": round(typical_kwh, 2) if typical_kwh is not None else None,
            "cloud_pct": None,
            "pop": None,
            "provider": provider,
            "day_count": day_count,
        }

    # Not enough history to call any day "typical".
    if day_count < 3 or typical_kwh is None:
        data = _nulls(provider=None)
        _tomorrow_cache["data"] = data
        _tomorrow_cache["fetched_at"] = time.monotonic()
        return data

    try:
        sunrise, sunset = _tomorrow_daylight_window(tomorrow_local)
    except Exception as e:
        print(f"[FORECAST] sun window failed: {e!r}")
        data = _nulls(provider=None)
        _tomorrow_cache["data"] = data
        _tomorrow_cache["fetched_at"] = time.monotonic()
        return data

    result = None
    # OWM primary when keyed, Open-Meteo fallback (works keyed AND unkeyed).
    if config.OPENWEATHER_API_KEY:
        try:
            result = _tomorrow_via_owm(tomorrow_local, sunrise, sunset, typical_kwh)
        except Exception as e:
            print(f"[FORECAST] openweathermap tomorrow failed: {e!r}")
            result = None
        if result is None:
            try:
                result = _tomorrow_via_open_meteo(tomorrow_local, sunrise, sunset, typical_kwh)
            except Exception as e:
                print(f"[FORECAST] open-meteo fallback failed: {e!r}")
                result = None
    else:
        try:
            result = _tomorrow_via_open_meteo(tomorrow_local, sunrise, sunset, typical_kwh)
        except Exception as e:
            print(f"[FORECAST] open-meteo tomorrow failed: {e!r}")
            result = None

    if result is None:
        data = _nulls(provider=None)
    else:
        data = {
            "date": date_iso,
            "expected_kwh": result["expected_kwh"],
            "typical_kwh": round(typical_kwh, 2),
            "cloud_pct": result["cloud_pct"],
            "pop": result["pop"],
            "provider": result["provider"],
            "day_count": day_count,
        }
    _tomorrow_cache["data"] = data
    _tomorrow_cache["fetched_at"] = time.monotonic()
    return data


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
