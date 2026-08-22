// Static configuration: endpoints and tuning constants for the dashboard.

const API_BASE = ''; // same origin
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

// Insert a null point when the gap between consecutive samples exceeds this,
// so Chart.js (spanGaps:false) breaks the line instead of drawing a
// misleading straight segment across it (restart, Wi-Fi drop, night).
const GAP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// In-memory trim window per range so the live chart doesn't grow unbounded
// during a long session.
const MAX_POINTS = { '1h': 800, 'today': 3000, '7d': 5000, 'all': 6000 };

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

export {
  API_BASE,
  WS_URL,
  GAP_THRESHOLD_MS,
  MAX_POINTS,
  SESSION_DAYS,
  SESSION_BIN_SECONDS,
  WS_RECONNECT_DELAY_MS,
  DAILY_SUMMARY_REFRESH_MS,
  POWERCUTS_REFRESH_MS,
  SUN_INFO_REFRESH_MS,
  SUN_COUNTDOWN_TICK_MS,
};
