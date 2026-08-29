"""
Modbus polling logic for the solar inverter, plus sunrise/sunset night-mode.

This is a direct adaptation of the original terminal script: same register
map, same decoding, same try/except error handling -- just wrapped for use
inside an async FastAPI background task.
"""
import datetime
import math
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


def _solar_elevation_deg(dt: datetime.datetime) -> float:
    """NOAA low-precision solar elevation for a tz-aware datetime."""
    dt_utc = dt.astimezone(datetime.timezone.utc)
    doy = dt_utc.timetuple().tm_yday
    hour = dt_utc.hour + dt_utc.minute / 60 + dt_utc.second / 3600
    gamma = 2 * math.pi / 365.0 * (doy - 1 + (hour - 12) / 24.0)
    decl = (0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma)
            - 0.006758 * math.cos(2 * gamma) + 0.000907 * math.sin(2 * gamma)
            - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma))
    eot = 229.18 * (0.000075 + 0.001868 * math.cos(gamma)
                    - 0.032077 * math.sin(gamma) - 0.014615 * math.cos(2 * gamma)
                    - 0.040849 * math.sin(2 * gamma))
    solar_min = (hour * 60 + eot + 4 * config.LONGITUDE) % 1440
    ha = math.radians(solar_min / 4 - 180)
    latr = math.radians(config.LATITUDE)
    cos_zen = (math.sin(latr) * math.sin(decl)
               + math.cos(latr) * math.cos(decl) * math.cos(ha))
    cos_zen = max(-1.0, min(1.0, cos_zen))
    return 90.0 - math.degrees(math.acos(cos_zen))


def _noaa_sun_times(d: datetime.date):
    """Sunrise/sunset by bisection on the NOAA elevation (astral fallback)."""
    tz = _city_info().tzinfo
    midnight = datetime.datetime(d.year, d.month, d.day, tzinfo=tz)
    noon = midnight + datetime.timedelta(hours=12)
    target = -0.833
    lo, hi = midnight, noon
    for _ in range(40):                       # rising half -> sunrise
        mid = lo + (hi - lo) / 2
        if _solar_elevation_deg(mid) < target:
            lo = mid
        else:
            hi = mid
    sunrise = lo + (hi - lo) / 2
    lo, hi = noon, midnight + datetime.timedelta(days=1)
    for _ in range(40):                       # falling half -> sunset
        mid = lo + (hi - lo) / 2
        if _solar_elevation_deg(mid) > target:
            lo = mid
        else:
            hi = mid
    return sunrise, lo + (hi - lo) / 2


def _sun_times(d: datetime.date):
    """
    (sunrise, sunset) tz-aware datetimes for one local calendar date.
    Prefers astral; falls back to NOAA bisection because astral's solver
    raises "Unable to find a sunrise" for a few boundary dates each year
    at some longitudes (observed for Kolkata: Mar 8 and Apr 1).
    """
    try:
        s = sun(_city_info().observer, d, tzinfo=_city_info().tzinfo)
        return s["sunrise"], s["sunset"]
    except ValueError:
        return _noaa_sun_times(d)


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
    sunrise, sunset = _sun_times(d)
    return {
        "date": d.isoformat(),
        "sunrise": sunrise.isoformat(),
        "sunset": sunset.isoformat(),
    }


def get_seconds_until_sunrise() -> float:
    """
    Returns seconds until next sunrise if it is currently night.
    Returns 0.0 if it is currently daytime.
    """
    city_info = _city_info()
    now = datetime.datetime.now(city_info.tzinfo)

    s_today = _sun_times(datetime.date.today())

    if now < s_today[0]:
        return (s_today[0] - now).total_seconds()

    if now > s_today[1]:
        s_tomorrow = _sun_times(
            datetime.date.today() + datetime.timedelta(days=1))
        return (s_tomorrow[0] - now).total_seconds()

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

    s_today = _sun_times(datetime.date.today())
    s_tomorrow = _sun_times(
        datetime.date.today() + datetime.timedelta(days=1))

    # Next sunrise: today's if still ahead of us, else tomorrow's.
    if now < s_today[0]:
        next_sunrise = s_today[0]
    else:
        next_sunrise = s_tomorrow[0]

    # Next sunset: today's if still ahead of us, else tomorrow's.
    if now < s_today[1]:
        next_sunset = s_today[1]
    else:
        next_sunset = s_tomorrow[1]

    seconds_until_sunrise = max(0.0, (next_sunrise - now).total_seconds())
    seconds_until_sunset = max(0.0, (next_sunset - now).total_seconds())

    # If it's currently night, there's no meaningful "time until sunset" (the
    # sun already set); zero it out rather than showing tomorrow's sunset math.
    is_currently_night = now < s_today[0] or now > s_today[1]
    if is_currently_night:
        seconds_until_sunset = 0.0

    # Arc-window endpoints: bracket "now". After midnight the current night
    # arc runs from yesterday's sunset to today's upcoming sunrise, so report
    # yesterday's sunset instead of today's (future) one.
    if now < s_today[0]:
        s_yesterday = _sun_times(
            datetime.date.today() - datetime.timedelta(days=1))
        arc_sunset = s_yesterday[1]
    else:
        arc_sunset = s_today[1]

    return {
        "next_sunrise": next_sunrise.isoformat(),
        "next_sunset": next_sunset.isoformat(),
        # The current day/night arc window. Additive: lets clients place a
        # "now" marker on the true arc without deriving it from countdown
        # arithmetic. See docstring for how sunset shifts after midnight.
        "sunrise": s_today[0].isoformat(),
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
