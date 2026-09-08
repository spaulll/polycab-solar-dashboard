// Today-at-a-glance mirror: copies the live stat cards into the premium
// summary card. Peak is pinned to TODAY via its own range=today fetch --
// the Insights panel peak intentionally follows the shared chart range, but
// "best today" must not move when the user browses 7D/All. All lookups are
// guarded -- missing sources keep their placeholder.

import { fetchPeakProduction, fetchGenerationSummary } from './api.js';
import { fmtClock, localDayKey } from './format.js';
import { state } from './state.js';
import { getNextSunrise } from './sun.js';

const $ = id => document.getElementById(id);

// Today's own peak in watts (range-independent). Refreshed from the server;
// live readings fold in instantly so new intraday highs show immediately.
let todayPeakW = null;
let lastPeakFetch = 0;
const PEAK_REFRESH_MS = 5 * 60 * 1000;

// Installed capacity in kWp for the live % display (gauge dial stays on
// INVERTER_RATED_W; this is text only). Null = feature hidden.
let plantKwp = null;
let lastCapacityFetch = 0;

async function refreshTodayPeak(){
  try{
    const peak = await fetchPeakProduction('today');
    if(peak && peak.value !== null && peak.value !== undefined){
      const v = Number(peak.value);
      if(Number.isFinite(v)) todayPeakW = v;
    }
  }catch(e){ /* keep the last known peak; fallback mirror below covers it */ }
  lastPeakFetch = Date.now();
  syncNumbers();
}

async function refreshCapacity(){
  try{
    const summary = await fetchGenerationSummary();
    const kwp = summary?.capacity?.kwp;
    plantKwp = (kwp !== null && kwp !== undefined && Number(kwp) > 0)
      ? Number(kwp) : null;
  }catch(e){ /* keep last known; hidden when unset */ }
  lastCapacityFetch = Date.now();
  syncNumbers();
}

function text(id){
  const el = $(id);
  return el ? el.textContent.trim() : '';
}

function setText(id, value){
  const el = $(id);
  if(el && value) el.textContent = value;
}

