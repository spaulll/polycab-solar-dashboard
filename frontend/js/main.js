// Entry point: loads initial data, wires UI events and WebSocket messages,
// and starts the periodic refreshes. All other modules are plain imports
// with no knowledge of this wiring.

import { DAILY_SUMMARY_REFRESH_MS, POWERCUTS_REFRESH_MS, SUN_INFO_REFRESH_MS } from './config.js';
import { state, setRange } from './state.js';
import { fetchHistory, fetchSolarSessions, fetchSolarProfile, fetchPeakProduction, fetchDailySummary, fetchGenerationSummary, fetchStatus, fetchPowercutCount, csvExportURL } from './api.js';
import { connectWebSocket } from './ws.js';
import {
  setMode, setNightText, setConn, setConnText, NIGHT_TEXT_DEFAULT,
  updateStatCards, dimStatCards, setLastUpdated, setInverterStatus,
  renderGenerationSummary,
} from './ui.js';
import { renderHistory, renderSessions, renderProfile, appendLivePoint, renderDailySummary, renderCumulative, setCumulativeRange } from './charts.js';
import { computeInsights, renderPeakInsight } from './insights.js';
import { updateSunInfo, refreshSunInfo, startSunTicker } from './sun.js';
import { initYieldCard, loadYieldStats } from './yield.js';
import { initWeather } from './weather.js';
import { initTheme } from './theme.js';
import { applyChartTheme } from './charts.js';

// ---------- Powercuts counter ----------
let pcRange = 'today';

async function loadPowercutCount(){
  try{
    document.getElementById('pcCount').textContent = await fetchPowercutCount(pcRange);
  }catch(e){
    console.error('Failed to load powercut count', e);
  }
}

document.getElementById('pcRange').addEventListener('change', (e) => {
  pcRange = e.target.value;
  loadPowercutCount();
});

// ---------- Day-mode polling manager ----------
// Daily summary and powercuts only change while the inverter is awake, so
// their intervals run in day mode and are torn down during night mode.
const dayTimers = [];

function startDayPolling(){
  if(dayTimers.length) return; // already running
  dayTimers.push(setInterval(loadDailySummary, DAILY_SUMMARY_REFRESH_MS));
  dayTimers.push(setInterval(loadGenerationSummary, DAILY_SUMMARY_REFRESH_MS));
  dayTimers.push(setInterval(loadYieldStats, DAILY_SUMMARY_REFRESH_MS));
  dayTimers.push(setInterval(loadPowercutCount, POWERCUTS_REFRESH_MS));
}

function stopDayPolling(){
  dayTimers.forEach(clearInterval);
  dayTimers.length = 0;
}

// ---------- Data loading ----------
// Each range has its own data source and chart view:
//   1h/today -> /api/history (today additionally carries its sun window)
//   7d       -> /api/history/solar-sessions (per-day, normalized to sunrise)
//   all      -> /api/history/solar-profile (long-term normalized profile)
// Peak Production always comes separately from /api/insights/peak, which
// reads MAX(raw DB reading) + its record timestamp -- fully independent of
// the chart aggregation for the active range.
async function loadHistory(){
  try{
    loadPeakProduction();
    if(state.range === '7d'){
      const sessions = await fetchSolarSessions();
      renderSessions(sessions);
      computeInsights(collectSessionReadings(sessions));
    } else if(state.range === 'all'){
      const profile = await fetchSolarProfile();
      renderProfile(profile);
      computeInsights(collectProfileReadings(profile));
    } else {
      const {readings, sun} = await fetchHistory(state.range);
      renderHistory(readings, sun);
      computeInsights(readings);
    }
  }catch(e){
    console.error('Failed to load history', e);
  }
}

// Session buckets and profile bins only feed the range averages; Peak
// Production never uses them.
function collectSessionReadings(sessions){
  const out = [];
  for(const s of sessions){
    for(const p of s.buckets || []){
      out.push({solar_input: p.s, inverter_power: p.i});
    }
  }
  return out;
}

function collectProfileReadings(profile){
  return (profile.bins || []).map(b => ({
    solar_input: b.s_avg,
    inverter_power: b.i_avg,
  }));
}

// Guarded loader so a slow response from a previous range can't overwrite
// the peak shown for the currently selected one.
let peakReqId = 0;

async function loadPeakProduction(){
  const reqId = ++peakReqId;
  const range = state.range;
  try{
    const peak = await fetchPeakProduction(range);
    if(reqId !== peakReqId || range !== state.range) return;
    renderPeakInsight(peak);
  }catch(e){
    console.error('Failed to load peak production', e);
    if(reqId === peakReqId && range === state.range) renderPeakInsight(null);
  }
}

async function loadDailySummary(){
  try{
    const days = await fetchDailySummary();
    renderDailySummary(days);
    // Same aggregated series feeds the cumulative running-total chart; the
    // extra work is one client-side pass over a few hundred points.
    renderCumulative(days);
  }catch(e){
    console.error('Failed to load daily summary', e);
  }
}

