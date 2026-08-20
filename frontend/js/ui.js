// Status pills, night banner, and stat-card DOM updates.
// Pure DOM layer: no fetching, no sockets, no charts.

import { fmt, fmtTime } from './format.js';
import { setNightMode } from './state.js';

const el = id => document.getElementById(id);

const connDot = el('connDot'), connText = el('connText');
const modeDot = el('modeDot'), modeText = el('modeText');
const nightBanner = el('nightBanner'), nightText = el('nightText');
const lastUpdated = el('lastUpdated');

function setConn(state){ // 'live' | 'down'
  connDot.className = 'dot ' + (state === 'live' ? 'live' : 'down');
  connText.textContent = state === 'live' ? 'live' : 'disconnected';
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
  el('statSolar').innerHTML = fmt(d.Solar_Input, 0) + '<span class="unit">W</span>';
  el('statGrid').innerHTML = fmt(d.L1_Voltage, 1) + '<span class="unit">V</span> / ' + fmt(d.L1_Current, 2) + '<span class="unit">A</span>';
  el('statInvPower').innerHTML = fmt(d.Inverter_Power, 0) + '<span class="unit">W</span>';
  el('statTemp').innerHTML = fmt(d.Temperature, 0) + '<span class="unit">°C</span>';
  el('statToday').innerHTML = fmt(d.E_Today, 2) + '<span class="unit">kWh</span>';
  el('statLifetime').innerHTML = fmt(d.E_Total, 1) + '<span class="unit">kWh</span>';
}

function dimStatCards(dim){
  document.querySelectorAll('.stat-card').forEach(c => c.classList.toggle('dim', dim));
}

function setLastUpdated(iso){
  lastUpdated.textContent = fmtTime(iso);
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
};
