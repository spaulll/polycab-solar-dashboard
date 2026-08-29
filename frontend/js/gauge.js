// Output gauge: CSS-only speedometer in the spirit of summerphil's
// "CSS only speedometer" (codepen.io/summerphil/pen/LbOwKX) — a thick
// semicircular track, a colored value arc that sweeps with the reading, a
// rotating needle, and a clean hairline base — rebuilt in pure SVG + CSS on
// the repo's shared arc plumbing (svg.js), no vendored library.
//
// Design rules for this widget:
//   - Dial scale derives from the inverter's rated output (config.js):
//     rounded up to the next whole kW (3600 W -> 0-4 kW dial). The head tag
//     carries the scale; faint ticks every 500 W anchor the needle.
//   - Indicator = the pen's sweeping value arc (accent) + a thin needle at
//     its leading edge, both driven by CSS transitions on transform /
//     stroke-dashoffset, so motion stays on the compositor and collapses to
//     an instant set under prefers-reduced-motion (CSS media query).
//   - Colors are plain CSS custom properties resolved inside styles.css, so
//     theme switches recolor the drawing with zero JS.
//   - Honest degradation: a missing reading (or night mode) eases the
//     needle to rest and shows '–' — never a fabricated 0 W. Night mode
//     additionally dims the whole panel like the stat cards.
//
// The SVG is aria-hidden; the accessible surface is the DOM readout beside
// the dial (live watts + approximate kWh/h), kept in lock-step per update.

import { INVERTER_RATED_W } from './config.js';
import { tweenNumber } from './motion.js';
import { svgEl, polar, arcPath } from './svg.js';

const el = id => document.getElementById(id);

// Dial geometry in viewBox units (200 x 112): pivot at the base-line
// center, track radius sized so the pen-style ring fills the width.
const VIEW_W = 200, VIEW_H = 112;
const CX = 100, CY = 100, R = 82;
const TRACK_W = 11;

let built = false;
let needleEl = null;       // <g> rotated by CSS transform
let fillEl = null;         // value arc <path> (stroke-dashoffset)
let panelEl = null;
let lastWatts = null;      // last value applied (number | null)
let lastNight = false;

// ---------- scale math ----------

// Round the rated output up to a whole kW (3600 -> 4000). Floors at 1000 so
// a misconfigured rating can't produce a degenerate dial.
export function gaugeMax(ratedW = INVERTER_RATED_W){
  const kw = Math.max(1, Math.ceil(ratedW / 1000));
  return kw * 1000;
}

// Needle bearing for a value: -90deg (rest, pointing at the left base end)
// to +90deg (full scale, right base end). Clamped to the dial.
export function gaugeAngle(watts, max){
  const v = Math.max(0, Math.min(Number(watts) || 0, max));
  return -90 + 180 * (v / max);
}

// ---------- SVG construction ----------

