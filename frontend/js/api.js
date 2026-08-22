// REST API client. Pure fetchers that resolve with parsed JSON --
// DOM/error handling belongs to the caller.

import { API_BASE, SESSION_DAYS, SESSION_BIN_SECONDS } from './config.js';

async function getJSON(path){
  const res = await fetch(API_BASE + path);
  return res.json();
}

// Rolling ranges resolve to {readings, sun:null}; range=today additionally
// carries the solar-day window {sunrise, sunset} used to bound the axis.
function fetchHistory(range){
  return getJSON(`/api/history?range=${range}`).then(json => ({
    readings: json.readings || [],
    sun: json.sun || null,
  }));
}

// Per-solar-day daylight buckets normalized to seconds after sunrise (7D).
function fetchSolarSessions(days = SESSION_DAYS){
  return getJSON(
    `/api/history/solar-sessions?days=${days}&bin=${SESSION_BIN_SECONDS}`
  ).then(json => json.sessions || []);
}

// Long-term average power profile vs position within the solar day (All).
function fetchSolarProfile(){
  return getJSON('/api/history/solar-profile');
}

function fetchDailySummary(){
  return getJSON('/api/daily-summary').then(json => json.days || []);
}

function fetchStatus(){
  return getJSON('/api/status');
}

function fetchSunInfo(){
  return getJSON('/api/sun');
}

function fetchPowercutCount(range){
  return getJSON(`/api/powercuts?range=${range}`).then(json => json.count ?? 0);
}

function csvExportURL(range){
  return `${API_BASE}/api/export?range=${range}`;
}

export {
  fetchHistory,
  fetchSolarSessions,
  fetchSolarProfile,
  fetchDailySummary,
  fetchStatus,
  fetchSunInfo,
  fetchPowercutCount,
  csvExportURL,
};
