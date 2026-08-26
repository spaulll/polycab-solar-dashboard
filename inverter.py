"""
Modbus polling logic for the solar inverter, plus sunrise/sunset night-mode.

This is a direct adaptation of the original terminal script: same register
map, same decoding, same try/except error handling -- just wrapped for use
inside an async FastAPI background task.
"""
import datetime
from typing import Optional

from pymodbus.client import ModbusTcpClient
from astral import LocationInfo
from astral.sun import sun

import config

# Persistent Modbus client, reused across polls instead of reconnecting every
# cycle. Cheap inverter Wi-Fi/RS485-to-TCP dongles tend to handle a long-lived
# connection better than repeated connect/disconnect churn.
_client: Optional[ModbusTcpClient] = None


def _get_client() -> ModbusTcpClient:
    """Returns the shared client, creating it on first use."""
    global _client
    if _client is None:
        _client = ModbusTcpClient(
            config.INVERTER_IP, port=config.MODBUS_PORT, timeout=config.MODBUS_TIMEOUT
        )
    return _client


def close_client() -> None:
    """Closes and discards the shared client, if any. Call on app shutdown."""
    global _client
    if _client is not None:
        try:
            _client.close()
        except Exception:
            pass
        _client = None


def _city_info() -> LocationInfo:
    """The configured location -- single source of truth for sun math."""
    return LocationInfo(
        config.CITY, config.COUNTRY, config.TIMEZONE,
        config.LATITUDE, config.LONGITUDE,
    )


def local_tz():
    """The configured location's timezone (tzinfo object)."""
    return _city_info().tzinfo


def get_day_sun(for_date: Optional[datetime.date] = None) -> dict:
    """
    Sunrise/sunset for one local calendar date (defaults to today), as
    tz-aware ISO timestamps. This is the shared source of truth for the
    solar-day chart windows (Today / 7D / All views).
    """
    city_info = _city_info()
    d = for_date or datetime.date.today()
    s = sun(city_info.observer, d, tzinfo=city_info.tzinfo)
    return {
        "date": d.isoformat(),
        "sunrise": s["sunrise"].isoformat(),
        "sunset": s["sunset"].isoformat(),
    }


def get_seconds_until_sunrise() -> float:
    """
    Returns seconds until next sunrise if it is currently night.
    Returns 0.0 if it is currently daytime.
    """
    city_info = _city_info()
    now = datetime.datetime.now(city_info.tzinfo)

    s_today = sun(city_info.observer, datetime.date.today(), tzinfo=city_info.tzinfo)

    if now < s_today["sunrise"]:
        return (s_today["sunrise"] - now).total_seconds()

    if now > s_today["sunset"]:
        s_tomorrow = sun(
            city_info.observer,
            datetime.date.today() + datetime.timedelta(days=1),
            tzinfo=city_info.tzinfo,
        )
        return (s_tomorrow["sunrise"] - now).total_seconds()

    return 0.0


def is_night() -> bool:
    return get_seconds_until_sunrise() > 0.0


