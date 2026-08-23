"""
Configuration for the Solar Dashboard backend.

Values are loaded from (in order of precedence):
  1. Real environment variables (e.g. set by systemd, docker, or your shell)
  2. A `.env` file in the project root, if present (see `.env.example`)
  3. The hardcoded defaults below

Copy `.env.example` to `.env` and fill in your real values -- `.env` is
gitignored so your actual inverter IP and home coordinates never get
committed or published alongside this code.
"""
import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the project root (same directory as this file) without
# overriding any variables already set in the real environment.
load_dotenv(dotenv_path=Path(__file__).resolve().parent / ".env", override=False)


def _env_float(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


def _env_bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


# --- Modbus / Inverter connection ---
INVERTER_IP: str = os.environ.get("INVERTER_IP", "192.168.1.100")
MODBUS_PORT: int = _env_int("MODBUS_PORT", 502)
MODBUS_SLAVE_ID: int = _env_int("MODBUS_SLAVE_ID", 1)
MODBUS_TIMEOUT: float = _env_float("MODBUS_TIMEOUT", 3.0)

# Register map (matches original script)
REGISTER_ADDRESS: int = _env_int("REGISTER_ADDRESS", 4097)
REGISTER_COUNT: int = _env_int("REGISTER_COUNT", 60)

# --- Polling ---
POLL_DELAY: float = _env_float("POLL_DELAY", 5.0)  # seconds between reads during the day
ERROR_RETRY_DELAY: float = _env_float("ERROR_RETRY_DELAY", 5.0)  # seconds to wait after a read error

# --- Powercut detection ---
# Consecutive daytime read errors required before a powercut is even
# considered -- short glitches (Wi-Fi dongle hiccups etc.) stay below this
# and are never recorded.
POWERCUT_ERROR_THRESHOLD: int = _env_int("POWERCUT_ERROR_THRESHOLD", 5)
# Optional: IP of an always-on device on the same power circuit (e.g. a
# Wi-Fi extender). Used for both powercut detection paths:
#   - Zero-production path: if a successful Modbus read reports both power
#     values as ~0, this IP is pinged -- unreachable here means a real cut.
#   - Error path: after N consecutive Modbus errors, a powercut is recorded
#     only when this IP AND the inverter IP are both unreachable.
# Leave empty to treat N consecutive errors as a powercut unconditionally
# (the zero-production path is then disabled entirely).
POWERCUT_CHECK_IP: str = os.environ.get("POWERCUT_CHECK_IP", "").strip()

# --- Storage ---
DB_PATH: str = os.environ.get("DB_PATH", "solar_data.db")

# --- Long-term data management ---
# Full-resolution readings older than this (in days) are downsampled into
# hourly/daily aggregate tables and then deleted from `readings`.
RETENTION_DAYS: int = _env_int("RETENTION_DAYS", 60)
# Local hour of day when the daily maintenance task runs (aggregation,
# retention cleanup, weekly VACUUM).
MAINTENANCE_HOUR: int = _env_int("MAINTENANCE_HOUR", 3)
# Whether the weekly VACUUM/ANALYZE pass is allowed to run.
ENABLE_VACUUM: bool = _env_bool("ENABLE_VACUUM", True)

# --- Location (for sunrise/sunset night-mode logic) ---
# NOTE: set these to YOUR location for accurate sunrise/sunset timing.
# The values below are just placeholders (New Delhi) -- if you're sharing
# this repo/config publicly, don't commit your real coordinates.
CITY: str = os.environ.get("CITY", "New Delhi")
COUNTRY: str = os.environ.get("COUNTRY", "India")
TIMEZONE: str = os.environ.get("TIMEZONE", "Asia/Kolkata")
LATITUDE: float = _env_float("LATITUDE", 28.6139)
LONGITUDE: float = _env_float("LONGITUDE", 77.2090)

# --- Server ---
HOST: str = os.environ.get("HOST", "0.0.0.0")
PORT: int = _env_int("PORT", 8000)
