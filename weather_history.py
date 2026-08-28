"""
Historical daily weather for the Weather Impact panel -- backfill + append.

Source priority (mirrors the live weather chip in weather.py):
  1. OpenWeatherMap One Call 3.0 daily summary (when OPENWEATHER_API_KEY is
     set and non-empty) -- one HTTP call per day, returns cloud_cover /
     precipitation / temperature / sunshine_duration directly.
  2. Open-Meteo Archive API (https://archive-api.open-meteo.com/v1/archive),
     free and key-less -- one HTTP call per chunk of up to MAX_CHUNK_DAYS.

Both providers are normalized into the same per-day row shape; the frontend
never sees which one answered. Same configured LATITUDE / LONGITUDE / TIMEZONE
as the live weather chip (weather.py stays untouched -- it serves "now").

Per local calendar day we store:
    cloud_cover_mean   daily mean of the hourly cloud_cover series (%)
    precip_mm          daily precipitation_sum (mm)
    temp_mean          daily temperature_2m_mean (°C)
    sunshine_fraction  sunshine_duration ÷ astral daylight span -- a
                       location-correct cloudiness proxy robust to metric
                       drift (uses inverter.get_day_sun(), the shared sun
                       math, so no second sunrise/sunset implementation)

The backfill job runs inside the maintenance thread (database.run_maintenance
calls backfill()): it fills every missing day from the DB's first generation
day through YESTERDAY (the archive can serve same-day estimates, so today is
deliberately never requested), one HTTP call per chunk of missing days,
bookkeeping via the meta key `weather_backfilled_through`. Only fully
complete days are ever stored -- a day whose source values are missing is
skipped and retried on a later pass, never estimated. Failures are logged
and left for the next maintenance run.

All SQL lives in database.py; this module owns the HTTP fetch, the response
normalization and the orchestration.
"""
import datetime
import json
import urllib.parse
import urllib.request

import config
import database
import inverter

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
OWM_ONECALL_URL = "https://api.openweathermap.org/data/3.0/onecall/day_summary"

# Longest span per Open-Meteo Archive request. The initial backfill over a
# decade-old DB becomes a handful of requests instead of one giant response.
MAX_CHUNK_DAYS = 366

# Upper bound on chunks per maintenance pass so one cold-start pass stays
# bounded; anything left over is picked up on the next run.
MAX_CHUNKS_PER_RUN = 60

# OWM One Call 3.0 historical daily_summary makes ONE HTTP call per date.
# Cap the per-chunk OWM request count so a multi-year first run doesn't
# issue thousands of calls; anything beyond this falls back to Open-Meteo
# (one call per MAX_CHUNK_DAYS span) on the same chunk.
MAX_OWM_DAYS_PER_CHUNK = 30

HTTP_TIMEOUT = 30.0


def _http_get_json(url: str, timeout: float = HTTP_TIMEOUT) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _local_today() -> datetime.date:
    return datetime.datetime.now(inverter.local_tz()).date()


def _missing_chunks(
    first_day: str, last_day: str, existing: set[str]
) -> list[tuple[str, str]]:
    """
    Contiguous [start, end] ranges of missing days between first_day and
    last_day (inclusive), split into chunks of at most MAX_CHUNK_DAYS.
    """
    start = datetime.date.fromisoformat(first_day)
    end = datetime.date.fromisoformat(last_day)
    if start > end:
        return []

    chunks: list[tuple[str, str]] = []
    run_start = None
    prev = None
    d = start
    while d <= end:
        key = d.isoformat()
        if key not in existing:
            if run_start is None:
                run_start = key
            elif (d - datetime.date.fromisoformat(prev)).days > 1:
                # Gap in the missing run shouldn't happen (we walk every
                # day), but split defensively rather than merge blindly.
                chunks.append((run_start, prev))
                run_start = key
            prev = key
        else:
            if run_start is not None:
                chunks.append((run_start, prev))
                run_start = None
        d += datetime.timedelta(days=1)
    if run_start is not None:
        chunks.append((run_start, prev))

    # Split oversized runs into bounded request windows.
    bounded: list[tuple[str, str]] = []
    for c_start, c_end in chunks:
        s = datetime.date.fromisoformat(c_start)
        e = datetime.date.fromisoformat(c_end)
        while s <= e:
            piece_end = min(e, s + datetime.timedelta(days=MAX_CHUNK_DAYS - 1))
            bounded.append((s.isoformat(), piece_end.isoformat()))
            s = piece_end + datetime.timedelta(days=1)
    return bounded


def _sunshine_fraction(day: str, sunshine_seconds: float):
    """
    sunshine_duration ÷ astral daylight span for one local day, via the
    shared sun math. Clamped to [0, 1]; None when the sun window cannot be
    computed (extreme-latitude edge cases) -- the row's other measures stay
    valid either way.
    """
    try:
        info = inverter.get_day_sun(datetime.date.fromisoformat(day))
        span = (
            datetime.datetime.fromisoformat(info["sunset"])
            - datetime.datetime.fromisoformat(info["sunrise"])
        ).total_seconds()
        if span <= 0:
            return None
        return round(min(1.0, max(0.0, float(sunshine_seconds) / span)), 4)
    except Exception:
        return None


