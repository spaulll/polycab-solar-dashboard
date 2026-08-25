// Sun path card: an SVG semicircle tracing today's sun arc with a "now"
// marker, sunrise/sunset times, and a 1-second countdown ticker. At night
// the marker rides the moon path below the horizon and counts to sunrise.
// Astral data still comes exclusively from the server (/api/sun); this
// module only renders it. Refreshes from the server when a countdown
// reaches zero (to flip sunrise<->sunset) and periodically over long sessions.

import { SUN_COUNTDOWN_TICK_MS } from './config.js';
import { fmtClock, fmtDuration } from './format.js';
import { fetchSunInfo } from './api.js';
import { svgEl, polar } from './svg.js';

const el = id => document.getElementById(id);

const plot = el('sunArcPlot');
const card = el('sunArcCard');

let sunTargetSunrise = null; // Date — next sunrise
let sunTargetSunset = null;  // Date — next sunset
let daySunrise = null;       // Date — today's actual window
let daySunset = null;
let sunIsNight = false;

// Built once, mutated per tick.
let els = null;

function buildArc(){
  const size = 200;
  const cx = size / 2;
  const cy = size * 0.86;
  const r = size / 2 - 6;
  plot.replaceChildren();

  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' });

  // Moon path (below horizon) — shown at night.
  const rm = r * 0.62;
  const [mx1, my1] = polar(cx, cy, rm, Math.PI);
  const [mx2, my2] = polar(cx, cy, rm, 0);
  const moonTrack = svgEl('path', {
    d: `M ${mx1.toFixed(2)} ${my1.toFixed(2)} A ${rm.toFixed(2)} ${rm.toFixed(2)} 0 0 0 ${mx2.toFixed(2)} ${my2.toFixed(2)}`,
    fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.5, opacity: 0, 'stroke-linecap': 'round',
    class: 'sun-arc-moon-track',
  });

  // Day track above the horizon.
  const [tx1, ty1] = polar(cx, cy, r, Math.PI);
  const [tx2, ty2] = polar(cx, cy, r, 0);
  const dayTrack = svgEl('path', {
    d: `M ${tx1.toFixed(2)} ${ty1.toFixed(2)} A ${r} ${r} 0 0 1 ${tx2.toFixed(2)} ${ty2.toFixed(2)}`,
    fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.5, opacity: 0.35, 'stroke-linecap': 'round',
    class: 'sun-arc-day-track',
  });

  // Elapsed portion of the day path (day only).
  const elapsed = svgEl('path', {
    d: '', fill: 'none', stroke: 'currentColor',
    'stroke-width': 3, 'stroke-linecap': 'round',
    class: 'sun-arc-elapsed', opacity: 0,
  });

  // Horizon hairline.
  const horizon = svgEl('line', {
    x1: cx - r - 4, y1: cy, x2: cx + r + 4, y2: cy,
    stroke: 'currentColor', 'stroke-width': 1,
    opacity: 0.25, 'stroke-linecap': 'round',
  });

  // "Now" marker.
  const marker = svgEl('circle', {
    cx: cx, cy: cy, r: 4.5, fill: 'currentColor',
    class: 'sun-arc-now',
  });

  svg.append(moonTrack, dayTrack, elapsed, horizon, marker);
  plot.appendChild(svg);

  els = { svg, cx, cy, r, elapsed, marker, dayTrack, moonTrack };
}

function renderArc(progress){
  if(!els) buildArc();
  const { cx, cy, r, elapsed, marker } = els;
  card.classList.toggle('night', sunIsNight);

  if(sunIsNight){
    // Night: marker rides the below-horizon moon path from sunset toward
    // sunrise; elapsed day path hidden.
    els.elapsed.setAttribute('opacity', 0);
    const rm = r * 0.62;
    const angle = Math.PI * (1 - Math.min(1, Math.max(0, progress)));
    const [x, y] = polar(cx, cy, rm, angle);
    marker.setAttribute('cx', x.toFixed(2));
    marker.setAttribute('cy', y.toFixed(2));
  }else{
    els.elapsed.setAttribute('opacity', 1);
    const frac = Math.min(1, Math.max(0, progress));
    if(frac > 0){
      elapsed.setAttribute('d',
        `M ${(cx - r).toFixed(2)} ${cy.toFixed(2)} A ${r} ${r} 0 0 1 ${(cx + r * Math.cos(Math.PI * (1 - frac))).toFixed(2)} ${(cy - r * Math.sin(Math.PI * (1 - frac))).toFixed(2)}`);
    }else{
      elapsed.setAttribute('d', '');
    }
    const [x, y] = polar(cx, cy, r, Math.PI * (1 - frac));
    marker.setAttribute('cx', x.toFixed(2));
    marker.setAttribute('cy', y.toFixed(2));
  }
}

function updateSunInfo(sun){
  sunTargetSunrise = sun.next_sunrise ? new Date(sun.next_sunrise) : null;
  sunTargetSunset = sun.next_sunset ? new Date(sun.next_sunset) : null;
  daySunrise = sun.sunrise ? new Date(sun.sunrise) : null;
  daySunset = sun.sunset ? new Date(sun.sunset) : null;
  sunIsNight = !!sun.is_night;

  el('sunNextSunrise').textContent = fmtClock(sun.next_sunrise);
  el('sunNextSunset').textContent = fmtClock(sun.next_sunset);
  el('sunCountdownLabel').textContent = sunIsNight ? 'Time to sunrise' : 'Time to sunset';

  tickSunCountdown(); // render immediately instead of waiting for next tick
}

function tickSunCountdown(){
  const target = sunIsNight ? sunTargetSunrise : sunTargetSunset;
  if(!target){
    el('sunCountdown').textContent = '–';
    return;
  }
  const now = new Date();
  const secondsLeft = (target - now) / 1000;
  el('sunCountdown').textContent = fmtDuration(secondsLeft);

  // Marker progress along the active path.
  let progress = 0;
  if(sunIsNight){
    // From today's/last sunset toward next sunrise.
    const start = daySunset && daySunset < now ? daySunset : null;
    if(start && target > start) progress = (now - start) / (target - start);
  }else if(daySunrise && daySunset && daySunset > daySunrise){
    progress = (now - daySunrise) / (daySunset - daySunrise);
  }
  renderArc(progress);

  // If the countdown reaches zero, refresh from the server to flip
  // sunrise<->sunset mode and pick up the new target time.
  if(secondsLeft <= 0){
    refreshSunInfo();
  }
}

async function refreshSunInfo(){
  try{
    updateSunInfo(await fetchSunInfo());
  }catch(e){
    console.error('Failed to load sun info', e);
  }
}

function startSunTicker(){
  setInterval(tickSunCountdown, SUN_COUNTDOWN_TICK_MS);
}

export { updateSunInfo, refreshSunInfo, startSunTicker };
