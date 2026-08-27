// Static configuration: endpoints and tuning constants for the dashboard.

const API_BASE = ''; // same origin
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

// Insert a null point when the gap between consecutive samples exceeds this,
// so Chart.js (spanGaps:false) breaks the line instead of drawing a
// misleading straight segment across it (restart, Wi-Fi drop, night).
const GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Trim window for ROLLING ranges so the live chart doesn't grow unbounded
// during a long session: the 1H view slides forward, so the oldest points
// leave as new ones arrive.
//
// The Today view deliberately has NO entry here -- it renders a bounded
// solar-day session (sunrise -> sunset), not a sliding window. Capping it
// would erase the early morning point-by-point the moment the day's sample
// count crossed the cap (guaranteed on any page opened in the afternoon).
// Its memory is bounded structurally instead: appends stop at sunset and
// pre-sunrise stale points are purged by timestamp. See appendLivePoint().
const MAX_POINTS = { '1h': 800 };

// Pathological-flood failsafe for the Today view (NOT a normal trim target):
// sized far above any real solar day (a full day at ~4 s cadence would be
// ~21k points) so it can only ever trigger on absurd poll rates or bugs,
// protecting memory without ever clipping a legitimate day.
const TODAY_MAX_POINTS = 20000;

// 7D view: how many solar days to compare (including the current one).
const SESSION_DAYS = 7;

// 7D view: bucket width in seconds for the sequential solar-day timeline.
const SESSION_BIN_SECONDS = 900; // 15 minutes

// WebSocket reconnect delay after the connection drops.
const WS_RECONNECT_DELAY_MS = 3000;

// Refresh cadence for cheap background queries.
const DAILY_SUMMARY_REFRESH_MS = 5 * 60 * 1000;
const POWERCUTS_REFRESH_MS = 60 * 1000;
const SUN_INFO_REFRESH_MS = 5 * 60 * 1000;
const SUN_COUNTDOWN_TICK_MS = 1000;

// Monthly Energy: the full month series is fetched in one request (the
// endpoint's hard cap) and sliced client-side per 12/24/All toggle.
const MONTHLY_ALL_MONTHS = 1200;

// Weather refresh cadence (backend caches server-side too).
const WEATHER_REFRESH_MS = 15 * 60 * 1000;

export {
  API_BASE,
  WS_URL,
  GAP_THRESHOLD_MS,
  MAX_POINTS,
  TODAY_MAX_POINTS,
  SESSION_DAYS,
  SESSION_BIN_SECONDS,
  WS_RECONNECT_DELAY_MS,
  DAILY_SUMMARY_REFRESH_MS,
  POWERCUTS_REFRESH_MS,
  SUN_INFO_REFRESH_MS,
  SUN_COUNTDOWN_TICK_MS,
  WEATHER_REFRESH_MS,
  MONTHLY_ALL_MONTHS,
};