function buildDial(max){
  const svg = svgEl('svg', {
    viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
    class: 'gauge-svg',
    'aria-hidden': 'true',
  });

  // Track: the pen's thick semicircular "groove".
  const d = arcPath(CX, CY, R, Math.PI, 0);
  svg.appendChild(svgEl('path', { d, class: 'gauge-track' }));

  // Ticks every 500 W (majors at whole kW), just inside the track.
  const steps = max / 500;         // 500 W steps across the 180deg sweep
  const ticks = svgEl('g', { class: 'gauge-ticks' });
  for(let k = 0; k <= steps; k++){
    const a = Math.PI - (Math.PI * k) / steps;
    const major = k % 2 === 0;
    const r1 = R - TRACK_W / 2 - 2.5;
    const [x1, y1] = polar(CX, CY, r1, a);
    const [x2, y2] = polar(CX, CY, r1 - (major ? 7 : 4), a);
    ticks.appendChild(svgEl('line', {
      x1: x1.toFixed(2), y1: y1.toFixed(2),
      x2: x2.toFixed(2), y2: y2.toFixed(2),
      class: major ? 'gauge-tick-major' : 'gauge-tick-minor',
    }));
  }
  svg.appendChild(ticks);

  // Value arc: the pen's colored sweep, grown via stroke-dashoffset.
  fillEl = svgEl('path', {
    d, class: 'gauge-fill',
    pathLength: 100,
    'stroke-dasharray': '100',
    'stroke-dashoffset': '100',
  });
  svg.appendChild(fillEl);

  // Needle: drawn pointing at 12 o'clock; rotation does the rest.
  needleEl = svgEl('g', { class: 'gauge-needle' }, [
    svgEl('polygon', {
      points: `${CX - 2.2},${CY - 5} ${CX},${CY - R + TRACK_W / 2 + 3.5} ${CX + 2.2},${CY - 5}`,
      class: 'gauge-needle-shape',
    }),
  ]);
  svg.appendChild(needleEl);

  // Hub + the pen's clean hairline base under the dial.
  svg.appendChild(svgEl('circle', { cx: CX, cy: CY, r: 5, class: 'gauge-hub' }));
  svg.appendChild(svgEl('line', {
    x1: 6, y1: CY + TRACK_W / 2 + 1, x2: VIEW_W - 6, y2: CY + TRACK_W / 2 + 1,
    class: 'gauge-base',
  }));

  return svg;
}

// ---------- indicator + readout ----------

function setIndicator(watts, max){
  const deg = gaugeAngle(watts, max);
  if(needleEl) needleEl.style.transform = `rotate(${deg.toFixed(2)}deg)`;
  // pathLength 100: offset 100 = empty (rest), 0 = full sweep.
  if(fillEl) fillEl.style.strokeDashoffset = (100 - (deg + 90) / 1.8).toFixed(2);
}

function fmtRate(watts){
  if(watts === null || watts <= 0) return '';
  // 1000 W ≈ 1 kWh/h, one decimal — an indication, not an integral.
  return '≈ ' + (watts / 1000).toFixed(1) + ' kWh/h';
}

function renderReadout(watts){
  const numEl = el('gaugeValue');
  // undefined (not null): Number(null) is 0, and motion.js would happily
  // tween a missing reading to a fabricated "0". undefined is its
  // missing-value sentinel and renders '–'.
  if(numEl) tweenNumber(numEl, watts === null ? undefined : watts, 0);
  const rateEl = el('gaugeRate');
  if(rateEl){
    const text = (watts !== null && !lastNight) ? fmtRate(watts) : '';
    // Keep the line's height reserved; hide without layout shift.
    rateEl.textContent = text || '\u00a0';
    rateEl.classList.toggle('active', Boolean(text));
  }
}

function setPanelDim(dim){
  if(panelEl) panelEl.classList.toggle('dim', Boolean(dim));
}

// ---------- public API ----------

export function initGauge(){
  if(built) return;
  const dial = el('gaugeDial');
  panelEl = el('gaugePanel');
  if(!dial) return;
  built = true;

  const max = gaugeMax();
  dial.replaceChildren(buildDial(max));
  const tag = el('gaugeScale');
  if(tag) tag.textContent = `0–${max / 1000} kW`;
  setIndicator(0, max);
}

// Feed one live reading. `watts` may be null/undefined (missing data): the
// needle eases to rest and the readout shows '–'. Readings are ignored as
// live values while night mode is active (a stale final reading shouldn't
// present as current output).
export function updateGauge(watts){
  if(!built) return;
  if(lastNight) watts = null;
  const n = (watts === null || watts === undefined || Number.isNaN(Number(watts)))
    ? null
    : Number(watts);
  lastWatts = n;
  setIndicator(n === null ? 0 : n, gaugeMax());
  renderReadout(n);
}

// Night mode / restore. Night mode eases the needle to rest and dims the
// panel exactly like the stat cards dim.
export function dimGauge(night){
  if(!built) return;
  lastNight = Boolean(night);
  setPanelDim(lastNight);
  if(lastNight){
    lastWatts = null;
    updateGauge(null);
  } else if(lastWatts !== null){
    updateGauge(lastWatts);
  } else {
    renderReadout(null);
  }
}