function parseNum(s){
  if(!s || s === '–' || s === '—') return null;
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Peak insight renders like "3.24 kW" or "812 W" (value + unit in one node).
function splitPeak(s){
  if(!s || s === '–') return null;
  const m = String(s).match(/([\d.,]+)\s*([a-zA-Zµ°%]+)?/);
  if(!m) return null;
  return { num: m[1], unit: m[2] || 'W' };
}

function syncNumbers(){
  const night = state.nightMode;
  const solar = text('statSolar');
  const today = text('statToday');
  // Overnight there is no live output: never mirror a stale afternoon
  // wattage as "Now". The gauge already parks on '–' the same way.
  if(night){
    setText('glanceNow', '–');
  }else if(solar && solar !== '–'){
    setText('glanceNow', solar);
  }
  if(today && today !== '–') setText('glanceToday', today);

  // Collapsed-strip summary keeps the key numbers glanceable. Overnight it
  // names the state instead of implying a live wattage.
  const sum = $('statsToggleSummary');
  if(sum){
    if(!night && solar && solar !== '–' && today && today !== '–'){
      sum.textContent = `${solar} W · ${today} kWh today`;
    }else if(night && today && today !== '–'){
      sum.textContent = `asleep · ${today} kWh today`;
    }else{
      sum.textContent = '';
    }
  }

  // Peak: pinned to today. Live readings fold in instantly; the server
  // value refreshes on a slow tick. Only if neither exists (offline boot),
  // mirror the Insights peak as a last resort.
  const nowW = parseNum(solar);
  if(nowW !== null && (todayPeakW === null || nowW > todayPeakW)) todayPeakW = nowW;
  if(todayPeakW !== null){
    setText('glancePeak', String(Math.round(todayPeakW)));
    setText('glancePeakUnit', 'W');
  }else{
    const peak = splitPeak(text('insightPeakValue'));
    if(peak){
      setText('glancePeak', peak.num);
      setText('glancePeakUnit', peak.unit);
    }
  }

  // Progress bar: now relative to today's peak.
  let peakW = todayPeakW;
  if(peakW === null){
    const peakRaw = text('insightPeakValue');
    peakW = parseNum(peakRaw);
    if(peakW !== null && /kW/i.test(peakRaw)) peakW *= 1000;
  }
  const fill = $('glanceFill');
  if(fill){
    let pct = 0;
    if(nowW != null && peakW != null && peakW > 0) pct = Math.max(0, Math.min(1, nowW / peakW));
    fill.style.width = `${Math.round(pct * 100)}%`;
  }

  // Live % of installed kWp (text only; gauge dial stays on rated W).
  // Hidden entirely when capacity unset. Short `40% · 3.1 kWp` form keeps
  // the 3-up glance grid overflow-free on 375px phones (full precision in
  // the tooltip). Overnight the line names the resume time instead.
  const nowSub = $('glanceNowSub');
  if(nowSub){
    if(night){
      const rise = getNextSunrise();
      const clock = rise && !Number.isNaN(rise.getTime())
        ? fmtClock(rise.toISOString()) : null;
      nowSub.textContent = clock ? `resumes ${clock}` : 'inverter asleep';
      nowSub.title = clock
        ? `Inverter asleep overnight — resumes around ${clock}.`
        : 'Inverter asleep overnight.';
    }else if(plantKwp && nowW !== null && nowW > 0){
      const pctCap = (nowW / (plantKwp * 1000)) * 100;
      nowSub.textContent = `${Math.round(pctCap)}% · ${Number(plantKwp).toFixed(1)} kWp`;
      nowSub.title = `Live output as % of installed DC capacity (${plantKwp} kWp). Gauge dial stays on inverter rating.`;
    }else{
      if(nowSub.textContent !== 'solar input') nowSub.textContent = 'solar input';
      nowSub.removeAttribute('title');
    }
  }
}

function syncState(){
  const night = state.nightMode;
  const conn = text('connText').toLowerCase();
  const dot = $('glanceDot');
  const label = $('glanceState');
  const sub = $('glanceSub');
  if(!label) return;
  // The badge stays a short state — raw transport errors ("read error —
  // retrying") never leak into it; they already surface in the topbar pill.
  let badge = 'Live';
  let cls = 'dot live';
  if(night){
    badge = 'Night · resting';
    cls = 'dot night';
  }else if(conn.includes('offline')){
    badge = 'Offline';
    cls = 'dot down';
  }else if(conn.includes('connect') || conn.includes('sync') || conn.includes('retry') || conn.includes('read error')){
    badge = 'Retrying…';
    cls = 'dot down';
  }
  label.textContent = badge;
  if(dot) dot.className = cls;
  const tdot = $('statsToggleDot');
  if(tdot) tdot.className = cls;
  if(sub){
    if(night){
      const rise = getNextSunrise();
      const clock = rise && !Number.isNaN(rise.getTime())
        ? fmtClock(rise.toISOString()) : null;
      sub.textContent = clock
        ? `inverter asleep · resumes ${clock}` : 'inverter asleep · resumes at sunrise';
    }else{
      sub.textContent = 'live summary';
    }
  }
  // "Today" keeps its meaning across sunset: still accumulating by day,
  // a finished total overnight.
  const todaySub = $('glanceTodaySub');
  if(todaySub) todaySub.textContent = night ? 'final' : 'energy so far';
}

export function initGlance(){
  syncNumbers();
  syncState();
  let lastDateKey = localDayKey(new Date());
  // Midnight rollover while the page stays open: yesterday's peak must not
  // survive as "best today", and yesterday's final must not linger as
  // today's numbers before the first reading of the new day.
  const onDateChange = () => {
    todayPeakW = null;
    for(const id of ['glanceToday', 'glancePeak', 'statToday']){
      const node = $(id);
      if(node) node.textContent = '–';
    }
    const unit = $('glancePeakUnit');
    if(unit) unit.textContent = 'W';
    lastPeakFetch = 0;
    refreshTodayPeak();
    syncNumbers();
    syncState();
  };
  window.addEventListener('datechange', onDateChange);
  // Live stats update via textContent swaps (no events), so observe them.
  const watch = ['statSolar', 'statToday', 'insightPeakValue', 'modeText', 'connText'];
  const obs = new MutationObserver(() => { syncNumbers(); syncState(); });
  for(const id of watch){
    const el = $(id);
    if(el) obs.observe(el, { childList: true, characterData: true, subtree: true });
  }
  // Fallback tick in case a renderer replaces nodes wholesale; the today
  // peak + capacity refresh on a slow tick alongside it.
  setInterval(() => {
    const key = localDayKey(new Date());
    if(key !== lastDateKey){
      lastDateKey = key;
      onDateChange();
      return;
    }
    syncNumbers();
    syncState();
    if(Date.now() - lastPeakFetch > PEAK_REFRESH_MS) refreshTodayPeak();
    if(Date.now() - lastCapacityFetch > PEAK_REFRESH_MS) refreshCapacity();
  }, 5000);
  refreshTodayPeak();
  refreshCapacity();
}
