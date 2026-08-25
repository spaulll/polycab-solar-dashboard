// Live stat tiles: sparkline backdrops fed by an in-memory ~30 minute
// rolling window of readings. Purely decorative context for the numbers --
// tiles keep rendering even when the window is empty (honest degradation:
// no sparkline until real samples exist, never a fabricated line).

import { sparkline } from './svg.js';

const WINDOW_MS = 30 * 60 * 1000;

// metric key -> CSS color source (currentColor inherits from .spark)
const TILES = [
  { key: 'Solar_Input',   selector: '[data-tile="Solar_Input"] .spark' },
  { key: 'L1_Voltage',    selector: '[data-tile="L1_Voltage"] .spark' },
  { key: 'L1_Current',    selector: '[data-tile="L1_Current"] .spark' },
  { key: 'Inverter_Power',selector: '[data-tile="Inverter_Power"] .spark' },
  { key: 'Temperature',   selector: '[data-tile="Temperature"] .spark' },
  { key: 'E_Today',       selector: '[data-tile="E_Today"] .spark' },
];

const holders = new Map();  // metric -> container element
const buffers = new Map();  // metric -> [{t, v}]
let maxPoints = 400;        // safety cap (~30 min at 5s sampling)

function initTiles(){
  for(const t of TILES){
    const holder = document.querySelector(t.selector);
    if(holder) holders.set(t.key, holder);
    buffers.set(t.key, []);
  }
}

function pushSample(reading){
  const t = Date.parse(reading.timestamp);
  if(Number.isNaN(t)) return;
  for(const [key, buf] of buffers){
    const v = reading[key];
    if(v === null || v === undefined || Number.isNaN(Number(v))) continue;
    buf.push({ t, v: Number(v) });
  }
  trim();
}

function seedFromReadings(readings){
  for(const r of readings) pushSample(r);
  renderAll();
}

function trim(){
  const cutoff = Date.now() - WINDOW_MS;
  for(const buf of buffers.values()){
    while(buf.length && buf[0].t < cutoff) buf.shift();
    while(buf.length > maxPoints) buf.shift();
  }
}

function renderAll(){
  trim();
  for(const [key, holder] of holders){
    const pts = buffers.get(key).map(p => p.v);
    holder.replaceChildren(
      sparkline(pts, { width: 120, height: 34 })
    );
    holder.classList.toggle('empty', pts.length < 2);
  }
}

// Throttled re-render: WS ticks arrive every few seconds; redrawing six
// tiny SVG paths that often is fine, but throttle to 5s to stay idle-friendly.
let lastRender = 0;
function pushAndRender(reading){
  pushSample(reading);
  const now = Date.now();
  if(now - lastRender > 5000){
    lastRender = now;
    renderAll();
  }
}

export { initTiles, pushAndRender, seedFromReadings, renderAll };
