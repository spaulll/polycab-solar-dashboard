// DB health footer line for the Trends view: surfaces GET /api/db-status
// as one muted line below the Monthly/Weather panels (not a big card).
// Null-safe: missing DB, null last_maintenance -> degrade to –, never crash.

import { fetchDbStatus } from './api.js';

const el = id => document.getElementById(id);

function fmtCompact(n){
  if(n === null || n === undefined || Number.isNaN(Number(n))) return '–';
  const v = Number(n);
  if(v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if(v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(v));
}

function fmtCleanup(iso){
  if(!iso) return '–';
  const d = new Date(iso);
  if(Number.isNaN(d.getTime())) return '–';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function render(status){
  const node = el('dbHealth');
  if(!node) return;
  if(!status || typeof status !== 'object'){
    node.hidden = false;
    node.textContent = '–';
    node.title = 'Database status unavailable';
    return;
  }
  const sizeMb = (status.size_mb !== null && status.size_mb !== undefined)
    ? `${Number(status.size_mb).toFixed(status.size_mb < 10 ? 1 : 0)} MB`
    : '–';
  const readings = status.row_counts?.readings;
  const readingsTxt = readings !== null && readings !== undefined
    ? `${fmtCompact(readings)} readings`
    : '– readings';
  const cleanup = fmtCleanup(status.last_maintenance);
  const retention = (status.retention_days !== null && status.retention_days !== undefined)
    ? `keeps ${status.retention_days}d`
    : 'keeps –';
  node.hidden = false;
  node.textContent = `${sizeMb} · ${readingsTxt} · last cleanup ${cleanup} · ${retention}`;
  // Full breakdown in the tooltip (no visual bulk).
  const rc = status.row_counts || {};
  const parts = [
    `readings: ${rc.readings ?? '–'}`,
    `hourly: ${rc.readings_hourly ?? '–'}`,
    `daily: ${rc.readings_daily ?? '–'}`,
    `weather: ${rc.readings_weather_daily ?? '–'}`,
  ].join(' · ');
  node.title = `${parts} · powercuts: ${status.total_powercuts ?? '–'}`;
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
