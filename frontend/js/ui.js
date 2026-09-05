// Status pills, night banner, and stat-card DOM updates.
// Pure DOM layer: no fetching, no sockets, no charts. Numeric values run
// through motion.js tickers; units render as static chips beside them.

import { fmtTime } from './format.js';
import { setNightMode } from './state.js';
import { swapText, tweenNumber } from './motion.js';

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
  swapText(modeText, night ? 'night mode' : 'day mode');
  nightBanner.classList.toggle('show', night);
}

function setNightText(text){
  swapText(nightText, text);
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
  // Compact pill content (clock glyph lives in the markup): full HH:MM:SS
  // once a reading exists, "no data" before that. The same timestamp sits
  // in the title tooltip. Writes only the inner span so the SVG survives.
  const label = el('lastUpdatedText');
  const stamp = iso ? fmtTime(iso).replace(/^updated\s*/, '') : 'no data';
  if(label) label.textContent = stamp;
  if(lastUpdated) lastUpdated.title = iso ? 'Last reading ' + stamp : 'Waiting for first reading';
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

  // Plant capacity: specific yield (kWh/kWp) + capacity factor.
  // Explicitly NOT true Performance Ratio (needs pyranometer) -- tooltip
  // states it. Hidden entirely when capacity unset.
  const cap = summary?.capacity;
  const todaySub = el('genTodaySub');
  const monthSub = el('genMonthSub');
  if(cap && cap.kwp > 0){
    if(todaySub){
      const y = cap.today_kwh_per_kwp;
      const cf = cap.capacity_factor_today_pct;
      if(y !== null && y !== undefined && cf !== null && cf !== undefined){
        todaySub.hidden = false;
        todaySub.textContent = `${Number(y).toFixed(1)} kWh/kWp · CF ${Number(cf).toFixed(1)}%`;
        todaySub.title = 'kWh per kWp installed — specific yield today. CF = today kWh ÷ (kWp × 24h). Not true Performance Ratio (needs pyranometer).';
      }else{
        todaySub.hidden = true;
      }
    }
    if(monthSub){
      const my = cap.month_kwh_per_kwp;
      if(my !== null && my !== undefined){
        monthSub.hidden = false;
        monthSub.textContent = `${Number(my).toFixed(1)} kWh/kWp`;
        monthSub.title = 'kWh per kWp installed — specific yield this month. Not true Performance Ratio (needs pyranometer).';
      }else{
        monthSub.hidden = true;
      }
    }
  }else{
    if(todaySub) todaySub.hidden = true;
    if(monthSub) monthSub.hidden = true;
  }

  // WoW / MoM (/YoY) deltas: arrow + text (never color-only), tooltip with
  // absolute kWh, hidden when null (insufficient history).
  renderDelta('genWeekDelta', summary?.deltas?.week_pct, {
    cur: summary?.deltas?.week_current_kwh,
    prev: summary?.deltas?.week_prev_kwh,
    label: 'vs last week',
  });
  renderDelta('genMonthDelta', summary?.deltas?.month_pct, {
    cur: summary?.deltas?.month_current_kwh,
    prev: summary?.deltas?.month_prev_kwh,
    label: 'vs last month',
  });
  renderDelta('genYearDelta', summary?.deltas?.year_pct, {
    cur: summary?.deltas?.year_current_kwh,
    prev: summary?.deltas?.year_prev_kwh,
    label: 'vs last year',
  });
}

function renderDelta(id, pct, ctx = {}){
  const node = el(id);
  if(!node) return;
  if(pct === null || pct === undefined || Number.isNaN(Number(pct))){
    node.hidden = true;
    return;
  }
  const v = Number(pct);
  const up = v >= 0;
  const arrow = up ? '▲' : '▼';
  const sign = up ? '+' : '';
  node.hidden = false;
  node.textContent = `${arrow} ${sign}${v.toFixed(1)}% ${ctx.label || ''}`.trim();
  node.classList.toggle('up', up);
  node.classList.toggle('down', !up);
  const cur = ctx.cur !== null && ctx.cur !== undefined ? `${Number(ctx.cur).toFixed(1)} kWh` : '–';
  const prev = ctx.prev !== null && ctx.prev !== undefined ? `${Number(ctx.prev).toFixed(1)} kWh` : '–';
  node.title = `Now ${cur} vs then ${prev} (equal elapsed days). Partial weeks/months compare the same elapsed days.`;
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
  const label = INV_STATUS_LABELS[status] || '—';
  if(invStatusEl.textContent !== label) swapText(invStatusEl, label);
  invStatusEl.className = 'inv-status-value ' + (status || '');
  // Health dot reuses the shared pill dot states (live/down/night).
  invDot.className = 'dot ' + ({ online: 'live', offline: 'down', night: 'night' }[status] || '');

  if(info.last_reading_at != null) swapText(invLastReading, fmtTime(info.last_reading_at));

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