def _normalize(raw: dict, fetched_at: str) -> tuple[list[dict], int]:
    """
    Turn an Archive API response into complete day rows.

    Returns (rows, skipped) where rows only contain days having ALL source
    measures present (cloud cover needs at least one hourly sample); skipped
    counts the requested-but-incomplete days, which stay absent from the
    table so a later pass retries them.
    """
    daily = raw.get("daily") or {}
    times = daily.get("time") or []
    precip = daily.get("precipitation_sum") or []
    temp = daily.get("temperature_2m_mean") or []
    sunshine = daily.get("sunshine_duration") or []

    hourly = raw.get("hourly") or {}
    h_times = hourly.get("time") or []
    h_cloud = hourly.get("cloud_cover") or []
    cloud_by_day: dict = {}
    for t, v in zip(h_times, h_cloud):
        if v is None:
            continue
        cloud_by_day.setdefault(t[:10], []).append(float(v))

    rows: list[dict] = []
    skipped = 0
    for i, day in enumerate(times):
        p = precip[i] if i < len(precip) else None
        tm = temp[i] if i < len(temp) else None
        sun = sunshine[i] if i < len(sunshine) else None
        clouds = cloud_by_day.get(day)
        if p is None or tm is None or sun is None or not clouds:
            skipped += 1
            continue
        rows.append({
            "day": day,
            "cloud_cover_mean": round(sum(clouds) / len(clouds), 1),
            "precip_mm": round(float(p), 2),
            "temp_mean": round(float(tm), 2),
            "sunshine_fraction": _sunshine_fraction(day, sun),
            "fetched_at": fetched_at,
        })
    return rows, skipped


def _fetch_chunk(start_day: str, end_day: str) -> dict:
    """One Archive API request for the inclusive local-date range."""
    params = urllib.parse.urlencode({
        "latitude": config.LATITUDE,
        "longitude": config.LONGITUDE,
        "timezone": config.TIMEZONE,
        "start_date": start_day,
        "end_date": end_day,
        "hourly": "cloud_cover",
        "daily": "precipitation_sum,temperature_2m_mean,sunshine_duration",
    })
    return _http_get_json(f"{ARCHIVE_URL}?{params}")


def _owm_day_summary(day: str) -> dict:
    """
    One OpenWeatherMap One Call 3.0 daily_summary request for a single local
    date. Returns the parsed JSON dict; raises whatever urllib raises on
    HTTP/network errors (HTTPError on non-2xx, URLError on DNS/connect).
    """
    params = urllib.parse.urlencode({
        "lat": config.LATITUDE,
        "lon": config.LONGITUDE,
        "date": day,
        "units": "metric",
        "appid": config.OPENWEATHER_API_KEY,
    })
    return _http_get_json(f"{OWM_ONECALL_URL}?{params}")


def _normalize_owm(
    responses: dict[str, dict], fetched_at: str
) -> tuple[list[dict], int]:
    """
    Turn a per-day {YYYY-MM-DD: owm_json} map into complete day rows in the
    same shape Open-Meteo produces. Days missing any required measure are
    skipped and retried later -- never estimated.
    """
    rows: list[dict] = []
    skipped = 0
    for day in sorted(responses):
        raw = responses[day] or {}
        cloud = raw.get("cloud_cover")        # afternoon mean %, 0..100
        precip = raw.get("precipitation")     # mm
        temp = raw.get("temperature")         # °C
        # OWM returns temperature.{min,max,afternoon,night,evening,morning};
        # mean is the average of min+max when "temperature" itself is absent.
        if temp is None:
            mn = raw.get("temperature_min")
            mx = raw.get("temperature_max")
            if mn is not None and mx is not None:
                temp = (float(mn) + float(mx)) / 2.0
        sunshine = raw.get("sunshine_duration")  # seconds, may be absent
        if cloud is None or precip is None or temp is None:
            skipped += 1
            continue
        try:
            cloud_v = float(cloud)
            precip_v = float(precip)
            temp_v = float(temp)
        except (TypeError, ValueError):
            skipped += 1
            continue
        rows.append({
            "day": day,
            "cloud_cover_mean": round(cloud_v, 1),
            "precip_mm": round(precip_v, 2),
            "temp_mean": round(temp_v, 2),
            "sunshine_fraction": (
                _sunshine_fraction(day, sunshine)
                if sunshine is not None else None
            ),
            "fetched_at": fetched_at,
        })
    return rows, skipped


