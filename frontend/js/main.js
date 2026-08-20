// Entry point: loads initial data, wires UI events and WebSocket messages,
// and starts the periodic refreshes. All other modules are plain imports
// with no knowledge of this wiring.

import { DAILY_SUMMARY_REFRESH_MS, SUN_INFO_REFRESH_MS } from './config.js';
import { state, setRange } from './state.js';
import { fetchHistory, fetchDailySummary, fetchStatus, csvExportURL } from './api.js';
import { connectWebSocket } from './ws.js';
import {
  setMode, setNightText, setConnText, NIGHT_TEXT_DEFAULT,
  updateStatCards, dimStatCards, setLastUpdated,
} from './ui.js';
import { applyAxisConfigForRange, renderHistory, appendLivePoint, renderDailySummary } from './charts.js';
import { computeInsights } from './insights.js';
import { updateSunInfo, refreshSunInfo, startSunTicker } from './sun.js';

// ---------- Data loading ----------
async function loadHistory(){
  try{
    const readings = await fetchHistory(state.range);
    renderHistory(readings);
    computeInsights(readings);
  }catch(e){
    console.error('Failed to load history', e);
  }
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
  }
  else if(msg.type === 'reading'){
    setMode(false);
    dimStatCards(false);
    updateStatCards(msg.data);
    setLastUpdated(msg.data.timestamp);
    appendLivePoint(msg.data);
  }
  else if(msg.type === 'night_mode'){
    setMode(true);
    dimStatCards(true);
    setNightText(`Inverter is asleep. Resuming in ~${(msg.seconds_until_sunrise/3600).toFixed(1)}h.`);
    refreshSunInfo();
  }
  else if(msg.type === 'wake_up'){
    setMode(false);
    dimStatCards(false);
    setNightText(NIGHT_TEXT_DEFAULT);
    refreshSunInfo();
  }
  else if(msg.type === 'error'){
    // Backend already retries; just reflect it isn't fresh data
    setConnText('read error — retrying');
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
  applyAxisConfigForRange(state.range);
  await loadInitialStatus();
  await loadHistory();
  await loadDailySummary();
  connectWebSocket(handleWSMessage);
  // Refresh the daily summary chart periodically (cheap query, catches new days)
  setInterval(loadDailySummary, DAILY_SUMMARY_REFRESH_MS);
  // Local 1-second countdown tick (no network call), plus a periodic
  // full refresh from the server to stay accurate over long sessions.
  startSunTicker();
  setInterval(refreshSunInfo, SUN_INFO_REFRESH_MS);
})();
