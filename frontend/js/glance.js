// Today-at-a-glance mirror: copies the live stat cards into the premium
// summary card. Peak is pinned to TODAY via its own range=today fetch --
// the Insights panel peak intentionally follows the shared chart range, but
// "best today" must not move when the user browses 7D/All. All lookups are
// guarded -- missing sources keep their placeholder.

import { fetchPeakProduction, fetchGenerationSummary } from './api.js';

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
  const solar = text('statSolar');
  const today = text('statToday');
  if(solar && solar !== '–') setText('glanceNow', solar);
  if(today && today !== '–') setText('glanceToday', today);

  // Collapsed-strip summary keeps the key numbers glanceable.
  const sum = $('statsToggleSummary');
  if(sum){
    sum.textContent = (solar && solar !== '–' && today && today !== '–')
      ? `${solar} W · ${today} kWh today` : '';
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
  // the tooltip).
  const nowSub = $('glanceNowSub');
  if(nowSub){
    if(plantKwp && nowW !== null && nowW > 0){
      const pctCap = (nowW / (plantKwp * 1000)) * 100;
      nowSub.textContent = `${Math.round(pctCap)}% · ${Number(plantKwp).toFixed(1)} kWp`;
      nowSub.title = `Live output as % of installed DC capacity (${plantKwp} kWp). Gauge dial stays on inverter rating.`;
    }else if(!plantKwp){
      if(nowSub.textContent !== 'solar input') nowSub.textContent = 'solar input';
      nowSub.removeAttribute('title');
    }
  }
}

function syncState(){
  const mode = text('modeText').toLowerCase();
  const conn = text('connText').toLowerCase();
  const dot = $('glanceDot');
  const label = $('glanceState');
  const sub = $('glanceSub');
  if(!label) return;
  let state = 'Live';
  let cls = 'dot live';
  if(mode.includes('night')){
    state = 'Night · resting';
    cls = 'dot night';
  }else if(conn.includes('connect') || conn.includes('sync') || conn.includes('retry') || conn.includes('offline')){
    state = conn || 'Connecting';
    cls = 'dot down';
  }
  label.textContent = state;
  if(dot) dot.className = cls;
  const tdot = $('statsToggleDot');
  if(tdot) tdot.className = cls;
  if(sub) sub.textContent = mode.includes('night') ? 'inverter asleep · resumes at sunrise' : 'live summary';
}

export function initGlance(){
  syncNumbers();
  syncState();
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
    syncNumbers();
    syncState();
    if(Date.now() - lastPeakFetch > PEAK_REFRESH_MS) refreshTodayPeak();
    if(Date.now() - lastCapacityFetch > PEAK_REFRESH_MS) refreshCapacity();
  }, 5000);
  refreshTodayPeak();
  refreshCapacity();
}