def _fetch_chunk_openweathermap(
    start_day: str, end_day: str, fetched_at: str
) -> tuple[list[dict], int]:
    """
    OpenWeatherMap One Call 3.0 historical backfill for the inclusive
    [start_day, end_day] range. One HTTP call per day; returns rows in the
    same shape as the Open-Meteo normalizer. Days the API can't serve (404,
    missing fields) are skipped, not estimated.
    """
    s = datetime.date.fromisoformat(start_day)
    end_d = datetime.date.fromisoformat(end_day)
    span = (end_d - s).days + 1
    if span > MAX_OWM_DAYS_PER_CHUNK:
        raise ValueError(
            f"chunk span {span}d exceeds MAX_OWM_DAYS_PER_CHUNK={MAX_OWM_DAYS_PER_CHUNK}"
        )

    responses: dict[str, dict] = {}
    d = s
    while d <= end_d:
        day = d.isoformat()
        try:
            responses[day] = _owm_day_summary(day)
        except Exception as exc:                  # noqa: BLE001 - per-day retry
            print(f"[WEATHER HISTORY] openweathermap day {day} failed: {exc!r}")
            responses[day] = None
        d += datetime.timedelta(days=1)
    return _normalize_owm(responses, fetched_at)


def backfill(max_chunks: int = MAX_CHUNKS_PER_RUN) -> dict:
    """
    Fill every missing weather day from the DB's first generation day through
    yesterday (local). Idempotent: days already stored are never refetched;
    failures leave their days absent so the next maintenance run retries them.

    Returns a small summary dict for logging / the maintenance report.
    """
    fetched_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

    first_day = database.get_first_generation_day()
    if not first_day:
        return {"reason": "no generation data", "stored": 0}

    # The archive serves same-day model estimates; request through yesterday
    # so only genuinely completed days are ever considered.
    target_end = (_local_today() - datetime.timedelta(days=1)).isoformat()

    existing = set(database.get_weather_days())
    all_chunks = _missing_chunks(first_day, target_end, existing)
    chunks = all_chunks[:max_chunks]

    summary = {
        "first_day": first_day,
        "target_through": target_end,
        "days_missing": sum(
            (datetime.date.fromisoformat(e) - datetime.date.fromisoformat(s)).days + 1
            for s, e in all_chunks
        ),
        "chunks_requested": len(chunks),
        "stored": 0,
        "incomplete_skipped": 0,
        "failed_chunk": None,
        "provider": "open-meteo",
    }
    if not chunks:
        return summary

    for start_day, end_day in chunks:
        span_days = (
            datetime.date.fromisoformat(end_day)
            - datetime.date.fromisoformat(start_day)
        ).days + 1

        # Provider priority: OWM (when key is set) -> Open-Meteo. Same
        # semantics as the live weather chip in weather.py: silent fallback
        # is replaced with explicit logging so the operator can see why.
        used_provider = "open-meteo"
        rows: list[dict] = []
        skipped = 0

        if config.OPENWEATHER_API_KEY and span_days <= MAX_OWM_DAYS_PER_CHUNK:
            try:
                rows, skipped = _fetch_chunk_openweathermap(
                    start_day, end_day, fetched_at
                )
                used_provider = "openweathermap"
            except Exception as e:                # noqa: BLE001 - retry next run
                print(
                    f"[WEATHER HISTORY] openweathermap failed: {e!r}; "
                    f"falling back to open-meteo for {start_day}..{end_day}"
                )
                rows, skipped = [], 0
        elif config.OPENWEATHER_API_KEY and span_days > MAX_OWM_DAYS_PER_CHUNK:
            print(
                f"[WEATHER HISTORY] chunk {start_day}..{end_day} ({span_days}d) "
                f"exceeds MAX_OWM_DAYS_PER_CHUNK={MAX_OWM_DAYS_PER_CHUNK}; "
                f"using open-meteo"
            )
        elif not config.OPENWEATHER_API_KEY:
            print(
                f"[WEATHER HISTORY] OPENWEATHER_API_KEY not set; "
                f"using open-meteo for {start_day}..{end_day}"
            )

        if not rows and not skipped:
            try:
                rows, skipped = _normalize(
                    _fetch_chunk(start_day, end_day), fetched_at
                )
            except Exception as e:                # noqa: BLE001 - retry next run
                print(f"[WEATHER HISTORY] chunk {start_day}..{end_day} failed: {e}")
                summary["failed_chunk"] = f"{start_day}..{end_day}"
                break
        elif not rows and skipped:
            # OWM returned rows for some days but they were all incomplete
            # (skipped); fall through to Open-Meteo for the whole chunk
            # rather than silently leave the days empty.
            try:
                rows, skipped = _normalize(
                    _fetch_chunk(start_day, end_day), fetched_at
                )
                used_provider = "open-meteo"
            except Exception as e:                # noqa: BLE001 - retry next run
                print(
                    f"[WEATHER HISTORY] open-meteo fallback for "
                    f"{start_day}..{end_day} failed: {e}"
                )
                summary["failed_chunk"] = f"{start_day}..{end_day}"
                break

        summary["incomplete_skipped"] += skipped
        summary["provider"] = used_provider
        if rows:
            summary["stored"] += database.upsert_weather_daily(rows)
            # Progress marker follows the last completely-stored day.
            database.set_weather_backfilled_through(rows[-1]["day"])

    state = database.get_weather_backfill_state()
    summary["backfilled_through"] = state["backfilled_through"]
    summary["days_total"] = state["days"]
    return summary
