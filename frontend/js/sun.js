// Sun path card: an instrument-grade SVG semicircle tracing today's sun
// arc -- hour ticks on a faint track, a gradient "elapsed" stroke, and a
// glowing "now" marker. The marker sweeps the SAME arc in both modes:
// clockwise by day (sunrise -> sunset), anti-clockwise by night (sunset
// -> sunrise), so dusk and dawn are continuous hand-offs. On first data
// it sweeps in from the sunrise end and then glides as the one-second
// ticks advance. Astral data comes exclusively from the server (/api/sun).

import { SUN_COUNTDOWN_TICK_MS } from './config.js';
import { fmtClock, fmtDuration } from './format.js';
import { fetchSunInfo } from './api.js';
import { svgEl } from './svg.js';
import { prefersReducedMotion, swapText } from './motion.js';

const el = id => document.getElementById(id);

const plot = el('sunArcPlot');
const card = el('sunArcCard');

// Geometry (viewBox units). One semicircle serves both modes: the marker
// sweeps it clockwise by day (sunrise -> sunset) and anti-clockwise by
// night (sunset -> back to sunrise along the same path). The arc spans
// nearly the full card width; the countdown/times text overlaps its lower
// interior via negative margins (see styles.css).
//
// The canvas cushions the arc by 44 units on every side so the pulsing
// "now" halo (r 17, scaled to 21.25 at peak) never clips the viewBox --
// not at the apex, not at the endpoints. That leaves ~22.75 clear units
// around the halo at full pulse on all four sides. styles.css widens
// .sun-arc-plot by the same 1.3x (275 -> 357.5px) so the rendered arc
// keeps its original pixel size, and re-tunes the overlap margins.
const W = 312, H = 200;
const CX = 156, CY = 156, R = 112;

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
const easeOutCubic = t => 1 - Math.pow(1 - t, 4);

function buildArc(){
  plot.replaceChildren();
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });

  // Gradients: elapsed stroke (light at sunrise -> full at the marker),
  // marker halo, whisper-faint interior tint.
  const defs = svgEl('defs');
  const grad = (id, stops, attrs = {}) => {
    const g = svgEl('linearGradient', { id, ...attrs });
    for(const [off, color, op] of stops)
      g.appendChild(svgEl('stop', { offset: off, 'stop-color': color, 'stop-opacity': op }));
    defs.appendChild(g);
  };
  grad('sa-stroke', [[0, 'currentColor', 0.45], [1, 'currentColor', 1]]);
  grad('sa-wash', [[0, 'currentColor', 0.06], [1, 'currentColor', 0]],
    { x1: 0, y1: 0, x2: 0, y2: 1 });
  const haloGrad = svgEl('radialGradient', { id: 'sa-halo' });
  for(const [off, op] of [[0, 0.5], [0.45, 0.18], [1, 0]])
    haloGrad.appendChild(svgEl('stop', { offset: off, 'stop-color': 'currentColor', 'stop-opacity': op }));
  defs.appendChild(haloGrad);
  svg.appendChild(defs);

  const [tx1, ty1] = polar(R, Math.PI);
  const [tx2, ty2] = polar(R, 0);

  // Interior tint (static, day only).
  const wash = svgEl('path', {
    d: `M ${tx1} ${ty1} A ${R} ${R} 0 0 1 ${tx2} ${ty2} Z`,
    fill: 'url(#sa-wash)', stroke: 'none', opacity: 0,
    class: 'sun-arc-wash',
  });

  // Thin remainder track + interior hour ticks.
  const track = svgEl('path', {
    d: `M ${tx1} ${ty1} A ${R} ${R} 0 0 1 ${tx2} ${ty2}`,
    fill: 'none', stroke: 'currentColor', 'stroke-width': 2,
    opacity: 0.3, 'stroke-linecap': 'round',
  });
  const ticks = svgEl('g', { stroke: 'currentColor', 'stroke-width': 1, opacity: 0.35 });
  for(let i = 1; i < 14; i++){
    const a = Math.PI * (1 - i / 14);
    const [x1, y1] = polar(R - 9, a);
    const [x2, y2] = polar(R - 17, a);
    ticks.appendChild(svgEl('line', { x1, y1, x2, y2 }));
  }

  // Thick gradient elapsed stroke.
  const elapsed = svgEl('path', {
    d: '', fill: 'none', stroke: 'url(#sa-stroke)',
    'stroke-width': 7, 'stroke-linecap': 'round', opacity: 0,
  });

  // Solid endpoint dots anchoring the arc ends.
  const endDots = svgEl('g', { fill: 'currentColor' });
  for(const a of [Math.PI, 0]){
    const [x, y] = polar(R, a);
    endDots.appendChild(svgEl('circle', { cx: x, cy: y, r: 4 }));
  }

  // "Now" marker: soft glow halo + a living sun/moon pair. The sun
  // (core + slowly turning rays) shows by day, the crescent moon by
  // night; CSS cross-fades/scales between them off .sun-marker.night.
  // An inner .sa-scale group breathes with solar elevation (see draw()).
  const halo = svgEl('circle', { r: 17, fill: 'url(#sa-halo)', class: 'sun-halo' });

  const core = svgEl('circle', { r: 6, fill: 'currentColor' });
  const rays = svgEl('g', { class: 'sa-rays' });
  for(let i = 0; i < 8; i++){
    const a = (Math.PI * i) / 4;
    const c = Math.cos(a), s = Math.sin(a);
    rays.appendChild(svgEl('line', {
      x1: (c * 8.5).toFixed(2), y1: (-s * 8.5).toFixed(2),
      x2: (c * 11.5).toFixed(2), y2: (-s * 11.5).toFixed(2),
      stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round',
    }));
  }
  const sunScale = svgEl('g', { class: 'sa-scale' }, [core, rays]);
  const sunG = svgEl('g', { class: 'sa-sun' }, [sunScale]);

  // Crescent reuses the instrument moon glyph, centered on the marker.
  const moonPath = svgEl('path', {
    d: 'M18.6 15.1A8.2 8.2 0 0 1 8.9 5.4a8.2 8.2 0 1 0 9.7 9.7z',
    fill: 'currentColor',
  });
  const moonG = svgEl('g', { class: 'sa-moon' }, [
    svgEl('g', { transform: 'translate(-10.8 -10.8) scale(0.9)' }, [moonPath]),
  ]);

  const marker = svgEl('g', { class: 'sun-marker' }, [halo, sunG, moonG]);

  svg.append(wash, track, ticks, elapsed, endDots, marker);
  plot.appendChild(svg);

  els = { wash, elapsed, marker };
}

