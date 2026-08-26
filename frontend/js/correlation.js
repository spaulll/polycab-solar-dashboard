// Weather Impact workspace panel: how much clouds/rain actually cost this
// install, from /api/weather/correlation -- daily energy joined against the
// archived weather days that the maintenance thread backfills server-side.
//
// The panel owns the visibility gate (feature disabled server-side -> hidden
// entirely, like Savings & Impact), the coverage guard (<14 matched days ->
// a muted "collecting" note instead of percentages) and the lens toggle
// ("Days" scatter vs "Average" buckets); the chart itself lives in charts.js.
// Refreshes on the Daily Energy Log cadence (day mode only) and immediately
// on wake_up -- same lifecycle as every other panel (wiring in main.js).

import { fetchWeatherCorrelation } from './api.js';
import { fmt } from './format.js';
import { loadPref, savePref } from './prefs.js';
import { renderWeatherImpact, setWeatherView } from './charts.js';

const el = id => document.getElementById(id);

const VIEW_KEY = 'weatherView';
const VIEWS = ['scatter', 'buckets'];

// Below this many matched days the class averages would be noise: the tag
// says data is still being collected instead of showing percentages.
const COVERAGE_MIN_DAYS = 14;

function renderTag(payload){
  const tag = el('weatherTag');
  const clear = payload.classes?.clear;
  const cloudy = payload.classes?.cloudy;

  if(payload.matched_days < COVERAGE_MIN_DAYS || !clear || !cloudy ||
     clear.avg_kwh === null || cloudy.avg_kwh === null || clear.avg_kwh <= 0){
    tag.hidden = false;
    tag.textContent = 'collecting comparison data…';
    tag.title =
      `${payload.matched_days} of ${COVERAGE_MIN_DAYS} matched days so far. ` +
      'Daily weather is archived a few days behind real time, so recent ' +
      'days join the comparison as the nightly backfill reaches them.';
    return;
  }

  const pct = Math.round((1 - cloudy.avg_kwh / clear.avg_kwh) * 100);
  const sign = pct >= 0 ? '−' : '+';
  tag.hidden = false;
  // Most compact tag that still reads at a glance: weather glyphs stand in
  // for the Clear/Cloudy words (the buckets below carry the names and the
  // tooltip spells the rest out), one shared kWh, bare delta.
  tag.innerHTML =
    `<svg class="tag-ico" aria-hidden="true"><use href="#wi-sun"/></svg>${fmt(clear.avg_kwh, 1)}` +
    ` · <svg class="tag-ico" aria-hidden="true"><use href="#wi-cloudy"/></svg>${fmt(cloudy.avg_kwh, 1)} kWh` +
    ` ${sign}${Math.abs(pct)}%`;
  tag.title =
    `Average yield on clear days (<25% cloud, ${clear.days} days) vs ` +
    `cloudy days (>60%, ${cloudy.days} days). ` +
    (payload.pearson_r !== null && payload.pearson_r !== undefined
      ? `Cloud-vs-energy correlation r = ${fmt(payload.pearson_r, 2)}. ` : '') +
    `Matched ${payload.matched_days} of ${payload.total_generation_days} ` +
    'generation days; the most recent few days always trail the weather ' +
    'archive by a couple of days.';
}

async function loadWeatherImpact(){
  try{
    const payload = await fetchWeatherCorrelation();
    if(!payload || payload.error){
      console.warn('Weather correlation:', payload?.error);
      return;
    }
    // Feature opted out server-side: no archive fetches will ever land, so
    // an empty panel would be clutter -- hide it entirely.
    el('weatherPanel').hidden = payload.enabled === false;
    if(el('weatherPanel').hidden) return;
    renderTag(payload);
    renderWeatherImpact(payload);
  }catch(e){
    console.error('Failed to load weather correlation', e);
  }
}

// Lens toggle in the panel head; persists like every other range group.
function applyView(view, persist){
  const v = VIEWS.includes(view) ? view : 'scatter';
  document.querySelectorAll('#weatherViewToggle button[data-view]')
    .forEach(b => b.classList.toggle('active', b.dataset.view === v));
  setWeatherView(v);
  if(persist) savePref(VIEW_KEY, v);
}

function initWeatherImpact(){
  applyView(loadPref(VIEW_KEY, VIEWS, 'scatter'), false);
  document.getElementById('weatherViewToggle')
    .addEventListener('click', e => {
      const btn = e.target.closest('button[data-view]');
      if(btn) applyView(btn.dataset.view, true);
    });
}

export { loadWeatherImpact, initWeatherImpact };
