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

// ---------- Icon SVGs ----------
// One compact line-icon per common icon name; stroke uses currentColor so
// the theme controls tinting.
const ICON_PATHS = {
  'sun': `<circle cx="12" cy="12" r="4.4" fill="none"/>
    <g stroke-linecap="round"><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5 5l1.8 1.8M17.2 17.2 19 19M5 19l1.8-1.8M17.2 6.8 19 5"/></g>`,
  'partly-cloudy': `<circle cx="15.5" cy="7" r="3" fill="none"/>
    <g stroke-linecap="round"><path d="M15.5 1.8v1M20.7 7h1M19.3 3.2l-.8.8M11.7 4l-.8-.8"/></g>
    <path d="M6 18a3 3 0 0 1-.2-6 4.2 4.2 0 0 1 8.2-1A3.3 3.3 0 0 1 16 18z" fill="none"/>`,
  'cloudy': `<path d="M6.5 18a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.7-1.4A4.3 4.3 0 0 1 16.5 18z" fill="none"/>`,
  'fog': `<path d="M6.5 15a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.7-1.4A4.3 4.3 0 0 1 16.5 15z" fill="none"/>
    <g stroke-linecap="round"><path d="M5 18h14M7 21h10"/></g>`,
  'drizzle': `<path d="M6.5 13a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.7-1.4A4.3 4.3 0 0 1 16.5 13z" fill="none"/>
    <g stroke-linecap="round"><path d="M9 16v1.5M13 16v1.5M11 19.5V21M15 19.5V21"/></g>`,
  'rain': `<path d="M6.5 13a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.7-1.4A4.3 4.3 0 0 1 16.5 13z" fill="none"/>
    <g stroke-linecap="round"><path d="M8.5 15.5 7.5 19M12.5 15.5l-1 3.5M16.5 15.5l-1 3.5M10.5 20l-.5 1.5"/></g>`,
  'snow': `<path d="M6.5 13a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.7-1.4A4.3 4.3 0 0 1 16.5 13z" fill="none"/>
    <g stroke-linecap="round"><path d="M8.5 17h.01M12.5 17h.01M16.5 17h.01M10.5 20.5h.01M14.5 20.5h.01"/></g>`,
  'thunder': `<path d="M6.5 12a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 10.7-1.4A4.3 4.3 0 0 1 16.5 12h-3z" fill="none"/>
    <path d="m12.5 11.5-3 5h2.5l-1.5 5 4.5-6.5h-2.5z"/>`,
};

function iconSVG(name){
  return `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor"
           stroke-width="1.4" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS['cloudy']}</svg>`;
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
