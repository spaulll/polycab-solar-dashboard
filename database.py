"""
SQLite storage layer.

Writes happen on a dedicated background thread via a queue, so the async
Modbus polling loop never blocks on disk I/O. Reads (for the REST history
endpoints) open short-lived connections on demand -- SQLite handles
concurrent readers/writer fine for this single-user, local-network use case.

Long-term data management:
- Full-resolution readings live in `readings` only for a recent window
  (RETENTION_DAYS, default 60 days).
- A daily maintenance thread downsamples older raw data into two permanent
  aggregate tables (`readings_hourly`, `readings_daily`) and then deletes
  the raw rows. It also VACUUMs/ANALYZEs roughly once a week.
- The thread catches up after restarts: if the last scheduled slot was
  missed (e.g. the machine was off at MAINTENANCE_HOUR), maintenance runs
  immediately at startup.
"""
import csv
import io
import os
import queue
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from typing import Optional

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None

import config

_write_queue: "queue.Queue[dict]" = queue.Queue()
_writer_thread: Optional[threading.Thread] = None
_maintenance_thread: Optional[threading.Thread] = None
_stop_event = threading.Event()
_maintenance_stop = threading.Event()

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,           -- ISO 8601 UTC
    l1_voltage REAL,
    l1_current REAL,
    inverter_power REAL,
    solar_input REAL,
    temperature REAL,
    e_total REAL,
    e_today REAL,
    active_power REAL,
    peak_power REAL
);

CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings (timestamp);

-- Permanent 1-hour aggregates (downsampled from `readings` before deletion).
CREATE TABLE IF NOT EXISTS readings_hourly (
    hour_start          TEXT PRIMARY KEY,   -- ISO UTC hour, e.g. 2026-08-21T10:00:00
    solar_input_avg     REAL,
    solar_input_max     REAL,
    inverter_power_avg  REAL,
    inverter_power_max  REAL,
    temperature_avg     REAL,
    temperature_max     REAL,
    e_today_max         REAL,               -- max e_today seen in that hour
    e_total_max         REAL,
    peak_power_max      REAL,
    sample_count        INTEGER
);

-- Permanent per-day aggregates.
CREATE TABLE IF NOT EXISTS readings_daily (
    day             TEXT PRIMARY KEY,       -- YYYY-MM-DD (UTC)
    energy_kwh      REAL,                   -- max e_today for the day
    peak_power      REAL,
    solar_input_max REAL,
    temperature_max REAL,
    sample_count    INTEGER
);

-- Simple key/value store for maintenance bookkeeping (survives restarts).
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Historical daily weather (Open-Meteo Archive API), one row per LOCAL day,
-- written by the maintenance thread's backfill job. Joined against the
-- generation day series for the Weather Impact correlation view. Days are
-- only ever inserted complete -- never estimated or partially filled --
-- so absent rows mean "archive didn't have that day (yet)" and are retried
-- on a later maintenance run.
CREATE TABLE IF NOT EXISTS readings_weather_daily (
    day               TEXT PRIMARY KEY,   -- YYYY-MM-DD (local calendar day)
    cloud_cover_mean  REAL,               -- %  (daily mean of hourly values)
    precip_mm         REAL,               -- mm (precipitation_sum)
    temp_mean         REAL,               -- °C (temperature_2m_mean)
    sunshine_fraction REAL,               -- sunshine_duration ÷ astral daylight span
    fetched_at        TEXT                -- ISO 8601 UTC, when the row was stored
);

-- Powercut events: one row per inverter-unreachable episode. The row is
-- inserted when the first error follows a successful reading and updated
-- (ended_at + duration) when a reading succeeds again. An open row
-- (ended_at IS NULL) means the inverter is currently unreachable -- this is
-- how offline state survives app/server restarts.
CREATE TABLE IF NOT EXISTS powercuts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,          -- ISO 8601 UTC, when it went unreachable
    ended_at TEXT,                     -- ISO 8601 UTC, NULL while ongoing
    duration_seconds INTEGER,          -- filled in on recovery
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_powercuts_started ON powercuts (started_at);

-- Error history: one row per distinct error episode (consecutive identical
-- failures collapse into a single row -- the poll loop retries the same
-- error every ERROR_RETRY_DELAY, which would otherwise flood the log; a
-- repeat after recovery logs as a new episode). Rotated: rows older than
-- ERROR_LOG_RETENTION_DAYS are deleted on insert and on read. Purely
-- informational -- it feeds the sidebar's error counter + history popup;
-- powercut *episodes* with their durations live in the powercuts table.
CREATE TABLE IF NOT EXISTS error_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    logged_at TEXT NOT NULL,           -- ISO 8601 UTC, first occurrence
    message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_log_id ON error_log (id);
"""

# Ranges served straight from the full-resolution table.
RAW_RANGES = {"1h", "24h", "7d"}
# Longer but still sub-month ranges -> hourly aggregates.
HOURLY_RANGES = {"30d"}
# Anything longer (incl. "all") -> daily aggregates.
DAILY_RANGES = {"90d", "365d", "all"}

RANGE_DELTAS = {
    "1h": timedelta(hours=1),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
    "90d": timedelta(days=90),
    "365d": timedelta(days=365),
}


def _connect() -> sqlite3.Connection:
    """Open a connection with sensible durability/performance pragmas."""
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-64000")  # ~64 MB page cache
    conn.execute("PRAGMA temp_store=MEMORY")
    return conn


def init_db() -> None:
    """Create the DB file and schema if they don't already exist."""
    conn = _connect()
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Meta helpers (maintenance bookkeeping)
# ---------------------------------------------------------------------------
def _get_meta(conn: sqlite3.Connection, key: str) -> Optional[str]:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def _set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )


# ---------------------------------------------------------------------------
# Powercut tracking
# ---------------------------------------------------------------------------
def get_open_powercut() -> Optional[dict]:
    """The currently-open powercut row (ended_at IS NULL), or None."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT * FROM powercuts WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def record_powercut_start(last_error: str) -> None:
    """
    Mark the start of an unreachable episode. Idempotent: if a row is already
    open (e.g. errors across night-mode transitions) it is left untouched.
    Also bumps the quick-access lifetime counter in meta.
    """
    conn = _connect()
    try:
        if conn.execute(
            "SELECT id FROM powercuts WHERE ended_at IS NULL LIMIT 1"
        ).fetchone():
            return
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO powercuts (started_at, ended_at, duration_seconds, last_error) "
            "VALUES (?, NULL, NULL, ?)",
            (now, last_error),
        )
        total = int(_get_meta(conn, "total_powercuts") or 0) + 1
        _set_meta(conn, "total_powercuts", total)
        conn.commit()
    finally:
        conn.close()


def close_open_powercut() -> None:
    """Stamp ended_at + duration on the open powercut row, if any. No-op otherwise."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id, started_at FROM powercuts WHERE ended_at IS NULL "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if not row:
            return
        ended = datetime.now(timezone.utc)
        started = datetime.fromisoformat(row["started_at"])
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        duration = max(0, int((ended - started).total_seconds()))
        conn.execute(
            "UPDATE powercuts SET ended_at = ?, duration_seconds = ? WHERE id = ?",
            (ended.isoformat(), duration, row["id"]),
        )
        conn.commit()
    finally:
        conn.close()


