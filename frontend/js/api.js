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

// Today's projected finish: live e_today + expected remainder of the solar
// day per the long-term average-day profile, plus the typical-day curve for
// the dashed Today-chart overlay (see charts.js).
function fetchTodayProjection(){
  return getJSON('/api/today/projection');
}

// Peak Production insight: server-side MAX over raw DB readings plus the
// original timestamp of that record. Independent of chart aggregation.
function fetchPeakProduction(range){
  return getJSON(`/api/insights/peak?range=${range}`);
}

// Inverter temperature analytics: daylight-only time-of-day/output-band
// aggregates plus all-history records (see /api/insights/temperature).
function fetchTemperatureInsights(){
  return getJSON('/api/insights/temperature');
}

function fetchDailySummary(){
  return getJSON('/api/daily-summary').then(json => json.days || []);
}

// Generation KPI strip: today/yesterday/week/month/year/lifetime kWh.
function fetchGenerationSummary(){
  return getJSON('/api/generation/summary');
}

// Monthly kWh totals bucketed from the same day series as the daily
// summary, plus yoy_available / first_month context for the YoY rendering.
function fetchGenerationMonthly(months){
  return getJSON(`/api/generation/monthly?months=${months}`);
}

// Average daily yield + best/worst day over [from, to] (YYYY-MM-DD). When
// both are omitted the backend picks the last 30 days; every response
// carries the available min_date/max_date range for picker constraining.
function fetchGenerationStats(fromDay, toDay){
  let path = '/api/generation/stats';
  if(fromDay && toDay) path += `?from=${fromDay}&to=${toDay}`;
  return getJSON(path);
}

function fetchDbStatus(){
  return getJSON('/api/db-status');
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

// Recent inverter error episodes, newest first (server-side bounded log),
// plus the server's rotation window in days so the UI can state the span.
function fetchErrors(limit = 50){
  return getJSON(`/api/errors?limit=${limit}`).then(json => ({
    errors: json.errors || [],
    retentionDays: Number.isFinite(+json.retention_days) ? +json.retention_days : null,
  }));
}

// Weather <-> production correlation: cloud-class buckets, matched-day
// scatter points and a Pearson r from /api/weather/correlation (the
// maintenance thread backfills the archived weather server-side).
function fetchWeatherCorrelation(){
  return getJSON('/api/weather/correlation');
}

// Normalized weather from the backend (OpenWeatherMap or Open-Meteo).
function fetchWeather(){
  return getJSON('/api/weather');
}

// Expected tomorrow kWh (provider-agnostic daylight derate of typical day).
function fetchTomorrowForecast(){
  return getJSON('/api/forecast/tomorrow');
}

function csvExportURL(range){
  return `${API_BASE}/api/export?range=${range}`;
}

export {
  fetchHistory,
  fetchSolarSessions,
  fetchSolarProfile,
  fetchTodayProjection,
  fetchPeakProduction,
  fetchTemperatureInsights,
  fetchDailySummary,
  fetchGenerationSummary,
  fetchGenerationMonthly,
  fetchGenerationStats,
  fetchWeatherCorrelation,
  fetchDbStatus,
  fetchTomorrowForecast,
  fetchStatus,
  fetchSunInfo,
  fetchPowercutCount,
  fetchErrors,
  fetchWeather,
  csvExportURL,
};
