// Sun path card: an instrument-grade SVG semicircle tracing today's sun
// arc -- hour ticks on a faint track, a gradient "elapsed" stroke with a
// soft area wash beneath it, and a glowing "now" marker. On first data the
// marker sweeps in from sunrise; afterwards it glides continuously as the
// one-second ticks advance. At night the marker rides a dashed moon path
// below the horizon and the countdown flips to sunrise. Astral data still
// comes exclusively from the server (/api/sun); this module only renders it.

import { SUN_COUNTDOWN_TICK_MS } from './config.js';
import { fmtClock, fmtDuration } from './format.js';
import { fetchSunInfo } from './api.js';
import { svgEl } from './svg.js';
import { prefersReducedMotion } from './motion.js';

const el = id => document.getElementById(id);

const plot = el('sunArcPlot');
const card = el('sunArcCard');

// Geometry (viewBox units). The canvas reserves a slim band below the
// horizon for the moon path / ground glow so day and night share one
// composition without inflating the card's height.
const W = 240, H = 156;
const CX = 120, CY = 112, R = 92, RM = 36;

let sunTargetSunrise = null; // Date — next sunrise
let sunTargetSunset = null;  // Date — next sunset
let daySunrise = null;       // Date — today's actual window
let daySunset = null;
let sunIsNight = false;

// Built once, mutated per tick.
let els = null;

// Animated marker state: `angle` runs PI (sunrise / sunset end) -> 0.
let angle = null;
let animId = 0;
let lastMode = null; // flips at dawn/dusk to trigger the sweep-in

const polar = (r, a) => [CX + r * Math.cos(a), CY - r * Math.sin(a)];
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

function buildArc(){
  plot.replaceChildren();
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });

  // Gradients: elapsed stroke, area wash, ground glow, marker halo.
  const defs = svgEl('defs');
  const grad = (id, stops, attrs = {}) => {
    const g = svgEl('linearGradient', { id, ...attrs });
    for(const [off, color, op] of stops)
      g.appendChild(svgEl('stop', { offset: off, 'stop-color': color, 'stop-opacity': op }));
    defs.appendChild(g);
  };
  grad('sa-stroke', [[0, 'currentColor', 0.35], [1, 'currentColor', 1]]);
  grad('sa-wash', [[0, 'currentColor', 0.14], [1, 'currentColor', 0]],
    { x1: 0, y1: 0, x2: 0, y2: 1 });
  grad('sa-ground', [[0, 'currentColor', 0.10], [1, 'currentColor', 0]],
    { x1: 0, y1: 0, x2: 0, y2: 1 });
  // Halo is radial: bright core fading to nothing.
  const haloGrad = svgEl('radialGradient', { id: 'sa-halo' });
  for(const [off, op] of [[0, 0.5], [0.45, 0.18], [1, 0]])
    haloGrad.appendChild(svgEl('stop', { offset: off, 'stop-color': 'currentColor', 'stop-opacity': op }));
  defs.appendChild(haloGrad);
  svg.appendChild(defs);

  // Area wash under the elapsed portion (day only).
  const wash = svgEl('path', {
    d: '', fill: 'url(#sa-wash)', stroke: 'none', opacity: 0,
    class: 'sun-arc-wash',
  });

  // Ground glow hugging the horizon (day only).
  const ground = svgEl('rect', {
    x: CX - R, y: CY, width: R * 2, height: 20,
    fill: 'url(#sa-ground)', opacity: 0,
    class: 'sun-arc-ground',
  });

  // Faint full track + hour ticks (every 15 degrees, endpoints excluded).
  const [tx1, ty1] = polar(R, Math.PI);
  const [tx2, ty2] = polar(R, 0);
  const track = svgEl('path', {
    d: `M ${tx1} ${ty1} A ${R} ${R} 0 0 1 ${tx2} ${ty2}`,
    fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    opacity: 0.16, 'stroke-linecap': 'round',
  });
  const ticks = svgEl('g', { stroke: 'currentColor', 'stroke-width': 1, opacity: 0.28 });
  for(let i = 1; i < 12; i++){
    const a = Math.PI * (1 - i / 12);
    const [x1, y1] = polar(R - 3, a);
    const [x2, y2] = polar(R - 8, a);
    ticks.appendChild(svgEl('line', { x1, y1, x2, y2 }));
  }

  // Gradient elapsed stroke.
  const elapsed = svgEl('path', {
    d: '', fill: 'none', stroke: 'url(#sa-stroke)',
    'stroke-width': 3.5, 'stroke-linecap': 'round', opacity: 0,
  });

  // Dashed moon path below the horizon (night only).
  const moon = svgEl('path', {
    d: `M ${CX - RM} ${CY} A ${RM} ${RM} 0 0 0 ${CX + RM} ${CY}`,
    fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5,
    'stroke-dasharray': '1 6', 'stroke-linecap': 'round', opacity: 0,
    class: 'sun-arc-moon',
  });

  // Horizon: hairline fading at both ends + endpoint dots.
  const hGrad = svgEl('linearGradient', { id: 'sa-horizon', x1: 0, y1: 0, x2: 1, y2: 0 });
  for(const [off, op] of [[0, 0], [0.12, 0.5], [0.88, 0.5], [1, 0]])
    hGrad.appendChild(svgEl('stop', { offset: off, 'stop-color': 'currentColor', 'stop-opacity': op }));
  defs.appendChild(hGrad);
  const horizon = svgEl('line', {
    x1: CX - R - 10, y1: CY, x2: CX + R + 10, y2: CY,
    stroke: 'url(#sa-horizon)', 'stroke-width': 1,
  });
  const endDots = svgEl('g', { fill: 'currentColor', opacity: 0.55 });
  for(const a of [Math.PI, 0]){
    const [x, y] = polar(R, a);
    endDots.appendChild(svgEl('circle', { cx: x, cy: y, r: 2.2 }));
  }

  // "Now" marker: soft halo + solid disc (glow pulses via CSS).
  const halo = svgEl('circle', { r: 14, fill: 'url(#sa-halo)', class: 'sun-halo' });
  const disc = svgEl('circle', { r: 5.5, fill: 'currentColor' });
  const marker = svgEl('g', { class: 'sun-marker' }, [halo, disc]);

  svg.append(wash, ground, track, ticks, moon, elapsed, horizon, endDots, marker);
  plot.appendChild(svg);

  els = { wash, ground, elapsed, moon, marker };
}