def get_sun_info() -> dict:
    """
    Returns today's/tomorrow's sunrise and sunset info for the configured
    location:
      - next_sunrise: ISO timestamp of the next sunrise (today if not yet
        happened, otherwise tomorrow's)
      - next_sunset: ISO timestamp of the next sunset (today if not yet
        happened, otherwise tomorrow's)
      - sunrise/sunset: endpoints of the sun arc currently being traced.
        Daytime and evening: today's window. After midnight (still night):
        sunset rolls back to *yesterday's*, so clients sweeping the arc from
        sunset to sunrise always anchor on the sunset that just happened --
        never on tonight's still-future one.
      - seconds_until_sunrise: 0 if it's currently daytime (sunrise already
        passed and sunset hasn't)
      - seconds_until_sunset: 0 if it's currently night (sunset already
        passed, before next sunrise)
    """
    city_info = _city_info()
    now = datetime.datetime.now(city_info.tzinfo)

    s_today = sun(city_info.observer, datetime.date.today(), tzinfo=city_info.tzinfo)
    s_tomorrow = sun(
        city_info.observer,
        datetime.date.today() + datetime.timedelta(days=1),
        tzinfo=city_info.tzinfo,
    )

    # Next sunrise: today's if still ahead of us, else tomorrow's.
    if now < s_today["sunrise"]:
        next_sunrise = s_today["sunrise"]
    else:
        next_sunrise = s_tomorrow["sunrise"]

    # Next sunset: today's if still ahead of us, else tomorrow's.
    if now < s_today["sunset"]:
        next_sunset = s_today["sunset"]
    else:
        next_sunset = s_tomorrow["sunset"]

    seconds_until_sunrise = max(0.0, (next_sunrise - now).total_seconds())
    seconds_until_sunset = max(0.0, (next_sunset - now).total_seconds())

    # If it's currently night, there's no meaningful "time until sunset" (the
    # sun already set); zero it out rather than showing tomorrow's sunset math.
    is_currently_night = now < s_today["sunrise"] or now > s_today["sunset"]
    if is_currently_night:
        seconds_until_sunset = 0.0

    # Arc-window endpoints: bracket "now". After midnight the current night
    # arc runs from yesterday's sunset to today's upcoming sunrise, so report
    # yesterday's sunset instead of today's (future) one.
    if now < s_today["sunrise"]:
        s_yesterday = sun(
            city_info.observer,
            datetime.date.today() - datetime.timedelta(days=1),
            tzinfo=city_info.tzinfo,
        )
        arc_sunset = s_yesterday["sunset"]
    else:
        arc_sunset = s_today["sunset"]

    return {
        "next_sunrise": next_sunrise.isoformat(),
        "next_sunset": next_sunset.isoformat(),
        # The current day/night arc window. Additive: lets clients place a
        # "now" marker on the true arc without deriving it from countdown
        # arithmetic. See docstring for how sunset shifts after midnight.
        "sunrise": s_today["sunrise"].isoformat(),
        "sunset": arc_sunset.isoformat(),
        "seconds_until_sunrise": seconds_until_sunrise,
        "seconds_until_sunset": seconds_until_sunset,
        "is_night": is_currently_night,
    }


def fetch_inverter_data() -> dict:
    """
    Fetches and decodes Modbus registers using a persistent connection.

    Reuses the shared client across calls instead of reconnecting every time.
    If the connection is dead or a read fails, the client is torn down so the
    *next* call reconnects cleanly rather than retrying on a broken socket.
    """
    client = _get_client()

    try:
        if not client.is_socket_open():
            if not client.connect():
                raise ConnectionError("Could not connect to Inverter Wi-Fi.")

        response = client.read_holding_registers(
            address=config.REGISTER_ADDRESS,
            count=config.REGISTER_COUNT,
            device_id=config.MODBUS_SLAVE_ID,
        )

        if response.isError():
            raise ValueError("Modbus read returned an error payload.")

        regs = response.registers

        # E_Total is a 32-bit integer spanning regs[32] (High Word) and regs[33] (Low Word).
        raw_e_total = (regs[32] << 16) + regs[33]

        data = {
            "L1_Voltage": regs[0] / 10.0,
            "L1_Current": regs[1] / 100.0,
            "Inverter_Power": regs[3] / 10.0,
            "Solar_Input": regs[18] / 10.0,
            "Temperature": float(regs[27]),
            "E_Total": float(raw_e_total),
            "E_Today": regs[39] / 1000.0,
            "Active_Power": regs[55] / 10.0,
            "Peak_Power": regs[59] / 10.0,
        }
        return data

    except Exception:
        # Connection may be in a bad state (timeout, reset, stale socket after
        # night mode, etc.) -- close it so the next poll reconnects fresh
        # instead of repeatedly failing on the same broken socket.
        close_client()
        raise
