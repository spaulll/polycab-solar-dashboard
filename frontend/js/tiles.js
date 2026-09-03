// Live stat tiles: sparkline backdrops fed by an in-memory ~30 minute
// rolling window of readings. Purely decorative context for the numbers --
// tiles keep rendering even when the window is empty (honest degradation:
// no sparkline until real samples exist, never a fabricated line).

import { sparkline } from './svg.js';

const WINDOW_MS = 30 * 60 * 1000;

// One sparkline per tile; the metric comes from data-spark on the .spark
// element (the Grid V/A card tracks current -- the live-er of the two).
const TILES = [
  'Solar_Input',
  'L1_Current',
  'Inverter_Power',
  'Temperature',
  'E_Today',
];

const holders = new Map();  // metric -> container element
const buffers = new Map();  // metric -> [{t, v}]
let maxPoints = 400;        // safety cap (~30 min at 5s sampling)

function initTiles(){
  document.querySelectorAll('.spark[data-spark]').forEach(holder => {
    const key = holder.dataset.spark;
    holders.set(key, holder);
    buffers.set(key, []);
  });
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
    const svg = sparkline(pts, { width: 120, height: 34 });
    // First honest line per tile draws itself in; later live refreshes
    // swap silently so the backdrop never strobes on every WS tick.
    if(pts.length >= 2 && !holder._sparkDrawn){
      holder._sparkDrawn = true;
      const path = svg.querySelector('path');
      if(path) path.classList.add('draw');
    }
    holder.replaceChildren(svg);
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
