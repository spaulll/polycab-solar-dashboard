"""
Solar-day session logic shared by the Power Over Time visualizations.

A "solar day" runs sunrise -> sunset for one local calendar date, using the
same astral/location configuration as the night-mode polling loop. These
helpers reshape raw readings into that shape without ever modifying them:

- today's window + its readings        -> range=today in /api/history
- per-date daylight sessions normalized
  to seconds-after-sunrise             -> 7D comparison view
- whole-history profile binned by
  seconds-after-sunrise                -> All long-term profile view

Night is treated as a solar-day boundary rather than a data gap: sessions
contain only daylight readings by construction.
"""
import datetime as dt
import math
import time

import config
import database
import inverter

# Resolution of per-day session curves sent to the 7D chart (seconds).
# The 7D view requests 900 (15-minute buckets); 60 remains available.
SESSION_BUCKET_SECONDS = 60
ALLOWED_SESSION_BINS = (60, 300, 900)

# Minimum fraction of the *expected* reading count a bucket must contain to
# count as observed. Expected count derives from the normal sampling interval
# (config.POLL_DELAY seconds between polls): a full bucket expects roughly
# bucket_seconds / POLL_DELAY samples (~180 at the 5 s default). Below this
# threshold -- e.g. after a power cut or comms loss covering most of the
# bucket -- the bucket is reported missing instead of averaged into a value
# that would fabricate production. Partial edge buckets (sunrise/sunset
# truncation, or the in-progress bucket on the current day) are held to a
# proportionally scaled expectation.
MIN_BUCKET_COVERAGE = 0.5

# Default bin width for the long-term profile (minutes).
PROFILE_BIN_MINUTES = 5

# Bin width for the projection's typical-day curve (minutes). Coarser than
# the default profile: the overlay only needs the day's overall shape.
PROJECTION_BIN_MINUTES = 15

# Sanity caps on request parameters.
MAX_SESSION_DAYS = 30
MAX_PROFILE_BIN_MINUTES = 30

# In-process cache for get_solar_profile() results, keyed by bin size. The
# aggregation scans every raw daylight reading, so repeated calls (All view,
# today projection) would otherwise re-run the same SQLite scan per request.
# The profile only changes as history grows -- new days land at sunrise and
# old raw data is downsampled once a night -- so a short TTL is enough; there
# is nothing to invalidate on wake-up.
PROFILE_CACHE_TTL_SECONDS = 15 * 60
_profile_cache: dict[int, tuple[float, dict]] = {}


def to_utc_naive_iso(aware_iso: str) -> str:
    """
    Convert a tz-aware ISO timestamp into a naive UTC ISO string that sorts
    correctly against the stored `readings.timestamp` format and parses with
    SQLite's julianday().
    """
    aware = dt.datetime.fromisoformat(aware_iso)
    utc_naive = aware.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return utc_naive.strftime("%Y-%m-%dT%H:%M:%S")


def get_today_window() -> dict:
    """Today's sun info plus the SQL-ready sunrise cutoff (`since`)."""
    info = inverter.get_day_sun()
    return {**info, "since": to_utc_naive_iso(info["sunrise"])}


