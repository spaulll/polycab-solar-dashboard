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

        summary = {
            "ran_at": started,
            "cutoff": cutoff,
            "hourly_upserts": hourly_rows,
            "daily_upserts": daily_rows,
            "raw_deleted": deleted_rows,
            "vacuumed": vacuumed,
        }
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


# ---------------------------------------------------------------------------
# DB status introspection
# ---------------------------------------------------------------------------
def get_db_status() -> dict:
    """File size, row counts, last maintenance time, retention settings."""
    conn = _connect()
    try:
        counts = {}
        for table in ("readings", "readings_hourly", "readings_daily"):
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
def export_csv(range_str: str = "all") -> str:
    rows = get_history(range_str)
    buf = io.StringIO()
    fieldnames = [
        "timestamp", "l1_voltage", "l1_current", "inverter_power",
        "solar_input", "temperature", "e_total", "e_today",
        "active_power", "peak_power",
    ]
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return buf.getvalue()
