"""
Historical daily weather for the Weather Impact panel -- backfill + append.

Source: the Open-Meteo Archive API (https://archive-api.open-meteo.com/v1/archive),
free and key-less, using the same configured LATITUDE / LONGITUDE / TIMEZONE
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

# Longest span per HTTP call. The initial backfill over a decade-old DB
# becomes a handful of requests instead of one giant response.
MAX_CHUNK_DAYS = 366

# Upper bound on chunks per maintenance pass so one cold-start pass stays
# bounded; anything left over is picked up on the next run.
MAX_CHUNKS_PER_RUN = 60

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
    }
    if not chunks:
        return summary

    for start_day, end_day in chunks:
        try:
            rows, skipped = _normalize(
                _fetch_chunk(start_day, end_day), fetched_at
            )
        except Exception as e:                    # noqa: BLE001 - retry next run
            print(f"[WEATHER HISTORY] chunk {start_day}..{end_day} failed: {e}")
            summary["failed_chunk"] = f"{start_day}..{end_day}"
            break
        summary["incomplete_skipped"] += skipped
        if rows:
            summary["stored"] += database.upsert_weather_daily(rows)
            # Progress marker follows the last completely-stored day.
            database.set_weather_backfilled_through(rows[-1]["day"])

    state = database.get_weather_backfill_state()
    summary["backfilled_through"] = state["backfilled_through"]
    summary["days_total"] = state["days"]
    return summary
