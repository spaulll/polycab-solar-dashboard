// Weather chip in the top bar + click-to-open popup card with dimmed,
// backdrop-blurred background. Fetches /api/weather (provider-agnostic);
// when data is unavailable the chip shows "–°" and the popup stays closed.

import { WEATHER_REFRESH_MS } from './config.js';
import { fetchWeather, fetchTomorrowForecast } from './api.js';

const el = id => document.getElementById(id);

const chip = el('weatherChip'), chipIcon = el('weatherIcon'),
      chipTemp = el('weatherTemp');
const overlay = el('weatherOverlay');

let weatherData = null;

// ---------- Icons ----------
// All weather glyphs live in the index.html <symbol> sprite (wi-*); here we
// only stamp out <use> references. Unknown names fall back to the cloud.
const WEATHER_ICONS = new Set([
  'sun', 'partly-cloudy', 'cloudy', 'fog',
  'drizzle', 'rain', 'snow', 'thunder',
]);

function iconSVG(name){
  const id = WEATHER_ICONS.has(name) ? name : 'cloudy';
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#wi-${id}"/></svg>`;
}

// ---------- Rendering ----------
function render(w){
  weatherData = w;
  const unavailable = !w || w.temp == null;
  chip.classList.toggle('unavailable', unavailable);

  chipIcon.innerHTML = iconSVG(unavailable ? 'cloudy' : w.icon);
  chipTemp.textContent = unavailable ? '–°' : `${Math.round(w.temp)}°`;

  if(unavailable){
    el('wcTemp').textContent = '–°';
    el('wcCondition').textContent = 'Weather unavailable';
    el('wcProvider').textContent = '';
    el('wcForecast').innerHTML = '';
    ['wcFeels','wcHumidity','wcWind','wcCloud','wcPop','wcHiLo'].forEach(id =>
      el(id).textContent = '–');
    return;
  }

  chip.title = `${w.condition} · ${Math.round(w.temp)}°`;

  // Popup card
  el('wcIcon').innerHTML = iconSVG(w.icon);
  el('wcTemp').textContent = `${Math.round(w.temp)}°`;
  el('wcCondition').textContent = w.condition;
  el('wcFeels').textContent = `${Math.round(w.feels_like)}°`;
  el('wcHumidity').textContent = w.humidity != null ? `${w.humidity}%` : '–';
  el('wcWind').textContent = `${w.wind_speed} km/h`;
  el('wcCloud').textContent = w.cloud_cover != null ? `${w.cloud_cover}%` : '–';
  el('wcPop').textContent = `${w.pop ?? 0}%`;
  el('wcHiLo').textContent =
    w.high != null && w.low != null
      ? `${Math.round(w.high)}° / ${Math.round(w.low)}°`
      : '–';

  const fc = Array.isArray(w.forecast) ? w.forecast : [];
  el('wcForecast').innerHTML = fc.length
    ? fc.map(f => `
        <div class="wf-item">
          <span class="wf-time">${fmtHour(f.time)}</span>
          <span class="wf-icon">${iconSVG(f.icon)}</span>
          <span class="wf-pop">${f.pop != null ? Math.round(f.pop) + '%' : ''}</span>
          <span class="wf-temp">${Math.round(f.temp)}°</span>
        </div>`).join('')
    : '<p class="wf-empty">No forecast available</p>';

  el('wcProvider').textContent =
    `via ${w.provider === 'openweathermap' ? 'OpenWeatherMap' : 'Open-Meteo'}`;

  // Tomorrow estimate loads separately (same cadence); render honestly.
  loadTomorrowIntoPopup();
}

function renderTomorrowPopup(t){
  const node = el('wcTomorrow');
  if(!node) return;
  const ok = t && t.expected_kwh !== null && t.expected_kwh !== undefined
    && t.typical_kwh !== null && t.typical_kwh !== undefined
    && (t.day_count ?? 0) >= 3;
  if(!ok){
    node.hidden = false;
    node.textContent = 'Tomorrow: collecting data…';
    node.title = 'Needs 3+ days of history and a daylight forecast. Night/empty history degrades honestly.';
    return;
  }
  const exp = Number(t.expected_kwh).toFixed(1);
  const typ = Number(t.typical_kwh).toFixed(1);
  const cloud = (t.cloud_pct !== null && t.cloud_pct !== undefined)
    ? `, cloudy ${Math.round(t.cloud_pct)}%` : '';
  node.hidden = false;
  node.textContent = `Tomorrow ≈ ${exp} kWh (typical ${typ}${cloud})`;
  node.title = `Expected tomorrow from daylight-cloud derate of your typical day. Provider: ${t.provider || '–'}. Estimated, not metered.`;
}

async function loadTomorrowIntoPopup(){
  try{
    renderTomorrowPopup(await fetchTomorrowForecast());
  }catch(e){
    console.error('Failed to load tomorrow forecast', e);
    renderTomorrowPopup(null);
  }
}

// Forecast times are local ISO strings ("2026-08-24T13:00:00") or HH:MM.
function fmtHour(t){
  if(typeof t === 'string' && t.includes('T')){
    return t.slice(11, 16);
  }
  return t;
}

async function loadWeather(){
  try{
    render(await fetchWeather());
  }catch(e){
    console.error('Failed to load weather', e);
    render(null);
  }
  // Popup tomorrow row refreshes on the same weather cadence.
  loadTomorrowIntoPopup();
}

// ---------- Popup open/close ----------
function openPopup(){
  overlay.hidden = false;
  chip.setAttribute('aria-expanded', 'true');
  // Next frame so the transition from hidden -> visible actually runs.
  requestAnimationFrame(() => requestAnimationFrame(() =>
    overlay.classList.add('open')));
}

function closePopup(){
  overlay.classList.remove('open');
  chip.setAttribute('aria-expanded', 'false');
  setTimeout(() => { overlay.hidden = true; }, 360); // match spring fade-out
}

chip.addEventListener('click', () => {
  if(!weatherData) return;   // unavailable: popup stays disabled
  overlay.hidden ? openPopup() : closePopup();
});
el('weatherClose').addEventListener('click', closePopup);
overlay.addEventListener('click', e => {
  if(e.target === overlay) closePopup();     // click on dimmed backdrop
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && !overlay.hidden) closePopup();
});

// ---------- Bottom sheet drag (touch) ----------
// The sheet follows the pointer below its rest position; releasing past a
// threshold dismisses it, otherwise it springs back. The handle is hidden
// on desktop, so this stays inert there.
(function initSheetDrag(){
  const card = overlay.querySelector('.weather-card');
  const handle = el('weatherDrag');
  let active = false, startY = 0, dy = 0;

  handle.addEventListener('pointerdown', e => {
    if(overlay.hidden || !overlay.classList.contains('open')) return;
    active = true;
    startY = e.clientY;
    dy = 0;
    card.style.transition = 'none';
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', e => {
    if(!active) return;
    dy = Math.max(0, e.clientY - startY);
    card.style.transform = `translateY(${dy}px)`;
    // Fade the sheet slightly as it travels for a physical feel.
    card.style.opacity = String(Math.max(0.55, 1 - dy / 400));
  });

  const release = () => {
    if(!active) return;
    active = false;
    card.style.transition = '';
    card.style.opacity = '';
    if(dy > 90){
      card.style.transform = '';
      closePopup();
    }else{
      card.style.transform = '';
    }
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
})();

export function initWeather(){
  loadWeather();
  setInterval(loadWeather, WEATHER_REFRESH_MS);
}