// Render everything from a marker angle in [0, PI]. Day: the angle runs
// PI (sunrise) -> 0 (sunset), clockwise over the top. Night: the same
// angle runs 0 (sunset) -> PI (sunrise), anti-clockwise along the same
// arc -- one path, two directions.
function draw(a){
  if(!els) return;
  const night = sunIsNight;
  els.marker.classList.toggle('night', night);
  // Solar elevation breathes the sun's size: smallest at the horizon,
  // fullest at mid-arc. Night parks it at 1 (hidden anyway). Linear
  // 1s handoff matches the per-second tick glide; skipped for reduced
  // motion so the glyph stays a stable size.
  try{
    if(!prefersReducedMotion() && els.marker.style){
      const frac = Math.min(1, Math.max(0, 1 - a / Math.PI));
      const boost = night ? 1 : 0.85 + 0.25 * Math.sin(Math.PI * frac);
      els.marker.style.setProperty('--sa-s', boost.toFixed(3));
    }
  }catch(e){}

  if(night){
    els.wash.setAttribute('opacity', 0);
    // Night draws its own bold progress like day does: from the sunset
    // end (right) along the top to the moon. Mirrored sweep flag (0)
    // so the stroke travels over the arc, never underneath it.
    const frac = a / Math.PI;
    const [mx, my] = polar(R, a);
    if(frac > 0.004){
      els.elapsed.setAttribute('d',
        `M ${(CX + R).toFixed(2)} ${CY} A ${R} ${R} 0 0 0 ${mx.toFixed(2)} ${my.toFixed(2)}`);
      els.elapsed.setAttribute('opacity', 1);
    }else{
      els.elapsed.setAttribute('d', '');
      els.elapsed.setAttribute('opacity', 0);
    }
  }else{
    els.wash.setAttribute('opacity', 1);
    const frac = 1 - a / Math.PI;
    const [mx, my] = polar(R, a);
    if(frac > 0.004){
      els.elapsed.setAttribute('d',
        `M ${(CX - R).toFixed(2)} ${CY} A ${R} ${R} 0 0 1 ${mx.toFixed(2)} ${my.toFixed(2)}`);
      els.elapsed.setAttribute('opacity', 1);
    }else{
      els.elapsed.setAttribute('d', '');
      els.elapsed.setAttribute('opacity', 0);
    }
  }
  const [x, y] = polar(R, a);
  els.marker.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
}

// Tween the marker between angles. Per-second ticks use a linear 1s glide
// so motion is continuous; the first paint sweeps in from the sunrise end
// with an ease-out. Mode flips need no special casing -- day and night
// meet at the same arc ends. Reduced motion snaps instantly.
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

  swapText(el('sunNextSunrise'), fmtClock(sun.next_sunrise));
  swapText(el('sunNextSunset'), fmtClock(sun.next_sunset));
  swapText(el('sunCountdownLabel'), sunIsNight ? 'Time to sunrise' : 'Time to sunset');

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

  // Marker progress. Day: sunrise->sunset maps to angle PI->0 (clockwise).
  // Night: sunset->sunrise maps to angle 0->PI (anti-clockwise, same arc).
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

  // Mode flips are naturally continuous now (both meet at the arc ends):
  // only the first paint sweeps in, from the sunrise end.
  const mode = sunIsNight ? 'night' : 'day';
  const sweep = lastMode !== mode || angle === null;
  const sweepStart = angle === null ? Math.PI : undefined;
  lastMode = mode;
  animateTo(sunIsNight ? Math.PI * progress : Math.PI * (1 - progress),
    sweep ? 1400 : 1000,
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

export { updateSunInfo, refreshSunInfo, startSunTicker, tickSunCountdown };
