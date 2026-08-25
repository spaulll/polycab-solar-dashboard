// Temperature sidebar panel: inverter internal (heatsink) temperature.
// Data comes from /api/insights/temperature -- daylight-only aggregates
// computed server-side. The panel owns the stat rows, the derating note and
// the lens toggle ("Time" vs "Output"); the mini chart itself lives in
// charts.js like every other chart. Current temperature rides the live
// WebSocket reading -- no polling of its own.

import { fetchTemperatureInsights } from './api.js';
import { fmt } from './format.js';
import { loadPref, savePref } from './prefs.js';
import { renderTemperature, setTemperatureView } from './charts.js';

const el = id => document.getElementById(id);

const VIEW_KEY = 'temperatureView';
const VIEWS = ['tod', 'out'];

// Derating callout: informational only. Both bands must hold at least this
// many samples so a handful of hot-afternoon points can't fabricate a trend,
// and the drop must exceed DERATING_PP percentage points.
const CALLOUT_MIN_SAMPLES = 200;
const DERATING_PP = 2;

let reqId = 0;
let currentTempC = null;

function tempText(value, digits = 1){
  return value === null || value === undefined
    ? '–'
    : `${fmt(value, digits)} °C`;
}

// Live current temperature from the WS feed / initial status payload.
function updateCurrentTemp(value){
  currentTempC = (typeof value === 'number' && !Number.isNaN(value))
    ? value
    : null;
  el('tempNow').textContent = tempText(currentTempC);
}

function renderStats(payload){
  const r = payload?.records ?? {};

  updateCurrentTemp(currentTempC); // re-render in case data arrived first
  el('tempTodayMax').textContent = tempText(r.today_max);
  el('tempRecord').textContent = tempText(r.all_time_max);

  // Record row tooltip: when the record fell + where each number comes from.
  const hd = r.hottest_day;
  el('tempRecord').title = hd && hd.date
    ? `Hottest day on record: ${hd.date} at ${fmt(hd.temp_max, 1)} °C`
    : '';

  // Honest scope claim: detailed profiles only cover the raw retention
  // window; the record spans all stored history (daily aggregates are
  // permanent). The sensor measures the inverter's own heatsink, not the air.
  const span = payload?.detail_span;
  el('tempLabel').textContent =
    'inverter heatsink sensor · not ambient air';
  el('tempLabel').title =
    'Profiles aggregate daylight readings' +
    (span ? ` from ${span.from} to ${span.to}` : '') +
    '; the record covers all stored history via daily aggregates.';
}

// Derating check across output bands: top solid band's efficiency vs the
// mid band's. Returns a short human note or null.
function deratingNote(bands){
  const solid = (bands || []).filter(b =>
    b.eff !== null && b.eff !== undefined && b.n >= CALLOUT_MIN_SAMPLES);
  if(solid.length < 3) return null;
  const top = solid[solid.length - 1];
  const mid = solid[Math.floor((solid.length - 1) / 2)];
  const dropPP = (mid.eff - top.eff) * 100;
  if(dropPP <= DERATING_PP) return null;
  return `output efficiency dips ~${Math.round(dropPP)} pp at high load/temp`;
}

function renderNote(payload){
  const noteEl = el('tempNote');
  const note = deratingNote(payload?.by_output);
  if(note){
    noteEl.textContent = note;
    noteEl.title =
      'Energy-weighted DC→AC efficiency of the top output band compared ' +
      'with mid-range bands. Informational — heat-related losses are ' +
      'normal on hot afternoons.';
    noteEl.hidden = false;
  }else{
    noteEl.hidden = true;
  }
}

async function loadTemperature(){
  const req = ++reqId;
  try{
    const payload = await fetchTemperatureInsights();
    if(req !== reqId) return;
    if(payload.error){
      console.warn('Temperature insights:', payload.error);
      return;
    }
    renderStats(payload);
    renderNote(payload);
    renderTemperature(payload);
  }catch(e){
    console.error('Failed to load temperature insights', e);
  }
}

// Lens toggle in the panel head; persists like every other range group.
function applyView(view, persist){
  const v = VIEWS.includes(view) ? view : 'tod';
  document.querySelectorAll('#tempViewToggle button[data-view]')
    .forEach(b => b.classList.toggle('active', b.dataset.view === v));
  setTemperatureView(v);
  if(persist) savePref(VIEW_KEY, v);
}

function initTemperature(){
  applyView(loadPref(VIEW_KEY, VIEWS, 'tod'), false);
  document.getElementById('tempViewToggle')
    .addEventListener('click', e => {
      const btn = e.target.closest('button[data-view]');
      if(btn) applyView(btn.dataset.view, true);
    });
}

export { loadTemperature, updateCurrentTemp, initTemperature };
