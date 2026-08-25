// SVG plumbing shared by all hand-rolled micro-visuals (sparklines, sun
// arc, gauge ring) plus the <symbol> sprite loader for the icon system.
// Dependency-free; every builder returns an SVG element ready to append.
// Icons live in index.html as 24px-grid <symbol>s with 1.5px strokes and
// are stamped out via <use> so each glyph is defined exactly once.

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, children = []){
  const node = document.createElementNS(SVG_NS, tag);
  for(const [k, v] of Object.entries(attrs)){
    if(v === null || v === undefined) continue;
    node.setAttribute(k, v);
  }
  for(const child of children) node.appendChild(child);
  return node;
}

// ---------- Icon sprite ----------

// Replace a container's contents with `<use>`-based icon markup:
//   setIcon(el, 'sunrise')            -> one icon filling the box
//   setIcon(el, 'sunrise', 'sunset')  -> several icons side by side
function setIcon(container, ...names){
  container.textContent = '';
  for(const name of names){
    const use = svgEl('use', { href: `#i-${name}` });
    const svg = svgEl('svg', {
      viewBox: '0 0 24 24',
      'aria-hidden': 'true',
      class: 'icon',
    }, [use]);
    container.appendChild(svg);
  }
  return container;
}

// ---------- Sparkline ----------
// Minimal line path sized to its viewBox with a fixed y-range so successive
// frames don't rescale as values arrive. Returns the <svg>.

function sparkline(values, {
  width = 120,
  height = 36,
  min = null,          // fixed domain; defaults to data extent
  max = null,
  strokeWidth = 1.5,
} = {}){
  const pts = values.filter(v => typeof v === 'number' && !Number.isNaN(v));
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    class: 'sparkline',
    'aria-hidden': 'true',
  });
  if(pts.length < 2) return svg;

  const lo = min ?? Math.min(...pts);
  const hi = max ?? Math.max(...pts);
  const span = hi - lo || 1;
  const pad = strokeWidth;
  const stepX = (width - pad * 2) / (pts.length - 1);
  const x = i => pad + i * stepX;
  const y = v => height - pad - ((v - lo) / span) * (height - pad * 2);

  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join('');
  svg.appendChild(svgEl('path', {
    d,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': strokeWidth,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }));
  return svg;
}

// ---------- Arc helpers (sun arc / gauge ring share these) ----------

// Polar -> cartesian on a circle centered in `size`, radius `r`.
function polar(cx, cy, r, angleRad){
  return [cx + r * Math.cos(angleRad), cy - r * Math.sin(angleRad)];
}

// Describe an arc path from angle a to b (radians, 0 = east, CCW positive).
// large-arc/sweep flags derived automatically for |b - a| <= pi.
function arcPath(cx, cy, r, a, b){
  const [x1, y1] = polar(cx, cy, r, a);
  const [x2, y2] = polar(cx, cy, r, b);
  const large = Math.abs(b - a) > Math.PI ? 1 : 0;
  // SVG arcs sweep clockwise; going CCW (b < a) flips the sweep flag.
  const sweep = b > a ? 0 : 1;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

// Sun arc: semicircle sunrise(east)->sunset(west) above the horizon.
// progress in [0,1] places the "now" marker along the path; when `night`
// is true a moon marker rides the same arc below the horizon instead.
function sunArc({
  size = 200,
  strokeWidth = 1.5,
  progress = 0,
  night = false,
} = {}){
  const cx = size / 2, cy = size * 0.82;
  const r = size / 2 - strokeWidth;
  // Horizon-left (180deg) to horizon-right (0deg), over the top.
  const track = arcPath(cx, cy, r, Math.PI, 0);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${size} ${size}`,
    class: 'sun-arc' + (night ? ' night' : ''),
    role: 'img',
  });

  svg.appendChild(svgEl('path', {
    d: track, fill: 'none', stroke: 'currentColor',
    'stroke-width': strokeWidth, opacity: 0.35,
    'stroke-linecap': 'round',
  }));

  // Horizon hairline
  svg.appendChild(svgEl('line', {
    x1: cx - r, y1: cy, x2: cx + r, y2: cy,
    stroke: 'currentColor', 'stroke-width': strokeWidth,
    opacity: 0.25, 'stroke-linecap': 'round',
  }));

  // Elapsed portion of the day path (day only)
  if(!night && progress > 0){
    svg.appendChild(svgEl('path', {
      d: arcPath(cx, cy, r, Math.PI, Math.PI * (1 - progress)),
      fill: 'none', stroke: 'currentColor',
      'stroke-width': strokeWidth * 1.6, 'stroke-linecap': 'round',
      class: 'sun-arc-elapsed',
    }));
  }

  // "Now" marker riding the arc (clamped to it)
  const angle = night
    ? Math.PI * (1 + Math.min(1, Math.max(0, progress)))   // below horizon
    : Math.PI * (1 - Math.min(1, Math.max(0, progress)));
  const [mx, my] = polar(cx, cy, night ? -r * 0.35 : r, angle);
  svg.appendChild(svgEl('circle', {
    cx: mx.toFixed(2), cy: my.toFixed(2),
    r: strokeWidth * 2.4, fill: 'currentColor',
    class: 'sun-arc-now',
  }));

  return svg;
}

export { svgEl, setIcon, sparkline, polar, arcPath, sunArc };
