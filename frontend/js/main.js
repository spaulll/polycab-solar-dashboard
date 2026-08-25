// Entry point: loads initial data, wires UI events and WebSocket messages,
// and starts the periodic refreshes. All other modules are plain imports
// with no knowledge of this wiring.

import { DAILY_SUMMARY_REFRESH_MS, POWERCUTS_REFRESH_MS, SUN_INFO_REFRESH_MS, MONTHLY_ALL_MONTHS } from './config.js';
import { state, setRange } from './state.js';
import { loadPref, savePref } from './prefs.js';
import { fetchHistory, fetchSolarSessions, fetchSolarProfile, fetchPeakProduction, fetchDailySummary, fetchGenerationSummary, fetchGenerationMonthly, fetchStatus, fetchPowercutCount, csvExportURL } from './api.js';
import { connectWebSocket } from './ws.js';
import {
  setMode, setNightText, setConn, setConnText, NIGHT_TEXT_DEFAULT,
  updateStatCards, dimStatCards, setLastUpdated, setInverterStatus,
  renderGenerationSummary,
} from './ui.js';
import { renderHistory, renderSessions, renderProfile, appendLivePoint, renderDailySummary, renderCumulative, setCumulativeRange, renderMonthly, setMonthlyRange, loadTodayProjection, updatePaceTag } from './charts.js';
import { computeInsights, renderPeakInsight } from './insights.js';
import { loadImpact } from './impact.js';
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

// ---------- Day-mode polling manager ----------
// Daily summary and powercuts only change while the inverter is awake, so
// their intervals run in day mode and are torn down during night mode.
const dayTimers = [];

function startDayPolling(){
  if(dayTimers.length) return; // already running
  dayTimers.push(setInterval(loadDailySummary, DAILY_SUMMARY_REFRESH_MS));
  dayTimers.push(setInterval(loadGenerationSummary, DAILY_SUMMARY_REFRESH_MS));
  dayTimers.push(setInterval(loadImpact, DAILY_SUMMARY_REFRESH_MS));
  dayTimers.push(setInterval(loadYieldStats, DAILY_SUMMARY_REFRESH_MS));
  dayTimers.push(setInterval(loadMonthlyEnergy, DAILY_SUMMARY_REFRESH_MS));
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
// the chart aggregation for the active range. The today range also fetches
// the projection (dashed typical-day overlay + pace tag, owned by charts.js).
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
      if(state.range === 'today') loadTodayProjection();
    }
    // Pace tag follows the active range (hidden everywhere but today).
    updatePaceTag();
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

// Monthly Energy: one request for the full month series; the 12/24/All
// toggle slices client-side without refetching. Same cadence as the daily
// summary plus an immediate refresh on wake_up.
async function loadMonthlyEnergy(){
  try{
    const json = await fetchGenerationMonthly(MONTHLY_ALL_MONTHS);
    if(json.error) throw new Error(json.error);
    renderMonthly(json);
  }catch(e){
    console.error('Failed to load monthly energy', e);
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
    // Re-project the pace tag from the fetched typical-day curve (no
    // refetch per tick).
    updatePaceTag(msg.data.E_Today);
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
    updatePaceTag(); // no pace statement at night
  }
  else if(msg.type === 'wake_up'){
    setMode(false);
    dimStatCards(false);
    setNightText(NIGHT_TEXT_DEFAULT);
    refreshSunInfo();
    // Next poll (seconds away) confirms online vs offline via reading/error.
    if(msg.status) setInverterStatus(msg.status, msg);
    // Fresh data after the long idle stretch, then resume the day cadence.
    loadHistory();
    loadDailySummary();
    loadGenerationSummary();
    loadImpact();
    loadYieldStats();
    loadMonthlyEnergy();
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

// ---------- Persisted range selections ----------
// Every tab/range group remembers its last user-selected value across page
// reloads via localStorage (prefs.js). Restored BEFORE any data loads so the
// charts' first render already uses the saved view; the active-button sync
// lives here too, replacing the static classes in index.html. Values are
// validated against the options actually present in the markup, so stale or
// corrupted entries fall back to the group's default.
const POWERCUTS_DEFAULT_RANGE = 'today';

function toggleOptions(toggleId){
  return [...document.querySelectorAll(`#${toggleId} button[data-range]`)]
    .map(b => b.dataset.range);
}

function setToggleActive(toggleId, value){
  document.querySelectorAll(`#${toggleId} button[data-range]`)
    .forEach(b => b.classList.toggle('active', b.dataset.range === value));
}

// The cumulative/monthly/powercuts groups keep their state inside their own
// modules/sections with defaults 'all' / '12' / today; restoring through
// their normal setters keeps one mutation path for both boot and clicks.
function restorePersistedRanges(){
  const power = loadPref('powerRange', toggleOptions('rangeToggle'), state.range);
  setRange(power);
  setToggleActive('rangeToggle', power);

  const cumulative = loadPref('cumulativeRange', toggleOptions('cumRangeToggle'), 'all');
  setCumulativeRange(cumulative);
  setToggleActive('cumRangeToggle', cumulative);

  const monthly = loadPref('monthlyRange', toggleOptions('monthlyRangeToggle'), '12');
  setMonthlyRange(monthly);
  setToggleActive('monthlyRangeToggle', monthly);

  const pcSelect = document.getElementById('pcRange');
  pcRange = loadPref(
    'powercutsRange',
    [...pcSelect.options].map(o => o.value),
    POWERCUTS_DEFAULT_RANGE,
  );
  pcSelect.value = pcRange;
}

// ---------- UI events ----------
document.getElementById('rangeToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if(!btn) return;
  setToggleActive('rangeToggle', btn.dataset.range);
  setRange(btn.dataset.range);
  savePref('powerRange', btn.dataset.range);
  loadHistory();
});

document.getElementById('cumRangeToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if(!btn) return;
  setToggleActive('cumRangeToggle', btn.dataset.range);
  setCumulativeRange(btn.dataset.range);
  savePref('cumulativeRange', btn.dataset.range);
});

document.getElementById('monthlyRangeToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if(!btn) return;
  setToggleActive('monthlyRangeToggle', btn.dataset.range);
  setMonthlyRange(btn.dataset.range);
  savePref('monthlyRange', btn.dataset.range);
});

document.getElementById('pcRange').addEventListener('change', (e) => {
  pcRange = e.target.value;
  savePref('powercutsRange', pcRange);
  loadPowercutCount();
});

document.getElementById('csvBtn').addEventListener('click', () => {
  window.location.href = csvExportURL(state.range);
});

// ---------- Boot ----------
(async function init(){
  // Theme first: charts read the active palette at creation and on change.
  initTheme(applyChartTheme);
  // Saved tab selections next, strictly before any data fetch: the initial
  // loadHistory()/loadDailySummary()/... below must render the restored
  // views, never the hardcoded defaults.
  restorePersistedRanges();
  await loadInitialStatus();
  await loadHistory();
  await loadDailySummary();
  await loadGenerationSummary();
  await loadImpact();
  await loadMonthlyEnergy();
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
