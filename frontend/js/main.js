// Entry point: loads initial data, wires UI events and WebSocket messages,
// and starts the periodic refreshes. All other modules are plain imports
// with no knowledge of this wiring.

import { DAILY_SUMMARY_REFRESH_MS, POWERCUTS_REFRESH_MS, SUN_INFO_REFRESH_MS } from './config.js';
import { state, setRange } from './state.js';
import { fetchHistory, fetchSolarSessions, fetchSolarProfile, fetchDailySummary, fetchStatus, fetchPowercutCount, csvExportURL } from './api.js';
import { connectWebSocket } from './ws.js';
import {
  setMode, setNightText, setConn, setConnText, NIGHT_TEXT_DEFAULT,
  updateStatCards, dimStatCards, setLastUpdated, setInverterStatus,
} from './ui.js';
import { renderHistory, renderSessions, renderProfile, appendLivePoint, renderDailySummary } from './charts.js';
import { computeInsights } from './insights.js';
import { updateSunInfo, refreshSunInfo, startSunTicker } from './sun.js';

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
async function loadHistory(){
  try{
    if(state.range === '7d'){
      const sessions = await fetchSolarSessions();
      renderSessions(sessions);
      computeInsights(flattenSessions(sessions));
    } else if(state.range === 'all'){
      const profile = await fetchSolarProfile();
      renderProfile(profile);
      computeInsights(flattenProfile(profile));
    } else {
      const {readings, sun} = await fetchHistory(state.range);
      renderHistory(readings, sun);
      computeInsights(readings);
    }
  }catch(e){
    console.error('Failed to load history', e);
  }
}

// Reshape solar session buckets into timestamped readings so the insights
// panel can keep working unchanged (peak time stays a real wall-clock time).
function flattenSessions(sessions){
  const out = [];
  for(const s of sessions){
    const riseMs = Date.parse(s.sunrise);
    for(const p of s.buckets || []){
      out.push({
        timestamp: new Date(riseMs + p.o * 1000).toISOString(),
        solar_input: p.s,
        inverter_power: p.i,
      });
    }
  }
  return out;
}

// Profile bins have no single wall-clock time; carry their solar-day
// position as a label for the insights panel instead.
function flattenProfile(profile){
  return (profile.bins || []).map(b => ({
    timestamp: null,
    solar_input: b.s_avg,
    inverter_power: b.i_avg,
    label: offsetLabel(b.o),
  }));
}

function offsetLabel(sec){
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `+${h}h ${String(m).padStart(2,'0')}m` : `+${h}h`;
}

async function loadDailySummary(){
  try{
    renderDailySummary(await fetchDailySummary());
  }catch(e){
    console.error('Failed to load daily summary', e);
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

document.getElementById('csvBtn').addEventListener('click', () => {
  window.location.href = csvExportURL(state.range);
});

// ---------- Boot ----------
(async function init(){
  await loadInitialStatus();
  await loadHistory();
  await loadDailySummary();
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
})();