def get_powercut_count(range_str: str = "lifetime") -> int:
    """Count powercuts in 'today' | '7d' | '30d' | 'lifetime' window."""
    conn = _connect()
    try:
        if range_str == "lifetime":
            return conn.execute("SELECT COUNT(*) AS n FROM powercuts").fetchone()["n"]

        now = datetime.now(timezone.utc)
        if range_str == "today":
            # Local calendar day, converted to UTC so string comparison against
            # stored UTC timestamps stays correct.
            local_midnight = (
                datetime.now(_local_tz())
                .replace(hour=0, minute=0, second=0, microsecond=0)
                .astimezone(timezone.utc)
            )
            cutoff = local_midnight.isoformat()
        elif range_str == "7d":
            cutoff = (now - timedelta(days=7)).isoformat()
        elif range_str == "30d":
            cutoff = (now - timedelta(days=30)).isoformat()
        else:
            raise ValueError(
                f"Unknown range '{range_str}'. Use one of: today, 7d, 30d, lifetime."
            )
        return conn.execute(
            "SELECT COUNT(*) AS n FROM powercuts WHERE started_at >= ?", (cutoff,)
        ).fetchone()["n"]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Error history (episode-based, 7-day rotation)
# ---------------------------------------------------------------------------
ERROR_LOG_RETENTION_DAYS = 7


def _prune_error_log(conn: sqlite3.Connection) -> None:
    """Drop error_log rows older than the retention window (in place)."""
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=ERROR_LOG_RETENTION_DAYS)
    ).isoformat()
    conn.execute("DELETE FROM error_log WHERE logged_at < ?", (cutoff,))


def log_error(message: str, logged_at: Optional[str] = None) -> bool:
    """
    Append one error episode to the error history. Consecutive identical
    messages collapse into the existing row (the poll loop retries the same
    failure every ERROR_RETRY_DELAY); a repeat after a recovery logs as a
    new episode. Returns True when a row was added.
    """
    conn = _connect()
    try:
        last = conn.execute(
            "SELECT message FROM error_log ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if last and last["message"] == message:
            return False
        now = logged_at or datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO error_log (logged_at, message) VALUES (?, ?)",
            (now, message),
        )
        _prune_error_log(conn)
        conn.commit()
        return True
    finally:
        conn.close()


def get_recent_errors(limit: int = 50) -> list:
    """Error episodes inside the retention window, newest first."""
    conn = _connect()
    try:
        _prune_error_log(conn)
        rows = conn.execute(
            "SELECT logged_at, message FROM error_log "
            "ORDER BY id DESC LIMIT ?",
            (max(1, int(limit)),),
        ).fetchall()
        conn.commit()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Writer thread (full-resolution inserts)
