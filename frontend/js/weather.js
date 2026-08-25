// Weather chip in the top bar + click-to-open popup card with dimmed,
// backdrop-blurred background. Fetches /api/weather (provider-agnostic);
// when data is unavailable the chip shows "–°" and the popup stays closed.

import { WEATHER_REFRESH_MS } from './config.js';
import { fetchWeather } from './api.js';

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
  setTimeout(() => { overlay.hidden = true; }, 220); // match CSS fade-out
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

export function initWeather(){
  loadWeather();
  setInterval(loadWeather, WEATHER_REFRESH_MS);
}
