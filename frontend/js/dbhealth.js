// System card in the Trends view: GET /api/db-status as labeled rows
// (size, readings, history depth, last cleanup, lifetime powercuts).
// Null-safe: missing DB or nulls degrade to –, never crash.

import { fetchDbStatus } from './api.js';

const el = id => document.getElementById(id);

const ROWS = ['dbSize', 'dbReadings', 'dbHistory', 'dbCleanup', 'dbPowercuts'];

function fmtCompact(n){
  if(n === null || n === undefined || Number.isNaN(Number(n))) return '–';
  const v = Number(n);
  if(v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if(v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}

function fmtFull(n){
  if(n === null || n === undefined || Number.isNaN(Number(n))) return '–';
  return Math.round(Number(n)).toLocaleString('en-US');
}

function fmtCleanup(iso){
  if(!iso) return '–';
  const d = new Date(iso);
  if(Number.isNaN(d.getTime())) return '–';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function setRow(id, value, title){
  const node = el(id);
  if(!node) return;
  node.textContent = value;
  if(title !== undefined) node.title = title;
}

function render(status){
  if(!status || typeof status !== 'object'){
    ROWS.forEach(id => setRow(id, '–', 'Database status unavailable'));
    return;
  }
  const rc = status.row_counts || {};
  const sizeMb = (status.size_mb !== null && status.size_mb !== undefined)
    ? `${Number(status.size_mb).toFixed(status.size_mb < 10 ? 1 : 0)} MB`
    : '–';
  const retention = (status.retention_days !== null && status.retention_days !== undefined)
    ? status.retention_days : '–';
  setRow('dbSize', sizeMb,
    `${status.db_path || 'database'} · full-resolution readings kept ${retention} days`);

  const readings = rc.readings;
  setRow('dbReadings',
    readings !== null && readings !== undefined ? fmtCompact(readings) : '–',
    `${fmtFull(readings)} raw readings · ${fmtFull(rc.readings_hourly)} hourly aggregates`);

  const days = rc.readings_daily;
  setRow('dbHistory',
    days !== null && days !== undefined ? `${fmtFull(days)} days` : '–',
    `${fmtFull(days)} daily aggregates · ${fmtFull(rc.readings_weather_daily)} archived weather days`);

  setRow('dbCleanup', fmtCleanup(status.last_maintenance),
    status.last_maintenance
      ? `Last maintenance run: ${new Date(status.last_maintenance).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
      : 'No maintenance run recorded yet');

  const cuts = status.total_powercuts;
  setRow('dbPowercuts',
    cuts !== null && cuts !== undefined ? fmtFull(cuts) : '–',
    'Recorded powercut events, lifetime total');
}

async function loadDbHealth(){
  try{
    render(await fetchDbStatus());
  }catch(e){
    console.error('Failed to load db status', e);
    render(null);
  }
}

function initDbHealth(){
  loadDbHealth();
}

export { initDbHealth, loadDbHealth };