# ---------------------------------------------------------------------------
def _writer_loop() -> None:
    """Runs on a background thread. Pulls readings off the queue and writes them."""
    conn = _connect()
    try:
        while not _stop_event.is_set() or not _write_queue.empty():
            try:
                item = _write_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                conn.execute(
                    """
                    INSERT INTO readings
                        (timestamp, l1_voltage, l1_current, inverter_power,
                         solar_input, temperature, e_total, e_today,
                         active_power, peak_power)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item["timestamp"],
                        item["L1_Voltage"],
                        item["L1_Current"],
                        item["Inverter_Power"],
                        item["Solar_Input"],
                        item["Temperature"],
                        item["E_Total"],
                        item["E_Today"],
                        item["Active_Power"],
                        item["Peak_Power"],
                    ),
                )
                conn.commit()
            except Exception as e:
                print(f"[DB WRITE ERROR] {e}")
            finally:
                _write_queue.task_done()
    finally:
        conn.close()


def start_writer_thread() -> None:
    global _writer_thread
    if _writer_thread is not None:
        return
    _stop_event.clear()
    _writer_thread = threading.Thread(target=_writer_loop, daemon=True, name="db-writer")
    _writer_thread.start()


def stop_writer_thread() -> None:
    _stop_event.set()
    if _writer_thread is not None:
        _writer_thread.join(timeout=5)


def enqueue_reading(data: dict) -> None:
    """Non-blocking: hand a reading off to the background writer thread."""
    payload = dict(data)
    payload.setdefault("timestamp", datetime.now(timezone.utc).isoformat())
    _write_queue.put(payload)


# ---------------------------------------------------------------------------
# Maintenance: downsample + retention + vacuum
# ---------------------------------------------------------------------------
def run_maintenance() -> dict:
    """
    One maintenance pass:

      a. Aggregate every complete raw day older than RETENTION_DAYS into
         readings_hourly / readings_daily (idempotent upserts).
      b. Delete those raw rows.
      c. Roughly once a week, VACUUM + ANALYZE (if ENABLE_VACUUM).

    Returns a small summary dict for logging / the db-status endpoint.

    Note on cutoffs: both aggregation and deletion use the *start of the UTC
    day* RETENTION_DAYS ago, so we only ever archive/delete whole days. That
    keeps daily aggregates exact (no half-day sums frozen in forever).
    """
    started = datetime.now(timezone.utc).isoformat()
    now = datetime.now(timezone.utc)
    cutoff_dt = (now - timedelta(days=config.RETENTION_DAYS)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    cutoff = cutoff_dt.isoformat()

    conn = _connect()
    # Autocommit mode so VACUUM can run; we manage transactions explicitly.
    conn.isolation_level = None
    try:
        hourly_rows = daily_rows = deleted_rows = 0
        vacuumed = False

        if config.RETENTION_DAYS > 0:
            conn.execute("BEGIN")

            # --- a1. Hourly aggregates -----------------------------------
            cur = conn.execute(
                """
                INSERT OR REPLACE INTO readings_hourly (
                    hour_start, solar_input_avg, solar_input_max,
                    inverter_power_avg, inverter_power_max,
                    temperature_avg, temperature_max,
                    e_today_max, e_total_max, peak_power_max, sample_count)
                SELECT
                    substr(timestamp, 1, 13) || ':00:00',
                    AVG(solar_input), MAX(solar_input),
                    AVG(inverter_power), MAX(inverter_power),
                    AVG(temperature), MAX(temperature),
                    MAX(e_today), MAX(e_total), MAX(peak_power),
                    COUNT(*)
                FROM readings
                WHERE timestamp < ?
                GROUP BY substr(timestamp, 1, 13)
                """,
                (cutoff,),
            )
            hourly_rows = max(cur.rowcount, 0)

            # --- a2. Daily aggregates ------------------------------------
            cur = conn.execute(
                """
                INSERT OR REPLACE INTO readings_daily (
                    day, energy_kwh, peak_power, solar_input_max,
                    temperature_max, sample_count)
                SELECT
                    date(timestamp),
                    MAX(e_today), MAX(peak_power), MAX(solar_input),
                    MAX(temperature), COUNT(*)
                FROM readings
                WHERE timestamp < ?
                GROUP BY date(timestamp)
                """,
                (cutoff,),
            )
            daily_rows = max(cur.rowcount, 0)

            # --- b. Delete archived raw rows -----------------------------
            cur = conn.execute("DELETE FROM readings WHERE timestamp < ?", (cutoff,))
            deleted_rows = max(cur.rowcount, 0)

            conn.execute("COMMIT")

        _set_meta(conn, "last_maintenance", started)

        # --- c. Weekly VACUUM + ANALYZE ----------------------------------
        last_vacuum = _get_meta(conn, "last_vacuum")
        week_ago = (now - timedelta(days=7)).isoformat()
        if config.ENABLE_VACUUM and (last_vacuum is None or last_vacuum < week_ago):
            conn.execute("VACUUM")
            conn.execute("ANALYZE")
            _set_meta(conn, "last_vacuum", started)
            vacuumed = True

        # --- d. Historical weather backfill -------------------------------
        # Runs on the same daily cadence (and at startup catch-up): fills
        # every missing day from the DB's first generation day through what
        # the archive API has published, one HTTP call per chunk of missing
        # days. Failures are logged and simply retried on the next pass --
        # only complete days are ever stored, never estimates.
        weather_summary = None
        if config.WEATHER_HISTORY_ENABLED:
            try:
                # Deferred import: weather_history calls back into this
                # module for all SQL, so a top-level import would cycle.
                import weather_history
                weather_summary = weather_history.backfill()
            except Exception as e:
                print(f"[MAINTENANCE] weather backfill failed: {e}")

        summary = {
            "ran_at": started,
            "cutoff": cutoff,
            "hourly_upserts": hourly_rows,
            "daily_upserts": daily_rows,
            "raw_deleted": deleted_rows,
            "vacuumed": vacuumed,
        }
        if weather_summary is not None:
            summary["weather"] = weather_summary
        print(f"[MAINTENANCE] {summary}")
        return summary
    except Exception as e:
        print(f"[MAINTENANCE ERROR] {e}")
        try:
            conn.execute("ROLLBACK")
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()


def _local_tz():
    if ZoneInfo is not None:
        try:
            return ZoneInfo(config.TIMEZONE)
        except Exception:
            pass
    return timezone.utc


def _next_maintenance_time(now: Optional[datetime] = None) -> datetime:
    """Next wall-clock occurrence of MAINTENANCE_HOUR in local time."""
    tz = _local_tz()
    now_local = (now or datetime.now(timezone.utc)).astimezone(tz)
    candidate = now_local.replace(
        hour=config.MAINTENANCE_HOUR, minute=0, second=0, microsecond=0
    )
    if candidate <= now_local:
        candidate += timedelta(days=1)
    return candidate


def _missed_last_slot() -> bool:
    """
    True if the most recent scheduled maintenance slot has passed without a
    successful run -- used to catch up immediately after a restart/downtime.
    """
    conn = _connect()
    try:
        last_run = _get_meta(conn, "last_maintenance")
    finally:
        conn.close()

    tz = _local_tz()
    now_local = datetime.now(timezone.utc).astimezone(tz)
    today_slot = now_local.replace(
        hour=config.MAINTENANCE_HOUR, minute=0, second=0, microsecond=0
    )
    if now_local < today_slot:
        today_slot -= timedelta(days=1)

    if last_run is None:
        # Fresh database with no data to protect, but running once is cheap
        # and keeps the meta table warm. Only run if there is old data.
        return True

    last_dt = datetime.fromisoformat(last_run)
    return last_dt.astimezone(timezone.utc) < today_slot.astimezone(timezone.utc)


def _maintenance_loop() -> None:
    """Daily maintenance scheduler. Sleeps until the next slot, then runs."""
    # Catch-up: if we restarted past the last scheduled slot, run right away
    # so retention is enforced even when the box was off at MAINTENANCE_HOUR.
    try:
        if _missed_last_slot():
            run_maintenance()
    except Exception as e:
        print(f"[MAINTENANCE] startup catch-up failed: {e}")

    while not _maintenance_stop.is_set():
        next_run = _next_maintenance_time()
        wait_seconds = (next_run - datetime.now(timezone.utc)).total_seconds()
        # Sleep in short chunks so shutdown stays responsive even if the wait
        # is many hours long.
        slept = 0.0
        while slept < wait_seconds and not _maintenance_stop.is_set():
            chunk = min(60.0, wait_seconds - slept)
            if _maintenance_stop.wait(chunk):
                return
            slept += chunk
        if _maintenance_stop.is_set():
            return
        try:
            run_maintenance()
        except Exception as e:
            # Already logged inside run_maintenance; keep the loop alive.
            print(f"[MAINTENANCE] scheduled run failed: {e}")


def start_maintenance_thread() -> None:
    global _maintenance_thread
    if _maintenance_thread is not None:
        return
    _maintenance_stop.clear()
    _maintenance_thread = threading.Thread(
        target=_maintenance_loop, daemon=True, name="db-maintenance"
    )
    _maintenance_thread.start()


def stop_maintenance_thread() -> None:
    _maintenance_stop.set()
    if _maintenance_thread is not None:
        _maintenance_thread.join(timeout=5)


# ---------------------------------------------------------------------------
# History queries
# ---------------------------------------------------------------------------
def _range_to_since(range_str: str) -> Optional[str]:
    """Convert a range keyword into an ISO timestamp cutoff. None means 'all'."""
    now = datetime.now(timezone.utc)
    if range_str == "all":
        return None
    delta = RANGE_DELTAS.get(range_str)
    if delta is None:
        raise ValueError(
            f"Unknown range '{range_str}'. Use one of: 1h, 24h, 7d, 30d, 90d, 365d, all."
        )
    return (now - delta).isoformat()


def _history_raw(since: Optional[str]) -> list[dict]:
    conn = _connect()
    try:
        if since is None:
            rows = conn.execute(
                "SELECT * FROM readings ORDER BY timestamp ASC"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM readings WHERE timestamp >= ? ORDER BY timestamp ASC",
                (since,),
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_history_between(since: str, until: Optional[str] = None) -> list[dict]:
    """
    Full-resolution readings with since <= timestamp <= until (ISO UTC
    strings; until=None means open-ended). Lexicographic comparison is safe
    here because every stored timestamp shares the same ISO-UTC prefix.
    """
    conn = _connect()
    try:
        if until is None:
            rows = conn.execute(
                "SELECT * FROM readings WHERE timestamp >= ? ORDER BY timestamp ASC",
                (since,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM readings WHERE timestamp >= ? AND timestamp <= ? "
                "ORDER BY timestamp ASC",
                (since, until),
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_readings_time_span() -> tuple[Optional[str], Optional[str]]:
    """(oldest, newest) raw timestamps, or (None, None) for an empty table."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT MIN(timestamp) AS lo, MAX(timestamp) AS hi FROM readings"
        ).fetchone()
        return row["lo"], row["hi"]
    finally:
        conn.close()


def _load_sun_windows(
    conn: sqlite3.Connection, windows: list[tuple[str, str]]
) -> None:
    """Fill the per-connection temp table used by the daylight JOINs."""
    conn.execute(
        "CREATE TEMP TABLE IF NOT EXISTS sun_windows ("
        "  sunrise TEXT PRIMARY KEY, sunset TEXT NOT NULL)"
    )
    conn.execute("DELETE FROM sun_windows")
    conn.executemany("INSERT INTO sun_windows VALUES (?, ?)", windows)


