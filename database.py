"""
SQLite storage layer.

Writes happen on a dedicated background thread via a queue, so the async
Modbus polling loop never blocks on disk I/O. Reads (for the REST history
endpoints) open short-lived connections on demand -- SQLite handles
concurrent readers/writer fine for this single-user, local-network use case.
"""
import csv
import io
import queue
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from typing import Optional

import config

_write_queue: "queue.Queue[dict]" = queue.Queue()
_writer_thread: Optional[threading.Thread] = None
_stop_event = threading.Event()

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
"""


def init_db() -> None:
    """Create the DB file and schema if they don't already exist."""
    conn = sqlite3.connect(config.DB_PATH)
    try:
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()


def _writer_loop() -> None:
    """Runs on a background thread. Pulls readings off the queue and writes them."""
    conn = sqlite3.connect(config.DB_PATH)
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


def _range_to_since(range_str: str) -> Optional[str]:
    """Convert a range keyword into an ISO timestamp cutoff. None means 'all'."""
    now = datetime.now(timezone.utc)
    mapping = {
        "1h": timedelta(hours=1),
        "24h": timedelta(hours=24),
        "7d": timedelta(days=7),
    }
    if range_str == "all":
        return None
    delta = mapping.get(range_str)
    if delta is None:
        raise ValueError(f"Unknown range '{range_str}'. Use one of: 1h, 24h, 7d, all.")
    return (now - delta).isoformat()


def get_history(range_str: str = "24h") -> list[dict]:
    since = _range_to_since(range_str)
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
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


def get_daily_summary() -> list[dict]:
    """Max E_Today per calendar day (E_Today is cumulative-per-day from the inverter)."""
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT
                date(timestamp) AS day,
                MAX(e_today) AS energy_kwh,
                MAX(peak_power) AS peak_power,
                COUNT(*) AS sample_count
            FROM readings
            GROUP BY date(timestamp)
            ORDER BY day ASC
            """
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


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
