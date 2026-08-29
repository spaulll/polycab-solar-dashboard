// Status pills, night banner, and stat-card DOM updates.
// Pure DOM layer: no fetching, no sockets, no charts. Numeric values run
// through motion.js tickers; units render as static chips beside them.

import { fmtTime } from './format.js';
import { setNightMode } from './state.js';
import { tweenNumber } from './motion.js';

const el = id => document.getElementById(id);

const connPill = el('connDot')?.closest('.pill');
const connDot = el('connDot'), connText = el('connText');
const modeDot = el('modeDot'), modeText = el('modeText');
const nightBanner = el('nightBanner'), nightText = el('nightText');
const lastUpdated = el('lastUpdated');
const invStatusEl = el('invStatus'), invOfflineTimer = el('invOfflineTimer');
const invDot = el('invDot');
const invLastReading = el('invLastReading');

// ---------- Connection pill ----------
// States: 'live' (green), 'syncing' (degraded: WS down, reconnecting),
// 'offline' (degraded, sustained). While degraded the dot pulses; after
// ESCALATE_MS the label flips to "offline · Xm".
const ESCALATE_MS = 20000;
let degradedSince = null;
let escalateTimer = null;

function setConn(state){ // 'live' | 'syncing'
  if(state === 'live'){
    degradedSince = null;
    if(escalateTimer){ clearInterval(escalateTimer); escalateTimer = null; }
    connDot.className = 'dot live';
    connText.textContent = 'live';
    connPill.classList.remove('degraded');
    return;
  }
  // degraded
  if(degradedSince === null){
    degradedSince = Date.now();
    escalateTimer = setInterval(tickDegraded, 10000);
  }
  connDot.className = 'dot down';
  connText.textContent = 'syncing…';
  connPill.classList.add('degraded');
}

function tickDegraded(){
  const mins = Math.floor((Date.now() - degradedSince) / 60000);
  if(mins >= 1) connText.textContent = `offline · ${mins}m`;
}

// Transient read errors keep the green dot but explain the stall.
function setConnText(text){
  connText.textContent = text;
}

function setMode(night){
  setNightMode(night);
  modeDot.className = 'dot ' + (night ? 'night' : 'live');
  modeText.textContent = night ? 'night mode' : 'day mode';
  nightBanner.classList.toggle('show', night);
}

function setNightText(text){
  nightText.textContent = text;
}

const NIGHT_TEXT_DEFAULT = 'Inverter is asleep. Waiting for sunrise…';

function updateStatCards(d){
  tweenNumber(el('statSolar'), d.Solar_Input, 0);
  // Both grid metrics on one line: "218.5 V / 2.14 A".
  tweenNumber(el('statGridV'), d.L1_Voltage, 1);
  tweenNumber(el('statGridA'), d.L1_Current, 2);
  tweenNumber(el('statInvPower'), d.Inverter_Power, 0);
  tweenNumber(el('statTemp'), d.Temperature, 0);
  tweenNumber(el('statToday'), d.E_Today, 2);
  tweenNumber(el('statLifetime'), d.E_Total, 1);
}

function dimStatCards(dim){
  document.querySelectorAll('.stat-card').forEach(c => c.classList.toggle('dim', dim));
}

function setLastUpdated(iso){
  lastUpdated.textContent = fmtTime(iso);
}

// ---------- Generation KPI strip ----------
const GEN_SLOTS = [
  ['genToday', 'today'],
  ['genYesterday', 'yesterday'],
  ['genWeek', 'this_week'],
  ['genMonth', 'this_month'],
  ['genYear', 'this_year'],
];

function setEnergy(id, kwh){
  const numEl = el(id), unitEl = numEl.parentElement.querySelector('.unit');
  const parts = fmtEnergyLocal(kwh);
  tweenNumber(numEl, parts ? parts.n : null, parts ? parts.digits : 1);
  if(unitEl) unitEl.textContent = parts ? parts.unit : '';
}

// Local adapter so this module keeps its own digits policy:
// kWh below a megawatt-hour shows one decimal, MWh two.
function fmtEnergyLocal(kwh){
  if(kwh === null || kwh === undefined || Number.isNaN(Number(kwh))) return null;
  const n = Number(kwh);
  return n >= 1000
    ? { n: n / 1000, digits: 2, unit: 'MWh' }
    : { n, digits: 1, unit: 'kWh' };
}

function renderGenerationSummary(summary){
  for(const [id, key] of GEN_SLOTS){
    setEnergy(id, summary?.[key]);
  }
  // Wide card: calculated total is primary, the inverter's own counter sits
  // below it as a secondary line (the * links to the note under the strip).
  setEnergy('genCalculated', summary?.calculated_total);
  const inv = fmtEnergyLocal(summary?.inverter_lifetime);
  tweenNumber(el('genInverterLifetime'), inv ? inv.n : null, inv ? inv.digits : 1);
  el('genInverterLifetimeUnit').textContent = inv ? ' ' + inv.unit : '';
}

// ---------- Inverter status card ----------
const INV_STATUS_LABELS = { online: 'Online', offline: 'Unreachable', night: 'Night mode' };

let offlineSinceMs = null;
let offlineTicker = null;

function fmtDuration(totalSec){
  totalSec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
}

function stopOfflineTicker(){
  if(offlineTicker){ clearInterval(offlineTicker); offlineTicker = null; }
  offlineSinceMs = null;
  // The line's height stays reserved (visibility, not display) so the card
  // never reflows when the timer appears or disappears.
  invOfflineTimer.classList.remove('show');
  invOfflineTimer.textContent = '';
}

function tickOfflineTimer(){
  if(offlineSinceMs === null) return;
  invOfflineTimer.textContent = 'Offline for ' + fmtDuration((Date.now() - offlineSinceMs) / 1000);
}

/**
 * Render inverter health. `info` fields are applied only when present so
 * partial updates (e.g. a bare night_mode message) don't wipe known values.
 * status: 'online' | 'offline' | 'night'
 */
function setInverterStatus(status, info = {}){
  invStatusEl.textContent = INV_STATUS_LABELS[status] || '—';
  invStatusEl.className = 'inv-status-value ' + (status || '');
  // Health dot reuses the shared pill dot states (live/down/night).
  invDot.className = 'dot ' + ({ online: 'live', offline: 'down', night: 'night' }[status] || '');

  if(info.last_reading_at != null) invLastReading.textContent = fmtTime(info.last_reading_at);

  if(status === 'offline' && info.offline_since){
    const parsed = Date.parse(info.offline_since);
    if(!isNaN(parsed)){
      offlineSinceMs = parsed;
      invOfflineTimer.classList.add('show');
      tickOfflineTimer();
      if(!offlineTicker) offlineTicker = setInterval(tickOfflineTimer, 1000);
      return;
    }
  }
  stopOfflineTicker();
}

export {
  setConn,
  setConnText,
  setMode,
  setNightText,
  NIGHT_TEXT_DEFAULT,
  updateStatCards,
  dimStatCards,
  setLastUpdated,
  setInverterStatus,
  renderGenerationSummary,
};