def aggregate_solar_profile(
    windows: list[tuple[str, str]], bin_seconds: int
) -> list[dict]:
    """
    Aggregate raw daylight readings into fixed bins of seconds-after-sunrise.

    windows: list of (sunrise_utc_naive_iso, sunset_utc_naive_iso) pairs, one
    per historical solar day. All binning/averaging runs inside SQLite as a
    single indexed scan joined against a temp table of day windows, so no
    large row sets ever cross into Python regardless of history length.

    Returns rows of {o: bin start seconds-after-sunrise, s_avg, i_avg, n}.
    """
    if not windows:
        return []
    conn = _connect()
    try:
        _load_sun_windows(conn, windows)
        rows = conn.execute(
            """
            SELECT
                CAST((julianday(r.timestamp) - julianday(w.sunrise)) * 86400
                     / ? AS INTEGER) AS bin,
                AVG(r.solar_input)    AS s_avg,
                AVG(r.inverter_power) AS i_avg,
                COUNT(*)              AS n
            FROM readings r
            JOIN sun_windows w
              ON r.timestamp BETWEEN w.sunrise AND w.sunset
            GROUP BY bin
            HAVING bin >= 0
            ORDER BY bin ASC
            """,
            (bin_seconds,),
        ).fetchall()
    finally:
        conn.close()

    # Convert bin indices back into seconds-after-sunrise for the API.
    return [
        {"o": r["bin"] * bin_seconds, "s_avg": r["s_avg"], "i_avg": r["i_avg"], "n": r["n"]}
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Temperature analytics
# ---------------------------------------------------------------------------
# Defensive sensor-quirk guard: readings with an implausible temperature
# (stuck sensor, register glitch) never enter any aggregate. Real inverter
# internal temps live far inside this window.
TEMP_MIN_PLAUSIBLE_C = -20.0
TEMP_MAX_PLAUSIBLE_C = 110.0

# Width of the solar_input bands for the temperature-vs-output view (W).
TEMP_OUTPUT_BAND_WATTS = 100


def aggregate_temperature_by_output(
    windows: list[tuple[str, str]],
    band_watts: int = TEMP_OUTPUT_BAND_WATTS,
) -> list[dict]:
    """
    Daylight readings banded by DC `solar_input` (fixed `band_watts` bins):

        band      lowest solar_input covered by the band (W)
        temp_avg / temp_max   inverter internal temperature in the band
        power_avg             avg AC output in the band
        eff                   SUM(inverter_power) / SUM(solar_input) --
                              energy-weighted, not average-of-ratios, so
                              noisy dawn/dusk ratios can't dominate a band
        n                     sample count

    Same sun-window JOIN as aggregate_solar_profile; night readings are
    excluded by construction. Rows missing any of the three measures are
    skipped outright.
    """
    if not windows:
        return []
    conn = _connect()
    try:
        _load_sun_windows(conn, windows)
        rows = conn.execute(
            """
            SELECT CAST(r.solar_input / ? AS INTEGER) AS band,
                   AVG(r.temperature)     AS temp_avg,
                   MAX(r.temperature)     AS temp_max,
                   AVG(r.inverter_power)  AS power_avg,
                   SUM(r.inverter_power)  AS p_sum,
                   SUM(r.solar_input)     AS s_sum,
                   COUNT(*)               AS n
            FROM readings r
            JOIN sun_windows w
              ON r.timestamp BETWEEN w.sunrise AND w.sunset
            WHERE r.temperature BETWEEN ? AND ?
              AND r.solar_input IS NOT NULL
              AND r.inverter_power IS NOT NULL
            GROUP BY band
            HAVING band >= 0
            ORDER BY band ASC
            """,
            (band_watts, TEMP_MIN_PLAUSIBLE_C, TEMP_MAX_PLAUSIBLE_C),
        ).fetchall()
    finally:
        conn.close()

    return [
        {
            "band_w": r["band"] * band_watts,
            "temp_avg": r["temp_avg"],
            "temp_max": r["temp_max"],
            "power_avg": r["power_avg"],
            "eff": (r["p_sum"] / r["s_sum"]) if r["s_sum"] else None,
            "n": r["n"],
        }
        for r in rows
    ]


def aggregate_temperature_by_time(
    windows: list[tuple[str, str]], bin_seconds: int
) -> list[dict]:
    """
    Avg/max inverter temperature vs position within the solar day -- mirrors
    the solar-profile shape ({o: seconds-after-sunrise bins}), so both curves
    can share one mental model. Missing bins stay absent; nothing fabricated.
    """
    if not windows:
        return []
    conn = _connect()
    try:
        _load_sun_windows(conn, windows)
        rows = conn.execute(
            """
            SELECT CAST((julianday(r.timestamp) - julianday(w.sunrise)) * 86400
                        / ? AS INTEGER) AS bin,
                   AVG(r.temperature) AS temp_avg,
                   MAX(r.temperature) AS temp_max,
                   COUNT(*)           AS n
            FROM readings r
            JOIN sun_windows w
              ON r.timestamp BETWEEN w.sunrise AND w.sunset
            WHERE r.temperature BETWEEN ? AND ?
            GROUP BY bin
            HAVING bin >= 0
            ORDER BY bin ASC
            """,
            (bin_seconds, TEMP_MIN_PLAUSIBLE_C, TEMP_MAX_PLAUSIBLE_C),
        ).fetchall()
    finally:
        conn.close()

    return [
        {
            "o": r["bin"] * bin_seconds,
            "temp_avg": r["temp_avg"],
            "temp_max": r["temp_max"],
            "n": r["n"],
        }
        for r in rows
    ]


def get_temperature_records(today_since: Optional[str] = None) -> dict:
    """
    Temperature records spanning ALL history:

        today_max    MAX(temperature) since `today_since` (today's sunrise
                     cutoff) -- None before the first reading of the day;
                     night residuals never count because polling is asleep
        all_time_max hottest sample ever, across readings_daily
                     .temperature_max (post-retention history) AND the raw
                     table (recent days not yet downsampled)
        hottest_day  {date, temp_max} of the hottest day on record, chosen
                     by the same union (ties -> the more recent day)

    No fabrication: every field is null when its source has no data yet.
    """
    conn = _connect()
    try:
        today_row = None
        if today_since:
            today_row = conn.execute(
                """
                SELECT MAX(temperature) AS t FROM readings
                WHERE timestamp >= ? AND temperature IS NOT NULL
                """,
                (today_since,),
            ).fetchone()

        all_time_row = conn.execute(
            """
            SELECT MAX(t) AS t FROM (
                SELECT MAX(temperature_max) AS t FROM readings_daily
                WHERE temperature_max IS NOT NULL
                UNION ALL
                SELECT MAX(temperature) AS t FROM readings
                WHERE temperature IS NOT NULL
            )
            """
        ).fetchone()

        daily_hot = conn.execute(
            """
            SELECT day, temperature_max AS t FROM readings_daily
            WHERE temperature_max IS NOT NULL
            ORDER BY temperature_max DESC, day DESC LIMIT 1
            """
        ).fetchone()
        raw_hot = conn.execute(
            """
            SELECT date(timestamp) AS day, MAX(temperature) AS t
            FROM readings
            WHERE temperature IS NOT NULL
            GROUP BY date(timestamp)
            ORDER BY t DESC, day DESC LIMIT 1
            """
        ).fetchone()
    finally:
        conn.close()

    candidates = []
    if daily_hot and daily_hot["t"] is not None:
        candidates.append((daily_hot["t"], daily_hot["day"]))
    if raw_hot and raw_hot["t"] is not None:
        candidates.append((raw_hot["t"], raw_hot["day"]))
    hottest = max(candidates) if candidates else None

    return {
        "today_max": today_row["t"] if today_row else None,
        "all_time_max": all_time_row["t"] if all_time_row else None,
        "hottest_day": (
            {"date": hottest[1], "temp_max": hottest[0]} if hottest else None
        ),
    }


# ---------------------------------------------------------------------------
# Historical daily weather (backfill storage + correlation)
# ---------------------------------------------------------------------------
def get_first_generation_day() -> Optional[str]:
    """
    Earliest local day (YYYY-MM-DD) with any generation data, across BOTH the
    permanent daily aggregates and the raw table -- the start of the span the
    weather backfill must cover. None when the database is empty.
    """
    conn = _connect()
    try:
        row = conn.execute(
            """
            SELECT MIN(day) AS first FROM (
                SELECT MIN(day) AS day FROM readings_daily
                UNION ALL
                SELECT date(MIN(timestamp)) FROM readings
            )
            """
        ).fetchone()
        return row["first"] if row else None
    finally:
        conn.close()


def get_weather_days() -> list[str]:
    """Every day (YYYY-MM-DD) already present in readings_weather_daily."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT day FROM readings_weather_daily ORDER BY day ASC"
        ).fetchall()
        return [r["day"] for r in rows]
    finally:
        conn.close()


def upsert_weather_daily(rows: list[dict]) -> int:
    """
    Insert/replace complete weather day rows. Callers only produce rows for
    days whose source data was complete; this function does no filtering.
    Returns the number of rows handed to SQLite.
    """
    if not rows:
        return 0
    conn = _connect()
    try:
        conn.executemany(
            """
            INSERT OR REPLACE INTO readings_weather_daily
                (day, cloud_cover_mean, precip_mm, temp_mean,
                 sunshine_fraction, fetched_at)
            VALUES (:day, :cloud_cover_mean, :precip_mm, :temp_mean,
                    :sunshine_fraction, :fetched_at)
            """,
            rows,
        )
        conn.commit()
        return len(rows)
    finally:
        conn.close()


WEATHER_BACKFILL_META_KEY = "weather_backfilled_through"


def get_weather_backfill_state() -> dict:
    """Backfill progress marker + stored-day count, for logging/db-status."""
    conn = _connect()
    try:
        through = _get_meta(conn, WEATHER_BACKFILL_META_KEY)
        count = conn.execute(
            "SELECT COUNT(*) AS n FROM readings_weather_daily"
        ).fetchone()["n"]
        last_day = conn.execute(
            "SELECT MAX(day) AS d FROM readings_weather_daily"
        ).fetchone()["d"]
    finally:
        conn.close()
    return {
        "backfilled_through": through,
        "last_stored_day": last_day,
        "days": int(count or 0),
    }


def set_weather_backfilled_through(day: str) -> None:
    """Advance the `weather_backfilled_through` meta marker (never backwards)."""
    conn = _connect()
    try:
        current = _get_meta(conn, WEATHER_BACKFILL_META_KEY)
        if current is None or (day and day > current):
            _set_meta(conn, WEATHER_BACKFILL_META_KEY, day)
            conn.commit()
    finally:
        conn.close()


# Cloud-cover class boundaries (% mean cloud cover) for the Weather Impact
# buckets: clear < 25, partly 25–60, cloudy > 60.
WEATHER_CLASS_THRESHOLDS = (25.0, 60.0)


def get_weather_correlation() -> dict:
    """
    Weather <-> production correlation for the Weather Impact panel.

    Joins the generation day series (the EXACT same merge used everywhere
    else -- readings_daily.energy_kwh plus still-raw recent days grouped on
    the fly as MAX(e_today)) against readings_weather_daily, so every matched
    point is a real day with both measured energy and archived weather.

    Output:
      classes   clear/partly/cloudy buckets by mean cloud cover (thresholds
                above): {days, avg_kwh, best_day{date,kwh}, worst_day} --
                nulls when a bucket has no days yet (no fabricated zeros)
      points    [{date, kwh, cloud, rain}] ascending by date (scatter feed)
      pearson_r Pearson correlation between cloud_cover_mean and energy_kwh
                across matched days; null below 2 points or zero variance
      matched_days / total_generation_days  coverage note for the UI guard
      backfilled_through                   archive progress marker

    Pure reads -- the backfill job writes the weather table, never this.
    """
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT w.day,
                   w.cloud_cover_mean,
                   w.precip_mm,
                   g.energy_kwh
            FROM readings_weather_daily w
            JOIN (
                SELECT day, energy_kwh FROM readings_daily
                WHERE energy_kwh IS NOT NULL
                UNION ALL
                SELECT date(timestamp) AS day,
                       MAX(e_today) AS energy_kwh
                FROM readings
                WHERE date(timestamp) NOT IN (SELECT day FROM readings_daily)
                  AND e_today IS NOT NULL
                GROUP BY date(timestamp)
            ) g ON g.day = w.day
            WHERE w.cloud_cover_mean IS NOT NULL AND g.energy_kwh IS NOT NULL
            ORDER BY w.day ASC
            """
        ).fetchall()

        total_generation_days = conn.execute(
            """
            SELECT COUNT(*) AS n FROM (
                SELECT day FROM readings_daily WHERE energy_kwh IS NOT NULL
                UNION ALL
                SELECT date(timestamp)
                FROM readings
                WHERE date(timestamp) NOT IN (SELECT day FROM readings_daily)
                  AND e_today IS NOT NULL
                GROUP BY date(timestamp)
            )
            """
        ).fetchone()["n"]

        through = _get_meta(conn, WEATHER_BACKFILL_META_KEY)
    finally:
        conn.close()

    lo, mid = WEATHER_CLASS_THRESHOLDS

    def _classify(cloud: float) -> str:
        if cloud < lo:
            return "clear"
        if cloud <= mid:
            return "partly"
        return "cloudy"

    buckets: dict = {
        "clear": [], "partly": [], "cloudy": []
    }
    points = []
    for r in rows:
        kwh = float(r["energy_kwh"])
        cloud = float(r["cloud_cover_mean"])
        rain = float(r["precip_mm"]) if r["precip_mm"] is not None else None
        cls = _classify(cloud)
        buckets[cls].append((r["day"], kwh))
        points.append({
            "date": r["day"],
            "kwh": round(kwh, 2),
            "cloud": round(cloud, 1),
            "rain": round(rain, 2) if rain is not None else None,
            # Class stamped server-side so the UI never re-derives thresholds.
            "cls": cls,
        })

    def _bucket(days_list):
        if not days_list:
            return {"days": 0, "avg_kwh": None, "best_day": None, "worst_day": None}
        kwhs = [k for _, k in days_list]
        best = max(days_list, key=lambda p: p[1])
        worst = min(days_list, key=lambda p: p[1])
        return {
            "days": len(days_list),
            "avg_kwh": round(sum(kwhs) / len(kwhs), 2),
            "best_day": {"date": best[0], "kwh": round(best[1], 2)},
            "worst_day": {"date": worst[0], "kwh": round(worst[1], 2)},
        }

    # Pearson r between cloud cover and energy over all matched days.
    pearson_r = None
    n = len(points)
    if n >= 2:
        xs = [p["cloud"] for p in points]
        ys = [p["kwh"] for p in points]
        mx = sum(xs) / n
        my = sum(ys) / n
        cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        vx = sum((x - mx) ** 2 for x in xs)
        vy = sum((y - my) ** 2 for y in ys)
        if vx > 0 and vy > 0:
            pearson_r = round(cov / ((vx ** 0.5) * (vy ** 0.5)), 3)

    return {
        "classes": {name: _bucket(b) for name, b in buckets.items()},
        "points": points,
        "pearson_r": pearson_r,
        "matched_days": n,
        "total_generation_days": int(total_generation_days or 0),
        "backfilled_through": through,
    }


