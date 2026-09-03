// Output gauge + inverter mood: CSS-only speedometer in the spirit of
// summerphil's "CSS only speedometer" (codepen.io/summerphil/pen/LbOwKX) —
// a thick semicircular track, a colored value arc that sweeps with the
// reading, a rotating needle, and a clean hairline base — rebuilt in pure
// SVG + CSS on the repo's shared arc plumbing (svg.js), no vendored
// library. Beside it sits a pure-CSS sky scene (halo, sun/moon, rays,
// cloud, stars, horizon) over the mood word + capacity %, so the short/wide
// single gauge card becomes two balanced squares.
//
// Design rules for this widget:
//   - Dial scale derives from the inverter's rated output (config.js):
//     rounded up to the next whole kW (3600 W -> 0-4 kW dial). The gauge
//     card tooltip carries the scale; faint ticks every 500 W anchor the
//     needle. The mood card tooltip lists its levels.
//   - Indicator = the pen's sweeping value arc (accent) + a thin needle at
//     its leading edge, both driven by CSS transitions on transform /
//     stroke-dashoffset, so motion stays on the compositor and collapses to
//     an instant set under prefers-reduced-motion (CSS media query).
//   - Mood = % of dial max: resting (0) → waking (<7%) → trickling (<30%)
//     → cruising (<65%) → humming (<85%) → peaking (>=85%). Night (or a
//     debug pin) overrides the word: sleeping at night, debug value while
//     pinned. data-mood on the panel picks the sky state (data-level keeps
//     the numeric 0–5 scale for tests); every state change cross-fades on
//     long transform/opacity transitions while ambient layers (ray spin,
//     cloud drift, twinkle, burst) loop independently — nothing pops, even
//     when fast-forwarding through the whole day.
//   - Colors are plain CSS custom properties resolved inside styles.css, so
//     theme switches recolor the drawing with zero JS.
//   - Honest degradation: a missing reading (or night mode) eases the
//     needle to rest and shows '–' — never a fabricated 0 W. Night mode
//     additionally dims both cards like the stat cards, shows
//     'until sunrise' in the rate line, and parks the mood on sleeping.
//
// The SVG + sky are aria-hidden; the accessible surface is the DOM readout
// (live watts + approximate kWh/h) plus the mood word, kept in lock-step.

import { INVERTER_RATED_W } from './config.js';
import { tweenNumber } from './motion.js';
import { svgEl, polar, arcPath } from './svg.js';

const el = id => document.getElementById(id);

// Dial geometry in viewBox units (200 x 112): pivot at the base-line
// center, track radius sized so the pen-style ring fills the width.
const VIEW_W = 200, VIEW_H = 112;
const CX = 100, CY = 100, R = 82;
const TRACK_W = 11;

// Mood scale, low to high. The card tooltip lists these in order; the
// words are the single source of truth for renderMood() below.
const MOOD_ORDER = 'resting → waking → trickling → cruising → humming → peaking';

let built = false;
let needleEl = null;       // <g> rotated by CSS transform
let fillEl = null;         // value arc <path> (stroke-dashoffset)
let panelEl = null;
let moodPanelEl = null;
let moodWordEl = null;
let moodSubEl = null;
let lastWatts = null;      // last live value applied (number | null)
let lastNight = false;
let debugWatts = null;     // explicit pin for screenshots; null = follow live

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

// Mood for a live value as % of dial max. null/zero parks on resting;
// night is resolved by the caller (sleeping), never here.
function moodFor(watts, max){
  if(watts === null || watts <= 0) return { level: 0, word: 'Resting' };
  const ratio = watts / max;
  if(ratio < 0.07) return { level: 1, word: 'Waking' };
  if(ratio < 0.30) return { level: 2, word: 'Trickling' };
  if(ratio < 0.65) return { level: 3, word: 'Cruising' };
  if(ratio < 0.85) return { level: 4, word: 'Humming' };
  return { level: 5, word: 'Peaking' };
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
    // Night names the wait instead of going blank; the line's height is
    // always reserved (no-break space) so the card never reflows.
    if(lastNight && debugWatts === null){
      rateEl.textContent = 'until sunrise';
      rateEl.classList.toggle('active', false);
    } else {
      const text = (watts !== null) ? fmtRate(watts) : '';
      rateEl.textContent = text || '\u00a0';
      rateEl.classList.toggle('active', Boolean(text));
    }
  }
}