// Render everything from a marker angle in [0, PI]. Day: the angle is the
// sun's position on the day arc. Night: same parameter drives the moon's
// progress along the below-horizon path (PI = just set, 0 = about to rise).
function draw(a){
  if(!els) return;
  const night = sunIsNight;
  els.moon.setAttribute('opacity', night ? 0.5 : 0);
  els.marker.classList.toggle('moon', night);

  if(night){
    els.wash.setAttribute('opacity', 0);
    els.ground.setAttribute('opacity', 0);
    els.elapsed.setAttribute('opacity', 0);
    const [x, y] = [CX + RM * Math.cos(a), CY + RM * Math.sin(a)];
    els.marker.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
    return;
  }

  els.ground.setAttribute('opacity', 1);
  const frac = 1 - a / Math.PI;
  const [mx, my] = polar(R, a);
  if(frac > 0.004){
    const d = `M ${CX - R} ${CY} A ${R} ${R} 0 0 1 ${mx.toFixed(2)} ${my.toFixed(2)}`;
    els.elapsed.setAttribute('d', d);
    els.elapsed.setAttribute('opacity', 1);
    els.wash.setAttribute('d', `${d} L ${mx.toFixed(2)} ${CY} Z`);
    els.wash.setAttribute('opacity', 1);
  }else{
    els.elapsed.setAttribute('d', '');
    els.elapsed.setAttribute('opacity', 0);
    els.wash.setAttribute('opacity', 0);
  }
  els.marker.setAttribute('transform', `translate(${mx.toFixed(2)} ${my.toFixed(2)})`);
}

// Tween the marker between angles. Per-second ticks use a linear 1s glide
// so motion is continuous; first data and dawn sweeps start from the
// sunrise end with an ease-out (dusk stays continuous: the moon picks up
// where the sun left off). Reduced motion snaps instantly.
function animateTo(target, dur, ease, startOverride){
  cancelAnimationFrame(animId);
  const from = startOverride ?? angle ?? Math.PI;
  angle = target;
  if(prefersReducedMotion() || from === target){
    draw(target);
    return;
  }
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / dur);
    draw(from + (target - from) * ease(p));
    if(p < 1) animId = requestAnimationFrame(step);
  };
  animId = requestAnimationFrame(step);
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
    const start = daySunset && daySunset < now ? daySunset : null;
    if(start && target > start) progress = (now - start) / (target - start);
  }else if(daySunrise && daySunset && daySunset > daySunrise){
    progress = (now - daySunrise) / (daySunset - daySunrise);
  }
  progress = Math.min(1, Math.max(0, progress));

  card.classList.toggle('night', sunIsNight);
  if(!els) buildArc();

  // Mode flip or first paint: sweep in. Dawn restarts from the sunrise
  // end; dusk lets the moon continue from the sun's last position.
  const mode = sunIsNight ? 'night' : 'day';
  const sweep = lastMode !== mode || angle === null;
  const sweepStart = sweep && !sunIsNight ? Math.PI : undefined;
  lastMode = mode;
  animateTo(Math.PI * (1 - progress), sweep ? 1400 : 1000,
    sweep ? easeOutCubic : t => t, sweepStart);

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