def _history_hourly(since_iso: str) -> list[dict]:
    """
    Hourly-aggregated history. Rows are reshaped to look like raw readings
    (timestamp/solar_input/inverter_power keys) so existing frontend charts
    keep working; the extra *_avg/*_max fields are included as well.
    """
    # Hour bucket containing `since` -- include it fully.
    since_dt = datetime.fromisoformat(since_iso).replace(
        minute=0, second=0, microsecond=0
    )
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT * FROM readings_hourly
            WHERE hour_start >= ?
            ORDER BY hour_start ASC
            """,
            (since_dt.strftime("%Y-%m-%dT%H:%M:%S"),),
        ).fetchall()
    finally:
        conn.close()

    out = []
    for r in rows:
        d = dict(r)
        d["timestamp"] = d["hour_start"] + "+00:00" if len(d["hour_start"]) == 19 else d["hour_start"]
        # Compatibility aliases: averages feed the live-style charts.
        d.setdefault("solar_input", d.get("solar_input_avg"))
        d.setdefault("inverter_power", d.get("inverter_power_avg"))
        out.append(d)
    return out


def _daily_group_row(d: dict) -> dict:
    """Normalize a daily aggregate row and add frontend-compatible aliases."""
    d["timestamp"] = f"{d['day']}T00:00:00+00:00"
    d.setdefault("solar_input", d.get("solar_input_max"))
    d.setdefault("inverter_power", d.get("peak_power"))
    return d


def _history_daily(since_iso: Optional[str], range_str: str) -> list[dict]:
    """
    Daily-aggregated history covering everything older than the raw window,
    plus (for 'all') any recent days that only exist as raw rows yet --
    aggregated on the fly so the point count stays tiny.
    """
    conn = _connect()
    try:
        if range_str == "all":
            permanent = conn.execute(
                "SELECT * FROM readings_daily ORDER BY day ASC"
            ).fetchall()
            recent = conn.execute(
                """
                SELECT date(timestamp) AS day,
                       MAX(e_today) AS energy_kwh,
                       MAX(peak_power) AS peak_power,
                       MAX(solar_input) AS solar_input_max,
                       MAX(temperature) AS temperature_max,
                       COUNT(*) AS sample_count
                FROM readings
                WHERE date(timestamp) NOT IN (SELECT day FROM readings_daily)
                GROUP BY date(timestamp)
                ORDER BY day ASC
                """
            ).fetchall()
        else:
            since_day = since_iso[:10]
            permanent = conn.execute(
                "SELECT * FROM readings_daily WHERE day >= ? ORDER BY day ASC",
                (since_day,),
            ).fetchall()
            recent = []
    finally:
        conn.close()

    rows = [_daily_group_row(dict(r)) for r in permanent]
    rows += [_daily_group_row(dict(r)) for r in recent]
    rows.sort(key=lambda r: r["day"])
    return rows


def get_history(range_str: str = "24h") -> list[dict]:
    """
    Return history rows for the requested range.

    Short ranges hit the full-resolution `readings` table; longer ranges are
    served from the pre-aggregated tables so responses stay small no matter
    how many years of data exist.
    """
    if range_str in RAW_RANGES:
        return _history_raw(_range_to_since(range_str))
    if range_str in HOURLY_RANGES:
        return _history_hourly(_range_to_since(range_str))
    if range_str in DAILY_RANGES:
        return _history_daily(_range_to_since(range_str), range_str)
    raise ValueError(
        f"Unknown range '{range_str}'. Use one of: 1h, 24h, 7d, 30d, 90d, 365d, all."
    )


def _utc_iso(value: str) -> str:
    """Normalize a stored timestamp into an unambiguous UTC ISO string."""
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def local_days_ago_start_utc(days_back: int) -> str:
    """
    UTC ISO cutoff at local midnight N days back (0 = today's midnight), so
    string comparisons against stored UTC timestamps stay correct.
    """
    tz = _local_tz()
    now_local = datetime.now(timezone.utc).astimezone(tz)
    start_local = (now_local - timedelta(days=days_back)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return start_local.astimezone(timezone.utc).isoformat()


def get_live_today_kwh() -> Optional[float]:
    """
    Today's in-progress energy: MAX(e_today) seen since local midnight,
    straight from the raw `readings` table -- the exact query pattern used
    for "today" in get_generation_summary(), kept separate so the today
    projection endpoint can read the live counter without recomputing every
    KPI. Returns None before the first e_today reading of the day (no
    fabricated zeros).
    """
    tz = _local_tz()
    now_local = datetime.now(timezone.utc).astimezone(tz)
    midnight_utc = now_local.replace(
        hour=0, minute=0, second=0, microsecond=0
    ).astimezone(timezone.utc)

    conn = _connect()
    try:
        row = conn.execute(
            """
            SELECT MAX(e_today) AS kwh FROM readings
            WHERE timestamp >= ? AND e_today IS NOT NULL
            """,
            (midnight_utc.isoformat(),),
        ).fetchone()
        return row["kwh"] if row else None
    finally:
        conn.close()


def get_peak_solar_input(since: Optional[str] = None) -> Optional[dict]:
    """
    Peak Production source of truth: MAX(solar_input) taken directly from the
    full-resolution `readings` table, together with that row's original
    timestamp. Deliberately independent of every chart aggregation (15-minute
    session buckets, long-term profile averages) -- never interpolated or
    derived from averaged data.

    since: optional UTC ISO cutoff; None means the whole table.
    Returns {"value": W, "timestamp": UTC ISO} or None when there is no data.
    """
    conn = _connect()
    try:
        if since is None:
            row = conn.execute(
                "SELECT solar_input AS value, timestamp FROM readings "
                "WHERE solar_input IS NOT NULL "
                "ORDER BY solar_input DESC, timestamp ASC LIMIT 1"
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT solar_input AS value, timestamp FROM readings "
                "WHERE solar_input IS NOT NULL AND timestamp >= ? "
                "ORDER BY solar_input DESC, timestamp ASC LIMIT 1",
                (since,),
            ).fetchone()
    finally:
        conn.close()
    if row is None or row["value"] is None:
        return None
    return {"value": row["value"], "timestamp": _utc_iso(row["timestamp"])}


def get_daily_summary() -> list[dict]:
    """
    Max E_Today per calendar day (E_Today is cumulative-per-day from the
    inverter). Uses the permanent daily aggregates for old days and groups
    the still-raw recent days on the fly.
    """
    conn = _connect()
    try:
        permanent = conn.execute(
            "SELECT * FROM readings_daily ORDER BY day ASC"
        ).fetchall()
        recent = conn.execute(
            """
            SELECT date(timestamp) AS day,
                   MAX(e_today) AS energy_kwh,
                   MAX(peak_power) AS peak_power,
                   MAX(solar_input) AS solar_input_max,
                   MAX(temperature) AS temperature_max,
                   COUNT(*) AS sample_count
            FROM readings
            WHERE date(timestamp) NOT IN (SELECT day FROM readings_daily)
            GROUP BY date(timestamp)
            ORDER BY day ASC
            """
        ).fetchall()
    finally:
        conn.close()

    rows = [dict(r) for r in permanent] + [dict(r) for r in recent]
    rows.sort(key=lambda r: r["day"])
    return rows


def get_generation_summary() -> dict:
    """
    Generation KPIs in kWh:
    today / yesterday / this_week / this_month / this_year, plus two
    lifetime figures shown side by side in the UI.

    Sources, matching how the Daily Energy Log is built:
    - Completed days come from readings_daily.energy_kwh (max e_today) plus
      still-raw recent days grouped on the fly from `readings`.
    - "today" always uses the LIVE max e_today since local midnight straight
      from `readings`, so it reflects in-progress production even before any
      daily aggregate exists.
    - Week = Monday..today (ISO week); month/year boundaries are the local
      calendar month/year start, computed with config.TIMEZONE. Day keys are
      UTC dates; they coincide with local calendar days for every hour the
      sun is up as long as daylight doesn't cross UTC midnight (true for the
      intended IST-style deployments).
    - calculated_total sums every stored day total; the on-the-fly grouping
      of the current day contributes its live max e_today, so no separate
      addition is needed. It is the dashboard's own bookkeeping view.
    - inverter_lifetime is the newest e_total reading -- the running total
      reported directly by the inverter. The two lifetime figures can differ
      slightly (partial days, counter reset timing, rounding, data recorded
      before the dashboard existed); both are exposed so the UI can show
      that gap honestly instead of hiding it.

    The response also carries an `impact` block (Savings & Impact panel):
    pure arithmetic -- no extra queries. Lifetime savings follow the
    inverter's own cumulative counter (`inverter_lifetime` = newest e_total),
    while month/year keep using the same stored day buckets as the KPI
    strip. Money/CO2 figures always use the *current* tariff/emission factor
    from config (no rate history is kept, so changing ELECTRICITY_TARIFF
    recomputes every figure). With the tariff unset or <= 0 the block
    degrades to {"enabled": false} instead of showing fabricated zeros, and
    before the first e_total reading arrives the lifetime fields are null
    rather than 0.
    """
    tz = _local_tz()
    now_local = datetime.now(timezone.utc).astimezone(tz)
    today = now_local.date()

    midnight_utc = now_local.replace(
        hour=0, minute=0, second=0, microsecond=0
    ).astimezone(timezone.utc)

    conn = _connect()
    try:
        # Live today value: max e_today seen since local midnight.
        row = conn.execute(
            """
            SELECT MAX(e_today) AS kwh FROM readings
            WHERE timestamp >= ? AND e_today IS NOT NULL
            """,
            (midnight_utc.isoformat(),),
        ).fetchone()
        today_kwh = row["kwh"] if row else None

        # Lifetime: prefer the inverter's own cumulative counter.
        row = conn.execute(
            """
            SELECT e_total FROM readings
            WHERE e_total IS NOT NULL
            ORDER BY timestamp DESC LIMIT 1
            """
        ).fetchone()
        lifetime_kwh = row["e_total"] if row else None

        # Completed-day totals (same series as get_daily_summary).
        permanent = conn.execute(
            "SELECT day, energy_kwh FROM readings_daily WHERE energy_kwh IS NOT NULL"
        ).fetchall()
        raw_days = conn.execute(
            """
            SELECT date(timestamp) AS day,
                   MAX(e_today) AS energy_kwh
            FROM readings
            WHERE date(timestamp) NOT IN (SELECT day FROM readings_daily)
              AND e_today IS NOT NULL
            GROUP BY date(timestamp)
            """
        ).fetchall()
    finally:
        conn.close()

    # Bucket day totals into the requested windows.
    week_start = today - timedelta(days=today.weekday())   # Monday
    month_start = today.replace(day=1)
    year_start = today.replace(month=1, day=1)
    yesterday = today - timedelta(days=1)

    yesterday_kwh = 0.0
    week_kwh = 0.0
    month_kwh = 0.0
    year_kwh = 0.0
    days_sum = 0.0
    for r in list(permanent) + list(raw_days):
        try:
            d = datetime.strptime(r["day"], "%Y-%m-%d").date()
        except (TypeError, ValueError):
            continue
        energy = r["energy_kwh"] or 0.0
        days_sum += energy
        if d == yesterday:
            yesterday_kwh += energy
        if week_start <= d <= today:
            week_kwh += energy
        if month_start <= d <= today:
            month_kwh += energy
        if year_start <= d <= today:
            year_kwh += energy

    def _round(value):
        return round(value, 2) if value is not None else None

    # --- Savings & impact (money saved + CO2 avoided) --------------------
    tariff = config.ELECTRICITY_TARIFF
    if tariff is not None and tariff > 0:
        co2_factor = config.GRID_CO2_KG_PER_KWH
        # Lifetime basis: the inverter's own running counter (e_total) --
        # the same figure the KPI strip shows as Inverter Lifetime. Null
        # until the first e_total reading exists; no fabricated zeros.
        lifetime = lifetime_kwh
        impact = {
            "enabled": True,
            "tariff": tariff,
            "currency": config.CURRENCY_SYMBOL,
            "co2_factor": co2_factor,
            "lifetime_kwh": _round(lifetime),
            "this_month_kwh": _round(month_kwh),
            "this_year_kwh": _round(year_kwh),
            "lifetime_inr": (
                _round(lifetime * tariff) if lifetime is not None else None
            ),
            "this_month_inr": _round(month_kwh * tariff),
            "this_year_inr": _round(year_kwh * tariff),
            "lifetime_co2_kg": (
                _round(lifetime * co2_factor) if lifetime is not None else None
            ),
            "this_year_co2_t": _round(year_kwh * co2_factor / 1000.0),
        }
    else:
        impact = {"enabled": False}

    # --- Plant capacity: specific yield + capacity factor ------------------
    # Explicitly NOT true Performance Ratio (needs pyranometer) -- see
    # tooltip/README; v2 could use Open-Meteo radiation.
    # specific_yield = kwh / kwp, capacity_factor = today_kwh / (kwp * 24).
    # Null when kwp unset (<= 0) or when the kwh side has no data yet.
    try:
        kwp_raw = float(config.PLANT_CAPACITY_KWP)
    except (TypeError, ValueError):
        kwp_raw = 0.0
    if kwp_raw is not None and kwp_raw > 0:
        kwp = float(kwp_raw)
        capacity = {
            "kwp": kwp,
            "today_kwh_per_kwp": _round(today_kwh / kwp) if today_kwh is not None else None,
            "month_kwh_per_kwp": _round(month_kwh / kwp) if month_kwh is not None else None,
            "capacity_factor_today_pct": (
                _round(today_kwh / (kwp * 24.0) * 100.0)
                if today_kwh is not None else None
            ),
        }
    else:
        capacity = None

    return {
        "today": _round(today_kwh),
        "yesterday": _round(yesterday_kwh),
        "this_week": _round(week_kwh),
        "this_month": _round(month_kwh),
        "this_year": _round(year_kwh),
        # Dashboard bookkeeping: all stored day totals (today's live value is
        # included via the on-the-fly grouping of the current day).
        "calculated_total": _round(days_sum),
        # The inverter's own running counter, straight from the newest read.
        "inverter_lifetime": _round(lifetime_kwh),
        "impact": impact,
        "capacity": capacity,
    }


def get_generation_stats(
    from_day: Optional[str] = None, to_day: Optional[str] = None
) -> dict:
    """
    Range-selectable yield stats: total, average per day, best and worst day
    over [from_day, to_day] (inclusive, YYYY-MM-DD local dates).

    Day totals use the same series as get_daily_summary (readings_daily for
    completed days + on-the-fly grouping of still-raw recent days), and only
    days that actually have data are counted -- gaps in the range simply
    don't exist in the series.

    Validation: to_day must be <= today's local date and from_day must be >=
    the first day present in the database; violations raise ValueError (the
    endpoint turns that into an {"error": ...} response). When omitted,
    defaults are the last 30 days ending today.

    min_date/max_date always carry the full available range so the frontend
    can constrain its date pickers.
    """
    tz = _local_tz()
    today = datetime.now(timezone.utc).astimezone(tz).date()

    conn = _connect()
    try:
        permanent = conn.execute(
            "SELECT day, energy_kwh FROM readings_daily WHERE energy_kwh IS NOT NULL"
        ).fetchall()
        raw_days = conn.execute(
            """
            SELECT date(timestamp) AS day,
                   MAX(e_today) AS energy_kwh
            FROM readings
            WHERE date(timestamp) NOT IN (SELECT day FROM readings_daily)
              AND e_today IS NOT NULL
            GROUP BY date(timestamp)
            """
        ).fetchall()
    finally:
        conn.close()

    series: dict = {}
    first_day = None
    for r in list(permanent) + list(raw_days):
        try:
            d = datetime.strptime(r["day"], "%Y-%m-%d").date()
        except (TypeError, ValueError):
            continue
        series[d] = float(r["energy_kwh"] or 0.0)
        if first_day is None or d < first_day:
            first_day = d

    if first_day is None:
        raise ValueError("No generation data available yet.")

    def _parse(value: str, label: str):
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except (TypeError, ValueError):
            raise ValueError(
                f"Invalid '{label}' date {value!r}, expected YYYY-MM-DD."
            )

    end = _parse(to_day, "to") if to_day else today
    if end > today:
        raise ValueError(f"'to' ({to_day}) is after today ({today.isoformat()}).")

    start = (
        _parse(from_day, "from") if from_day
        else max(first_day, end - timedelta(days=29))
    )
    if start < first_day:
        raise ValueError(
            f"'from' ({from_day}) is before the first day with data "
            f"({first_day.isoformat()})."
        )
    if start > end:
        raise ValueError("'from' must not be after 'to'.")

    days = 0
    total = 0.0
    best = worst = None  # (date, kwh)
    for d in sorted(series):
        if start <= d <= end:
            kwh = series[d]
            days += 1
            total += kwh
            if best is None or kwh > best[1]:
                best = (d, kwh)
            if worst is None or kwh < worst[1]:
                worst = (d, kwh)

    def _round(v):
        return round(v, 2)

    def _day(pair):
        return {"date": pair[0].isoformat(), "kwh": _round(pair[1])} if pair else None

    return {
        "min_date": first_day.isoformat(),
        "max_date": today.isoformat(),
        "from": start.isoformat(),
        "to": end.isoformat(),
        "days": days,
        "total_kwh": _round(total),
        "average_daily_kwh": _round(total / days) if days else None,
        "best_day": _day(best),
        "worst_day": _day(worst),
    }


def get_generation_monthly(months_limit: int = 24) -> dict:
    """
    Monthly kWh totals for the Monthly Energy chart: every day total from the
    exact same series as get_daily_summary()/get_generation_summary()
    (readings_daily.energy_kwh for completed days + still-raw recent days
    grouped on the fly as MAX(e_today)), bucketed into months in Python via
    month = day[:7]. Day keys are UTC dates coinciding with local calendar
    days -- the documented assumption behind the KPI strip -- so no new day
    semantics are introduced here.

    Response:
      months         [{month: "2026-08", kwh, days_with_data}, ...] ascending,
                     limited to the most recent `months_limit` buckets.
                     days_with_data counts the day rows that contributed, so
                     months with gaps can be annotated instead of silently
                     averaged.
      first_month    earliest month with any data across ALL history (not
                     just the returned window) -- tells the UI how far back
                     the dataset reaches.
      yoy_available  True once at least one month has a same-month-last-year
                     counterpart in the data (>= 13 months of history); gates
                     the year-over-year rendering.

    No schema change; cost is one small scan over two tiny tables plus one
    grouped pass over the recent raw window.
    """
    conn = _connect()
    try:
        permanent = conn.execute(
            "SELECT day, energy_kwh FROM readings_daily WHERE energy_kwh IS NOT NULL"
        ).fetchall()
        raw_days = conn.execute(
            """
            SELECT date(timestamp) AS day,
                   MAX(e_today) AS energy_kwh
            FROM readings
            WHERE date(timestamp) NOT IN (SELECT day FROM readings_daily)
              AND e_today IS NOT NULL
            GROUP BY date(timestamp)
            """
        ).fetchall()
    finally:
        conn.close()

    kwh_by_month: dict = {}
    days_by_month: dict = {}
    for r in list(permanent) + list(raw_days):
        try:
            datetime.strptime(r["day"], "%Y-%m-%d")
        except (TypeError, ValueError):
            continue
        month = r["day"][:7]
        kwh_by_month[month] = kwh_by_month.get(month, 0.0) + float(r["energy_kwh"] or 0.0)
        days_by_month[month] = days_by_month.get(month, 0) + 1

    all_months = sorted(kwh_by_month)
    selected = all_months[-months_limit:] if months_limit else all_months

    def _shift_months(month: str, delta: int) -> str:
        year, mon = int(month[:4]), int(month[5:7])
        idx = year * 12 + (mon - 1) + delta
        return f"{idx // 12:04d}-{idx % 12 + 1:02d}"

    yoy_available = any(
        _shift_months(m, -12) in kwh_by_month for m in all_months
    ) if all_months else False

    return {
        "months": [
            {
                "month": m,
                "kwh": round(kwh_by_month[m], 2),
                "days_with_data": days_by_month[m],
            }
            for m in selected
        ],
        "first_month": all_months[0] if all_months else None,
        "yoy_available": yoy_available,
    }


# ---------------------------------------------------------------------------
# DB status introspection
# ---------------------------------------------------------------------------
def get_db_status() -> dict:
    """File size, row counts, last maintenance time, retention settings."""
    conn = _connect()
    try:
        counts = {}
        for table in ("readings", "readings_hourly", "readings_daily",
                      "readings_weather_daily"):
            counts[table] = conn.execute(
                f"SELECT COUNT(*) AS n FROM {table}"
            ).fetchone()["n"]
        last_maintenance = _get_meta(conn, "last_maintenance")
        last_vacuum = _get_meta(conn, "last_vacuum")
        total_powercuts = int(_get_meta(conn, "total_powercuts") or 0)
    finally:
        conn.close()

    size_bytes = os.path.getsize(config.DB_PATH) if os.path.exists(config.DB_PATH) else 0

    return {
        "db_path": config.DB_PATH,
        "size_bytes": size_bytes,
        "size_mb": round(size_bytes / (1024 * 1024), 2),
        "row_counts": counts,
        "last_maintenance": last_maintenance,
        "last_vacuum": last_vacuum,
        "total_powercuts": total_powercuts,
        "retention_days": config.RETENTION_DAYS,
        "maintenance_hour": config.MAINTENANCE_HOUR,
        "vacuum_enabled": config.ENABLE_VACUUM,
    }


# ---------------------------------------------------------------------------
# CSV export
# ---------------------------------------------------------------------------
CSV_FIELDNAMES = [
    "timestamp", "l1_voltage", "l1_current", "inverter_power",
    "solar_input", "temperature", "e_total", "e_today",
    "active_power", "peak_power",
]


def export_rows_to_csv(rows: list[dict]) -> str:
    """Serialize history rows (any shape) to CSV text."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_FIELDNAMES, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return buf.getvalue()


def export_csv(range_str: str = "all") -> str:
    return export_rows_to_csv(get_history(range_str))
