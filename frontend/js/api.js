// REST API client. Pure fetchers that resolve with parsed JSON --
// DOM/error handling belongs to the caller.

import { API_BASE } from './config.js';

async function getJSON(path){
  const res = await fetch(API_BASE + path);
  return res.json();
}

function fetchHistory(range){
  return getJSON(`/api/history?range=${range}`).then(json => json.readings || []);
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

export { fetchHistory, fetchDailySummary, fetchStatus, fetchSunInfo, fetchPowercutCount, csvExportURL };