// Generation KPI strip: refreshed on the same cadence as the daily summary
// (its "today" value comes from the live e_today counter server-side, so a
// few minutes of staleness is fine for these totals).
async function loadGenerationSummary(){
  try{
    renderGenerationSummary(await fetchGenerationSummary());
  }catch(e){
    console.error('Failed to load generation summary', e);
  }
}

async function loadInitialStatus(){
  try{
    const json = await fetchStatus();
    setMode(json.night_mode);
    if(json.last_reading){
      updateStatCards(json.last_reading);
      dimStatCards(json.night_mode);
      setLastUpdated(json.last_reading.timestamp);
    }
    if(json.sun){
      updateSunInfo(json.sun);
    }
    setInverterStatus(json.status || (json.night_mode ? 'night' : 'online'), {
      offline_since: json.offline_since,
      last_error: json.last_error,
      last_reading_at: json.last_successful_reading_at,
    });
  }catch(e){
    console.error('Failed to load status', e);
  }
}

// ---------- WebSocket message routing ----------
function handleWSMessage(msg){
  if(msg.type === 'init'){
    setMode(msg.night_mode);
    if(msg.last_reading){
      updateStatCards(msg.last_reading);
      dimStatCards(msg.night_mode);
      setLastUpdated(msg.last_reading.timestamp);
    }
    if(msg.sun){
      updateSunInfo(msg.sun);
    }
    setInverterStatus(msg.status || (msg.night_mode ? 'night' : 'online'), {
      offline_since: msg.offline_since,
      last_error: msg.last_error,
      last_reading_at: msg.last_successful_reading_at,
    });
    // Reconcile polling with the server's current mode (covers reconnects).
    msg.night_mode ? stopDayPolling() : startDayPolling();
    if(!msg.last_error && msg.status !== 'offline') setConn('live');
  }
  else if(msg.type === 'reading'){
    setConn('live');
    setMode(false);
    dimStatCards(false);
    updateStatCards(msg.data);
    setLastUpdated(msg.data.timestamp);
    appendLivePoint(msg.data);
    setInverterStatus('online', {
      last_error: '',
      last_reading_at: msg.data.timestamp,
    });
  }
  else if(msg.type === 'night_mode'){
    setMode(true);
    dimStatCards(true);
    setNightText(`Inverter is asleep. Resuming in ~${(msg.seconds_until_sunrise/3600).toFixed(1)}h.`);
    refreshSunInfo();
    setInverterStatus('night');
    stopDayPolling();
  }
  else if(msg.type === 'wake_up'){
    setMode(false);
    dimStatCards(false);
    setNightText(NIGHT_TEXT_DEFAULT);
    refreshSunInfo();
    // Next poll (seconds away) confirms online vs offline via reading/error.
    if(msg.status) setInverterStatus(msg.status, msg);
    // Fresh data after the long idle stretch, then resume the day cadence.
    loadDailySummary();
    loadGenerationSummary();
    loadYieldStats();
    loadPowercutCount();
    startDayPolling();
  }
  else if(msg.type === 'error'){
    // Backend already retries; just reflect it isn't fresh data
    setConnText('read error — retrying');
    // The server decides the health status: below the powercut error
    // threshold it stays as-is (usually online) and only the Last Error
    // field updates; a confirmed cut arrives with status 'offline'.
    setInverterStatus(msg.status || 'offline', {
      offline_since: msg.offline_since,
      last_error: msg.message ?? msg.last_error,
    });
  }
}

// ---------- UI events ----------
document.getElementById('rangeToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if(!btn) return;
  document.querySelectorAll('#rangeToggle button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  setRange(btn.dataset.range);
  loadHistory();
});

document.getElementById('cumRangeToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if(!btn) return;
  document.querySelectorAll('#cumRangeToggle button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  setCumulativeRange(btn.dataset.range);
});

document.getElementById('csvBtn').addEventListener('click', () => {
  window.location.href = csvExportURL(state.range);
});

// ---------- Boot ----------
(async function init(){
  // Theme first: charts read the active palette at creation and on change.
  initTheme(applyChartTheme);
  await loadInitialStatus();
  await loadHistory();
  await loadDailySummary();
  await loadGenerationSummary();
  initYieldCard();
  await loadYieldStats();
  await loadPowercutCount();
  connectWebSocket(handleWSMessage);
  // Daily summary + powercuts intervals follow day/night (see
  // startDayPolling/stopDayPolling); the initial /api/status already told us
  // the mode, so only start here when it's day. Sun info keeps its own fixed
  // schedule regardless of mode.
  if(!state.nightMode) startDayPolling();
  // Local 1-second countdown tick (no network call), plus a periodic
  // full refresh from the server to stay accurate over long sessions.
  startSunTicker();
  setInterval(refreshSunInfo, SUN_INFO_REFRESH_MS);
  // Weather chip: independent fixed schedule (server caches provider calls).
  initWeather();
})();