def _bucket_daylight(
    rows: list[dict],
    sunrise: dt.datetime,
    day_end: dt.datetime,
    bin_seconds: int,
) -> tuple[list[dict], int]:
    """
    Average raw daylight readings into fixed buckets of seconds-after-sunrise.

    Bucket k covers [k*bin, (k+1)*bin) from sunrise. Returns
    (buckets, slot_count) where slot_count = ceil(daylight_span / bin) is the
    day's full visual width -- including buckets that ended up missing.

    A bucket is emitted only if it passes the MIN_BUCKET_COVERAGE rule;
    missing buckets are simply absent, so the caller (and chart) can
    distinguish "no evidence" from a genuine 0 W reading. Partial buckets at
    the sunrise/sunset edges -- and on the in-progress current day -- are
    held to an expectation scaled to their actual duration.
    """
    span = (day_end - sunrise).total_seconds()
    if span <= 0:
        return [], 0
    slot_count = math.ceil(span / bin_seconds)

    acc: dict[int, list] = {}  # slot -> [rows, s_sum, s_n, i_sum, i_n]
    for r in rows:
        t = dt.datetime.fromisoformat(r["timestamp"])
        if t.tzinfo is None:
            t = t.replace(tzinfo=dt.timezone.utc)
        offset = (t - sunrise).total_seconds()
        if offset < 0:
            continue
        k = int(offset // bin_seconds)
        cell = acc.setdefault(k, [0, 0.0, 0, 0.0, 0])
        cell[0] += 1
        if r["solar_input"] is not None:
            cell[1] += r["solar_input"]
            cell[2] += 1
        if r["inverter_power"] is not None:
            cell[3] += r["inverter_power"]
            cell[4] += 1

    expected_per_slot = bin_seconds / max(config.POLL_DELAY, 0.001)
    buckets = []
    for k in range(slot_count):
        cell = acc.get(k)
        n_rows = cell[0] if cell else 0
        # Expected count scales down for truncated slots (sunrise/sunset
        # edges, today's in-progress bucket).
        slot_span = min((k + 1) * bin_seconds, span) - k * bin_seconds
        expected = max(1.0, slot_span / max(config.POLL_DELAY, 0.001))
        if n_rows < MIN_BUCKET_COVERAGE * expected:
            continue
        _, s_sum, s_n, i_sum, i_n = cell
        buckets.append({
            "o": k * bin_seconds,
            "s": round(s_sum / s_n, 1) if s_n else None,
            "i": round(i_sum / i_n, 1) if i_n else None,
        })
    return buckets, slot_count


def get_solar_sessions(days: int = 7, bin_seconds: int = SESSION_BUCKET_SECONDS) -> dict:
    """
    Daylight sessions for the last N local dates (oldest first), each
    normalized to its own sunrise:

        {"date", "sunrise", "sunset", "complete", "bin_seconds", "slots",
         "buckets": [{"o": seconds after sunrise, "s": W, "i": W}]}

    `slots` is the day's full bucket width; only buckets that pass the
    coverage rule appear in `buckets`. Days with no recorded daylight data
    carry an empty list -- nothing is fabricated.
    """
    days = max(1, min(int(days), MAX_SESSION_DAYS))
    if bin_seconds not in ALLOWED_SESSION_BINS:
        raise ValueError(
            f"Unsupported bin '{bin_seconds}'. Use one of: {ALLOWED_SESSION_BINS}."
        )
    today_local = dt.datetime.now(inverter.local_tz()).date()
    now_utc = dt.datetime.now(dt.timezone.utc)

    sessions = []
    for i in range(days - 1, -1, -1):
        info = inverter.get_day_sun(today_local - dt.timedelta(days=i))
        sunrise = dt.datetime.fromisoformat(info["sunrise"])
        sunset = dt.datetime.fromisoformat(info["sunset"])
        rows = database.get_history_between(
            to_utc_naive_iso(info["sunrise"]),
            to_utc_naive_iso(info["sunset"]),
        )
        # The current day's daylight window ends 'now' until sunset passes.
        day_end = min(sunset, now_utc)
        buckets, slot_count = _bucket_daylight(rows, sunrise, day_end, bin_seconds)
        sessions.append({
            "date": info["date"],
            "sunrise": info["sunrise"],
            "sunset": info["sunset"],
            "complete": now_utc >= sunset,
            "bin_seconds": bin_seconds,
            "slots": slot_count,
            "buckets": buckets,
        })

    return {
        "days": days,
        "bucket_seconds": bin_seconds,
        "sessions": sessions,
    }


def _profile_windows(start_local: dt.date, end_local: dt.date) -> list[tuple[str, str]]:
    """SQL-ready (sunrise, sunset) UTC pairs covering every date in range."""
    windows = []
    d = start_local
    while d <= end_local:
        info = inverter.get_day_sun(d)
        windows.append((
            to_utc_naive_iso(info["sunrise"]),
            to_utc_naive_iso(info["sunset"]),
        ))
        d += dt.timedelta(days=1)
    return windows


def get_solar_profile(bin_minutes: int = PROFILE_BIN_MINUTES) -> dict:
    """
    Long-term average power vs position within the solar day, aggregated
    over every historical solar day present in the raw table.

    The aggregation itself happens inside SQLite (see
    database.aggregate_solar_profile); this function only supplies the
    per-date sun windows. Results are cached in-process per bin size for
    PROFILE_CACHE_TTL_SECONDS -- the underlying history only grows on the
    scale of days, so a slightly stale profile is always acceptable.
    """
    bin_seconds = max(60, min(int(bin_minutes), MAX_PROFILE_BIN_MINUTES) * 60)

    now = time.monotonic()
    cached = _profile_cache.get(bin_seconds)
    if cached is not None and (now - cached[0]) < PROFILE_CACHE_TTL_SECONDS:
        return cached[1]

    lo, hi = database.get_readings_time_span()
    bins = []
    day_count = 0
    if lo and hi:
        tz = inverter.local_tz()
        # Extend one day on each side of the span so no daylight reading is
        # missed at the edges (a local date's window can cross UTC midnight).
        first = dt.datetime.fromisoformat(lo).astimezone(tz).date() - dt.timedelta(days=1)
        last = dt.datetime.fromisoformat(hi).astimezone(tz).date() + dt.timedelta(days=1)
        windows = _profile_windows(first, last)
        day_count = len(windows)
        bins = database.aggregate_solar_profile(windows, bin_seconds)

    result = {
        "bin_seconds": bin_seconds,
        "day_count": day_count,
        "bins": bins,
    }
    _profile_cache[bin_seconds] = (now, result)
    return result


# ---------------------------------------------------------------------------
# Today's projected finish
# ---------------------------------------------------------------------------
def _typical_cumulative(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """
    Cumulative-energy breakpoints [(o, cum_Ws)] for the typical-day curve.

    typical(o) is the piecewise-linear curve through the profile points
    (o, avg AC W), clamped to 0 outside [first_o, last_o]. Integrating it
    segment by segment (trapezoid) gives F(o) with F(first_o) = 0, so any
    integral between two offsets is a lookup + interpolation on this table.
    """
    out = [(pts[0][0], 0.0)]
    cum = 0.0
    prev_o, prev_w = pts[0]
    for o, w in pts[1:]:
        cum += (prev_w + w) * 0.5 * (o - prev_o)
        out.append((o, cum))
        prev_o, prev_w = o, w
    return out


def _cum_at(cum_pts: list[tuple[float, float]], o: float) -> float:
    """F(o) for o inside the curve; 0 before it, the full total after it."""
    if o <= cum_pts[0][0]:
        return 0.0
    if o >= cum_pts[-1][0]:
        return cum_pts[-1][1]
    for (o0, c0), (o1, c1) in zip(cum_pts, cum_pts[1:]):
        if o <= o1:
            frac = (o - o0) / (o1 - o0) if o1 > o0 else 0.0
            return c0 + frac * (c1 - c0)
    return cum_pts[-1][1]


def get_today_projection() -> dict:
    """
    Today's projected finish: how many kWh this day will likely end at, plus
    the "typical day" curve behind the Today chart.

    The typical day is get_solar_profile(bin_minutes=15) -- long-term average
    power vs seconds-after-sunrise. AC output (`i_avg`) is used, not DC solar
    input, because e_today counts AC energy; comparing like with like keeps
    pace_ratio honest. Everything is expressed in kWh by integrating the
    average-W curve over seconds-after-sunrise and dividing by 3600:

        elapsed_expected   = F(now)          # what a typical day yields by now
        remaining_expected = total - elapsed # what it would still add
        projected_final    = live e_today + remaining_expected
        pace_ratio         = live e_today / elapsed_expected

    Degradation is left to the caller/UI: `day_count` < 3 means there is not
    enough history to call any day "typical", so clients hide the overlay and
    pace chip rather than presenting noise. Before sunrise / after sunset the
    projection freezes at the honest endpoints (remaining = 0 once sunset has
    passed, i.e. projected_final converges to the actual final yield).
    """
    info = get_today_window()
    sunrise = dt.datetime.fromisoformat(info["sunrise"])
    sunset = dt.datetime.fromisoformat(info["sunset"])
    now_utc = dt.datetime.now(dt.timezone.utc)
    span = max(0.0, (sunset - sunrise).total_seconds())
    now_offset = (now_utc - sunrise).total_seconds()

    profile = get_solar_profile(PROJECTION_BIN_MINUTES)
    # Only bins with an actual AC-average form the curve; gaps stay absent so
    # neither the integral nor the chart invents power where none was seen.
    pts = [
        (b["o"], b["i_avg"])
        for b in profile["bins"]
        if b.get("i_avg") is not None
    ]
    curve = [{"o": o, "w": round(w, 1)} for o, w in pts]

    # Honest history length for the UI degradation rule ("no typical day
    # before 3 recorded days"). profile.day_count deliberately pads the span
    # by one day per side to catch edge daylight, which would let a single
    # day of history pass the >= 3 gate -- count actual data days instead.
    lo, hi = database.get_readings_time_span()
    if lo and hi:
        tz = inverter.local_tz()
        first = dt.datetime.fromisoformat(lo).astimezone(tz).date()
        last = dt.datetime.fromisoformat(hi).astimezone(tz).date()
        day_count = (last - first).days + 1
    else:
        day_count = 0

    current_kwh = database.get_live_today_kwh()

    typical_total_kwh = None
    projected_final_kwh = None
    pace_ratio = None

    if pts:
        cum = _typical_cumulative(pts)
        # W·s -> kWh: J (= W·s) / 3600 = Wh, / 1000 = kWh.
        WS_TO_KWH = 1.0 / 3_600_000.0
        total_ws = _cum_at(cum, span)  # == F(last_o): area under the whole curve
        typical_total_kwh = total_ws * WS_TO_KWH

        if now_offset <= 0:
            # Night, before today's window: nothing earned, everything expected.
            elapsed_kwh = 0.0
            remaining_kwh = typical_total_kwh
        elif now_offset >= span:
            # Sunset passed: freeze at the actual final vs the typical day.
            elapsed_kwh = typical_total_kwh
            remaining_kwh = 0.0
        else:
            elapsed_kwh = _cum_at(cum, now_offset) * WS_TO_KWH
            remaining_kwh = typical_total_kwh - elapsed_kwh

        if now_offset >= span:
            projected_final_kwh = current_kwh
        elif current_kwh is not None:
            projected_final_kwh = current_kwh + remaining_kwh

        if current_kwh is not None and elapsed_kwh > 0:
            pace_ratio = current_kwh / elapsed_kwh

    def _round(value, digits=2):
        return round(value, digits) if value is not None else None

    return {
        "date": info["date"],
        "day_count": day_count,
        "bin_seconds": profile["bin_seconds"],
        "now_offset_seconds": _round(now_offset, 1),
        "current_kwh": _round(current_kwh),
        "typical_total_kwh": _round(typical_total_kwh),
        "projected_final_kwh": _round(projected_final_kwh),
        "pace_ratio": _round(pace_ratio),
        "curve": curve,
    }