function renderMood(watts){
  const max = gaugeMax();
  let level, word;
  let sub = '';
  // A debug pin wins over night so screenshots can force any mood; night
  // otherwise parks the card on sleeping.
  if(lastNight && debugWatts === null){
    level = 0;
    word = 'Sleeping';
    sub = 'inverter asleep';
  } else {
    ({ level, word } = moodFor(watts, max));
    if(watts !== null && watts > 0){
      sub = `${Math.round((watts / max) * 100)}% of ${max / 1000} kW`;
    }
  }
  if(moodPanelEl){
    moodPanelEl.setAttribute('data-level', String(level));
    // data-mood selects the CSS sky state; data-level keeps the numeric
    // 0–5 scale. Both move together — the scene cross-fades via transitions.
    moodPanelEl.setAttribute('data-mood', word.toLowerCase());
  }
  if(moodWordEl){
    // Re-trigger the fade-rise cue only when the word itself flips, so
    // %-ticks don't replay it. Guarded: the test harness stubs the word
    // as a bare { textContent } with no classList.
    if(moodWordEl.textContent !== word){
      moodWordEl.textContent = word;
      const cl = moodWordEl.classList;
      if(cl && typeof moodWordEl.offsetWidth === 'number'){
        cl.remove('swap');
        void moodWordEl.offsetWidth;
        cl.add('swap');
      }
    }
  }
  if(moodSubEl){
    moodSubEl.textContent = sub || '\u00a0';
    moodSubEl.classList.toggle('active', Boolean(sub));
  }
}

// One fully-resolved value onto needle + readout + mood. Callers resolve
// night/debug first; this just paints.
function applyWatts(n){
  setIndicator(n === null ? 0 : n, gaugeMax());
  renderReadout(n);
  renderMood(n);
}

function setPanelDim(dim){
  if(panelEl) panelEl.classList.toggle('dim', Boolean(dim));
  if(moodPanelEl) moodPanelEl.classList.toggle('dim', Boolean(dim));
}

// ---------- public API ----------

export function initGauge(){
  if(built) return;
  const dial = el('gaugeDial');
  if(!dial) return;
  panelEl = el('gaugePanel');
  moodPanelEl = el('gaugeMoodPanel');
  moodWordEl = el('gaugeMoodWord');
  moodSubEl = el('gaugeMoodSub');
  built = true;

  const max = gaugeMax();
  dial.replaceChildren(buildDial(max));
  // The scale lives in the gauge card's tooltip (and the dial's ticks);
  // the mood card's tooltip lists its levels — the readouts stay minimal.
  if(panelEl) panelEl.title = `Inverter output · scale 0–${max / 1000} kW`;
  if(moodPanelEl) moodPanelEl.title = `Inverter mood · ${MOOD_ORDER}`;
  setIndicator(0, max);
  renderReadout(null);
  renderMood(null);
}

// Feed one live reading. `watts` may be null/undefined (missing data): the
// needle eases to rest and the readout shows '–'. Readings are ignored as
// live values while night mode is active (a stale final reading shouldn't
// present as current output), and while a debug pin holds the dial.
export function updateGauge(watts){
  if(!built) return;
  if(debugWatts !== null) return;
  if(lastNight) watts = null;
  const n = (watts === null || watts === undefined || Number.isNaN(Number(watts)))
    ? null
    : Number(watts);
  lastWatts = n;
  applyWatts(n);
}

// Night mode / restore. Night mode eases the needle to rest, names the
// wait, parks the mood on sleeping, and dims both cards exactly like the
// stat cards dim. A debug pin keeps its display through the dim.
export function dimGauge(night){
  if(!built) return;
  lastNight = Boolean(night);
  setPanelDim(lastNight);
  if(lastNight){
    lastWatts = null;
    applyWatts(debugWatts !== null ? debugWatts : null);
  } else if(debugWatts !== null){
    applyWatts(debugWatts);
  } else if(lastWatts !== null){
    applyWatts(lastWatts);
  } else {
    applyWatts(null);
  }
}

// Screenshot/debug override: pin the dial + mood to an explicit wattage;
// live readings are ignored until released with null. Release clears to
// the honest empty state (never restores a stale live value).
export function setDebugWatts(watts){
  if(!built) return;
  if(watts === null || watts === undefined || !Number.isFinite(Number(watts))){
    debugWatts = null;
    lastWatts = null;
    applyWatts(null);
    return;
  }
  debugWatts = Number(watts);
  applyWatts(debugWatts);
}
