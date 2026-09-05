// Chart.js setup and rendering for the Power Over Time chart, the Daily
// Energy Log bar chart, the Cumulative Energy line and the Monthly Energy
// bars (with year-over-year companions).
//
// Power Over Time renders four different views of the same underlying
// history, selected by range:
//
//   1h    recent rolling window on a real-time axis (high resolution)
//   today today's solar day: sunrise -> min(now, sunset), real-time axis,
//         plus the dashed "typical day" projection overlay + pace tag
//   7d    seven solar days concatenated left-to-right on a compressed
//         axis of 15-minute buckets -- nighttime has zero width
//   all   long-term average profile vs position within the solar day
//
// Solar-day boundaries come from the backend (same astral source of truth
// as night mode), so nighttime is treated as a session boundary rather than
// a data gap. Genuine communication gaps inside a session still break the
// line (GAP_THRESHOLD_MS).

import { GAP_THRESHOLD_MS, MAX_POINTS, TODAY_MAX_POINTS, WEATHER_REFRESH_MS } from './config.js';
import { state } from './state.js';
import { fmt } from './format.js';
import { fetchTodayProjection, fetchTomorrowForecast } from './api.js';
import { getDayWindow } from './sun.js';
import { prefersReducedMotion } from './motion.js';

const el = id => document.getElementById(id);

// Dataset entry animation for range switches: the live-append path always
// updates with 'none', but a fresh dataset glides in once with a soft
// quart ease — premium entry, instant live ticks.
function animatedUpdate(chart){
  const prev = chart.options.animation?.duration ?? 0;
  const prevEasing = chart.options.animation?.easing;
  if(!prefersReducedMotion()){
    chart.options.animation.duration = 550;
    chart.options.animation.easing = 'easeOutQuart';
  }
  chart.update();
  setTimeout(() => {
    chart.options.animation.duration = prev;
    if(prevEasing !== undefined) chart.options.animation.easing = prevEasing;
  }, 600);
}

// Honest durations for ambient charts: buttery on entry, silent when the
// user asked for reduced motion. Evaluated once at creation; the live
// power chart keeps duration 0 separately so WS ticks never jank.
function ambientAnim(ms = 450){
  if(prefersReducedMotion()) return { duration: 0 };
  return { duration: ms, easing: 'easeOutQuart' };
}

const SOLAR_RGB = '242,184,75';     // premium amber -- Solar Input
const INVERTER_RGB = '143,163,184'; // desaturated steel -- Inverter Power
const rgba = (rgb, a) => `rgba(${rgb},${a})`;

// Vertical alpha ramp behind filled areas (amber/steel family). Scriptable,
// so the gradient tracks the chart area through resizes and redraws.
function areaFill(rgb, top = 0.26){
  return ctx => {
    const area = ctx.chart.chartArea;
    if(!area) return rgba(rgb, top * 0.4);
    const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, rgba(rgb, top));
    g.addColorStop(1, rgba(rgb, 0.02));
    return g;
  };
}

// Active series colors; dark keeps the baseline constants, light swaps in
// deeper variants so lines/bars hold contrast on white surfaces. Re-pointed
// by applyChartTheme().
let solarRgb = SOLAR_RGB;
let inverterRgb = INVERTER_RGB;

// Chart palette per dashboard theme; matches styles.css variables.
const CHART_THEMES = {
  dark: {
    solarRgb: SOLAR_RGB,
    inverterRgb: INVERTER_RGB,
    text: '#a8b0bc',
    // rgb triplet of `text` above -- lets neutral series join rgba() alpha
    // blends (weather-impact "cloudy" class) without a new hue.
    textRgb: '168,176,188',
    grid: 'rgba(244,242,237,0.06)',
    axisTitle: '#6e7683',
    tooltipBg: '#181d26',
    tooltipBorder: 'rgba(255,255,255,0.15)',
    tooltipTitle: '#f4f2ed',
    tooltipBody: '#a8b0bc',
    dayLine: 'rgba(244,242,237,0.14)',
    dayLabel: '#a8b0bc',
  },
  light: {
    // Series match the CSS accents: bronze-amber solar, deep steel inverter
    // (kept cool on purpose against the warm paper surfaces).
    solarRgb: '180,83,9',
    inverterRgb: '79,107,132',
    text: '#5b544a',
    textRgb: '91,84,74',
    grid: 'rgba(25,21,17,0.08)',
    axisTitle: '#8c8478',
    tooltipBg: '#ffffff',
    tooltipBorder: '#cfc6b8',
    tooltipTitle: '#191511',
    tooltipBody: '#5b544a',
    dayLine: 'rgba(25,21,17,0.16)',
    dayLabel: '#5b544a',
  },
};

// Mutable so applyChartTheme() can re-point every consumer (renderers read
// them again per view rebuild; the plugin hooks read them per draw).
let themeColors = CHART_THEMES.dark;

// ---------- Chart.js defaults ----------
function setChartDefaults(c){
  Chart.defaults.color = c.text;
  Chart.defaults.font.family = "'Inter', ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, Menlo, monospace";
  Chart.defaults.font.size = 12;
  // One tooltip skin for every chart: quiet panel card with hairline border.
  Chart.defaults.plugins.tooltip.cornerRadius = 6;
  Chart.defaults.plugins.tooltip.titleMarginBottom = 8;
  Chart.defaults.plugins.tooltip.boxPadding = 4;
}
setChartDefaults(themeColors);

let powerMode = 'rolling';   // rolling | today | sessions | profile

// Today's solar window (Date objects) while in today mode; drives live appends.
let todayWindow = null;

// Sequential 7D view: subtle vertical separators + date labels at each
// solar-day boundary of the compressed timeline. Both hooks receive the
// chart instance from Chart.js and read per-render state attached to it
// ($sessionDayMarks) -- no closure over the module-level chart variable,
// so nothing here can run into initialization-order problems.
const sessionDayLines = {
  id: 'sessionDayLines',
  beforeDatasetsDraw(chart){
    const marks = chart.$sessionDayMarks;
    if(powerMode !== 'sessions' || !marks) return;
    const {ctx, chartArea} = chart;
    const xs = chart.scales.x;
    if(!xs) return;
    ctx.save();
    ctx.strokeStyle = themeColors.dayLine;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    for(const m of marks){
      const px = xs.getPixelForValue(m.x);
      if(px < chartArea.left - .5 || px > chartArea.right + .5) continue;
      ctx.beginPath();
      ctx.moveTo(px, chartArea.top);
      ctx.lineTo(px, chartArea.bottom);
      ctx.stroke();
    }
    ctx.restore();
  },
  afterDraw(chart){
    const marks = chart.$sessionDayMarks;
    if(powerMode !== 'sessions' || !marks) return;
    const {ctx, chartArea} = chart;
    const xs = chart.scales.x;
    if(!xs) return;
    ctx.save();
    ctx.fillStyle = themeColors.dayLabel;
    ctx.font = '10px ' + Chart.defaults.font.family;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for(const m of marks){
      // Keep labels inside the canvas even for the first/last boundary.
      const px = Math.max(chartArea.left + 20,
        Math.min(chartArea.right - 20, xs.getPixelForValue(m.x)));
      ctx.fillText(m.label, px, chartArea.bottom + 5);
    }
    ctx.restore();
  },
};

// ---------- Power Over Time chart ----------
const powerChart = new Chart(el('powerChart').getContext('2d'), {
  type: 'line',
  data: { datasets: [] },
  plugins: [sessionDayLines],
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 }, // avoid jank on frequent live updates
    // Per-view interaction is applied by each renderer (setInteraction).
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top',
        align: 'end',
        labels: {
          boxWidth: 10, boxHeight: 10, usePointStyle: true,
          pointStyle: 'circle', padding: 14,
          // In sessions/profile modes every dataset pair shares the two
          // metric colors; show just one legend entry per metric. Chart.js
          // supplies the chart instance -- never close over `powerChart`
          // here, since this runs inside its own constructor.
          generateLabels: (chart) => powerLegendEntries(chart),
        },
        onClick: (e, item, chart) => {
          // Metric-only legend entries (profile view) aren't clickable.
          if(powerMode === 'profile') return;
          if(item.datasetIndex < 0) return;
          const i = item.datasetIndex;
          if(chart.isDatasetVisible(i)) chart.hide(i); else chart.show(i);
        },
      },
      tooltip: {
        backgroundColor: '#191c20',
        borderColor: '#34383f',
        borderWidth: 1,
        titleColor: '#e9e7e2',
        bodyColor: '#9aa1a9',
        padding: 10,
      }
    },
    scales: {
      x: timeAxisConfig({ unit: 'minute', stepSize: 5, tooltipFormat: 'HH:mm:ss' }),
      y: {
        beginAtZero: true,
        grace: '8%',
        border: { display: false },
        grid: { color: themeColors.grid, drawTicks: false },
        title: { display: true, text: 'Watts', color: themeColors.axisTitle, font:{size:10} },
      }
    }
  }
});

const chartMsgEl = el('chartMsg');
function setChartMsg(text){
  chartMsgEl.textContent = text || '';
  chartMsgEl.classList.toggle('show', !!text);
}

// Same overlay pattern for the other chart holders (empty/error states).
function holderMsg(id, text){
  const node = el(id);
  if(!node) return;
  node.textContent = text || '';
  node.classList.toggle('show', !!text);
}

// ---------- Axis / legend / tooltip helpers ----------
function timeAxisConfig({ unit, stepSize, tooltipFormat, min, max } = {}){
  return {
    type: 'time',
    min: min ?? undefined,
    max: max ?? undefined,
    time: { unit, stepSize, tooltipFormat },
    grid: { color: themeColors.grid, drawTicks: false },
    ticks: { maxRotation: 0, autoSkipPadding: 20 },
  };
}

function solarClock(seconds){
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

// The "solar clock": linear axis of time-since-sunrise shared by the 7D
// and All views so nighttime consumes no horizontal space.
function solarAxisConfig(maxSeconds){
  return {
    type: 'linear',
    min: 0,
    max: Math.max(3600, Math.ceil((maxSeconds || 12 * 3600) / 3600) * 3600),
    grid: { color: themeColors.grid, drawTicks: false },
    ticks: {
      maxRotation: 0,
      stepSize: 2 * 3600,
      callback: v => '+' + solarClock(v),
    },
    title: { display: true, text: 'time after sunrise', color: themeColors.axisTitle, font:{size:10} },
  };
}

function fmtSolarOffset(seconds){
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if(m) return `+${h}h ${String(m).padStart(2,'0')}m`;
  return `+${h}h`;
}

function setTooltipCallbacks(callbacks){
  powerChart.options.plugins.tooltip.callbacks = callbacks;
}

// Real-time axes show both metrics at the hovered timestamp (index);
// solar-clock views align the per-day datasets by nearest x instead.
function setInteraction(view){
  powerChart.options.interaction = view === 'realtime'
    ? { mode: 'index', intersect: false }
    : { mode: 'nearest', axis: 'x', intersect: false };
}

// Legend items. Chart.js's label drawing uses ONLY the item's `fontColor`
// (no fallback to the chart's default text color), so it must be set
// explicitly -- otherwise legend text inherits whatever dark fillStyle is
// left on the canvas context. We reuse Chart.defaults.color, the same gray
// used by every other label on the dashboard. Font family, size and spacing
function powerLegendEntries(chart){
  const fontColor = Chart.defaults.color;
  if(powerMode === 'profile'){
    return [
      { text: 'Solar Input (W)', fillStyle: rgba(solarRgb, 1), strokeStyle: rgba(solarRgb, 1),
        lineWidth: 2, lineDash: [], pointStyle: 'circle', fontColor, datasetIndex: -1 },
      { text: 'Inverter Power (W)', fillStyle: rgba(inverterRgb, 1), strokeStyle: rgba(inverterRgb, 1),
        lineWidth: 2, lineDash: [], pointStyle: 'circle', fontColor, datasetIndex: -1 },
    ];
  }
  return chart.data.datasets.map((ds, i) => ({
    text: ds.label,
    fillStyle: ds.borderColor,
    strokeStyle: ds.borderColor,
    lineWidth: ds.borderWidth,
    lineDash: ds.borderDash || [],
    pointStyle: 'circle',
    fontColor,
    hidden: !chart.isDatasetVisible(i),
    datasetIndex: i,
  }));
}

// ---------- Dataset builders ----------
function lineDataset({ label, data, rgb, alpha = 1, fill = false }){
  return {
    label,
    data,
    borderColor: rgba(rgb, alpha),
    backgroundColor: fill ? areaFill(rgb) : 'transparent',
    borderWidth: 1.8,
    pointRadius: 0,
    pointHoverRadius: 4,
    fill,
    tension: 0.25,
    spanGaps: false,
  };
}

function emptyMetricDatasets(){
  return [
    lineDataset({ label: 'Solar Input (W)', data: [], rgb: solarRgb, fill: true }),
    lineDataset({ label: 'Inverter Power (W)', data: [], rgb: inverterRgb }),
  ];
}

// ---------- Gap handling (real-time axes) ----------
// Insert a null point when the gap between consecutive samples exceeds
// GAP_THRESHOLD_MS, so Chart.js (spanGaps:false) breaks the line instead of
// drawing a misleading straight segment across it.
function toPointArrays(readings){
  const solar = [], power = [];
  let prevT = null;
  for(const r of readings){
    const t = new Date(r.timestamp);
    if(prevT !== null && (t - prevT) > GAP_THRESHOLD_MS){
      // gap marker: a null-valued point right after the last known sample
      const gapT = new Date(prevT.getTime() + 1000);
      solar.push({x: gapT, y: null});
      power.push({x: gapT, y: null});
    }
    solar.push({x: t, y: r.solar_input});
    power.push({x: t, y: r.inverter_power});
    prevT = t;
  }
  return {solar, power};
}

// Same idea for solar-clock points whose x is seconds-after-sunrise.
// (Retained for potential reuse by normalized views.)

function fmtDayLabel(dateStr){
  const d = new Date(dateStr + 'T00:00:00');
  return isNaN(d) ? dateStr : d.toLocaleDateString([], {month:'short', day:'numeric'});
}

// ---------- View: 1H rolling ----------
function renderRolling(readings){
  powerMode = 'rolling';
  todayWindow = null;
  setChartMsg(readings.length ? null : 'No recent data');
  powerChart.options.layout = {}; // 7D leaves extra bottom padding; undo it
  const {solar, power} = toPointArrays(readings);
  powerChart.data.datasets = [
    lineDataset({ label: 'Solar Input (W)', data: solar, rgb: solarRgb, fill: true }),
    lineDataset({ label: 'Inverter Power (W)', data: power, rgb: inverterRgb }),
  ];
  powerChart.options.scales.x = timeAxisConfig({
    unit: 'minute', stepSize: 5, tooltipFormat: 'HH:mm:ss'
  });
  setInteraction('realtime');
  setTooltipCallbacks({});
  animatedUpdate(powerChart);
}

// ---------- View: Today (current solar day) ----------
function renderToday(readings, sunInfo){
  powerMode = 'today';
  const now = new Date();
  const sunrise = sunInfo ? new Date(sunInfo.sunrise) : null;
  const sunset = sunInfo ? new Date(sunInfo.sunset) : null;

  // Case A -- before sunrise: no production exists yet. Never fall back to
  // yesterday's data; show tonight's upcoming window as an empty night state.
  if(sunrise && now < sunrise){
    todayWindow = null;
    powerChart.options.layout = {};
    powerChart.data.datasets = emptyMetricDatasets();
    powerChart.options.scales.x = timeAxisConfig({
      unit: 'hour', stepSize: 1, tooltipFormat: 'HH:mm', min: sunrise, max: sunset,
    });
    setInteraction('realtime');
    setTooltipCallbacks({});
    const clock = sunrise.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    setChartMsg(`Night — today's solar session begins at ${clock}`);
    animatedUpdate(powerChart);
    return;
  }

  // Cases B/C -- clamp the right edge at sunset once it has passed.
  const end = sunset ? new Date(Math.min(now.getTime(), sunset.getTime())) : now;
  todayWindow = {sunrise, sunset};

  const scoped = sunrise
    ? readings.filter(r => {
        const t = new Date(r.timestamp);
        return t >= sunrise && t <= end;
      })
    : readings;

  const {solar, power} = toPointArrays(scoped);
  powerChart.options.layout = {};
  powerChart.data.datasets = [
    lineDataset({ label: 'Solar Input (W)', data: solar, rgb: solarRgb, fill: true }),
    lineDataset({ label: 'Inverter Power (W)', data: power, rgb: inverterRgb }),
  ];
  // Dashed long-term-average reference behind the actual day (index 2 so the
  // live-append code can keep assuming datasets [0]/[1] are the metrics).
  applyTodayOverlay();
  powerChart.options.scales.x = timeAxisConfig({
    unit: 'hour', stepSize: 1, tooltipFormat: 'HH:mm:ss', min: sunrise ?? undefined, max: end,
  });
  setInteraction('realtime');
  setTooltipCallbacks({
    filter: item => !(item.dataset && item.dataset.isTypical),
  });
  // Case D -- correct daylight axis, simply no readings yet today.
  setChartMsg(scoped.length ? null : 'No readings yet today');
  animatedUpdate(powerChart);
}

// ---------- Today's projected finish (typical-day overlay + pace tag) ----------
// /api/today/projection returns the long-term average-day curve (avg AC
// watts vs seconds-after-sunrise, server-integrated) plus live/typical kWh
// totals. The dashed overlay is mapped onto the wall-clock axis as
// sunrise + o; the pace tag re-projects client-side on every WS reading by
// integrating that same fetched curve -- no refetch per tick.
//
// Degradation: fewer than 3 days of history means nothing is "typical" yet
// -> no overlay, and the pace line states today's known total instead; night
// reports the finished day; the first half hour after sunrise states today
// without pacing (too little signal); after sunset the line freezes at the
// day's actual finish vs the typical total. A power cut legitimately reads
// as a low pace -- the line's tooltip says so.
const TYPICAL_ALPHA = 0.45;          // existing series color at reduced alpha
const PACE_WARMUP_SECONDS = 30 * 60; // state (don't pace) right after sunrise

let todayProjection = null;   // last /api/today/projection payload
let projReqId = 0;            // guards against stale responses on fast toggles

// Tomorrow estimate for the night pace line (same payload as the weather
// popup + glance sub-line). Lazily refreshed at night; the backend caches
// for 1h so refetching per night is cheap.
let tomorrowForPace = null;
let tomorrowForPaceAt = 0;
let tomorrowPaceFetching = false;
const TOMORROW_PACE_TTL_MS = WEATHER_REFRESH_MS;

function projectionUsable(){
  return !!todayProjection
    && todayProjection.day_count >= 3
    && Array.isArray(todayProjection.curve)
    && todayProjection.curve.length >= 2;
}

function typicalDataset(){
  const sunriseMs = Date.parse(todayWindow.sunrise);
  return {
    label: 'Typical day',
    isTypical: true,
    data: todayProjection.curve.map(p => ({
      x: new Date(sunriseMs + p.o * 1000), y: p.w,
    })),
    borderColor: rgba(solarRgb, TYPICAL_ALPHA),
    borderWidth: 1.5,
    borderDash: [6, 5],
    pointRadius: 0,
    pointHoverRadius: 0,
    fill: false,
    tension: 0.25,
  };
}

// Adds/removes the dashed dataset for the current view. Called from
// renderToday (payload may already be in memory) and after each fetch.
function applyTodayOverlay(){
  const datasets = powerChart.data.datasets.filter(ds => !ds.isTypical);
  if(powerMode === 'today' && todayWindow?.sunrise && projectionUsable()){
    datasets.push(typicalDataset());
  }
  powerChart.data.datasets = datasets;
}

async function loadTodayProjection(){
  const reqId = ++projReqId;
  try{
    const payload = await fetchTodayProjection();
    // Range-independent: the payload describes today, and the glance pace
    // line needs it in every chart range (the overlay itself still only
    // renders in the today view).
    if(reqId !== projReqId) return;
    todayProjection = (payload && !payload.error) ? payload : null;
    applyTodayOverlay();
    powerChart.update('none');
    updatePaceTag();
  }catch(e){
    console.error('Failed to load today projection', e);
  }
}

// Cumulative typical energy [W·s] from sunrise up to offset `limitSec`,
// mirroring the server: piecewise-linear through the curve points, zero
// outside them. One pass over ~50 points per call.
function cumulativeTypicalWs(limitSec){
  const c = todayProjection.curve;
  let cum = 0, prevO = c[0].o, prevW = c[0].w;
  if(limitSec <= prevO) return 0;
  for(let i = 1; i < c.length; i++){
    const o = c[i].o, w = c[i].w;
    if(o >= limitSec){
      const f = (limitSec - prevO) / (o - prevO);
      const wl = prevW + f * (w - prevW);
      return cum + (prevW + wl) * 0.5 * (limitSec - prevO);
    }
    cum += (prevW + w) * 0.5 * (o - prevO);
    prevO = o; prevW = w;
  }
  return cum;
}

// W·s -> kWh (J/3600 = Wh, /1000 = kWh).
const WS_TO_KWH = 1 / 3600000;

// Pace line in the glance card: always visible. Daytime paces today's yield
// against the long-term typical day ("ON PACE FOR X KWH · TYPICAL Y KWH");
// at night the slot carries tomorrow's expectation instead
// ("TOMORROW ≈ X KWH (TYPICAL Y, CLOUDY Z%)", falling back to the finished
// day only while the forecast is still loading or unavailable); with no
// usable history it still
// states today's known total. The slim pace bar
// under the line fills today/typical. Recomputed on every live reading
// (`eTodayKwh`), falling back to the payload's own current_kwh otherwise.
function updatePaceTag(eTodayKwh){
  const tag = el('paceTag');
  const fill = el('paceFill');
  const show = (text, title, frac) => {
    tag.hidden = false;
    tag.textContent = text;
    if(title !== undefined) tag.title = title;
    if(fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, frac || 0)) * 100)}%`;
  };

  const raw = (eTodayKwh ?? eTodayKwh === 0)
    ? Number(eTodayKwh)
    : (projectionUsable() ? todayProjection.current_kwh : null);
  const kwh = (raw === null || raw === undefined || Number.isNaN(Number(raw)))
    ? null : Number(raw);
  const typRaw = projectionUsable() ? todayProjection.typical_total_kwh : null;
  const typical = (typRaw === null || typRaw === undefined || Number.isNaN(Number(typRaw)))
    ? null : Number(typRaw);

  // No history yet: state today's known total (or wait honestly).
  if(typical === null){
    if(kwh === null) return show('Today – · typical – kWh', 'Collecting history — averages appear after a few days.', 0);
    return show(`Today ${fmt(kwh, 1)} kWh`, 'Today’s yield so far. The typical-day comparison appears after a few days of history.', 0);
  }
  const typ = fmt(typical, 1);

  // Night: the pace slot carries tomorrow's expectation instead of the
  // finished day (also shown in the weather popup on demand).
  if(state.nightMode){
    const t = tomorrowForPace;
    const tok = t && t.expected_kwh !== null && t.expected_kwh !== undefined
      && t.typical_kwh !== null && t.typical_kwh !== undefined
      && (t.day_count ?? 0) >= 3;
    if(tok){
      const exp = fmt(Number(t.expected_kwh), 1);
      const ttyp = fmt(Number(t.typical_kwh), 1);
      const cloud = (t.cloud_pct !== null && t.cloud_pct !== undefined)
        ? `, cloudy ${Math.round(t.cloud_pct)}%` : '';
      return show(`Tomorrow ≈ ${exp} kWh (typical ${ttyp}${cloud})`,
        `Expected tomorrow from daylight-cloud derate of your typical day. Provider: ${t.provider || '–'}. Estimated, not metered.`,
        typical && kwh !== null ? kwh / typical : 0);
    }
    if(!tomorrowPaceFetching && Date.now() - tomorrowForPaceAt > TOMORROW_PACE_TTL_MS){
      tomorrowPaceFetching = true;
      fetchTomorrowForecast().then(p => {
        tomorrowForPace = p;
        tomorrowForPaceAt = Date.now();
      }).catch(() => {}).finally(() => {
        tomorrowPaceFetching = false;
        if(state.nightMode) updatePaceTag();
      });
    }
    if(kwh === null) return show(`Night · typical ${typ} kWh`, 'Inverter asleep. Typical yield for an average day.', 0);
    return show(`Night · today ${fmt(kwh, 1)} · typical ${typ} kWh`,
      'How today finished against your long-term average day. Resumes at sunrise.',
      typical ? kwh / typical : 0);
  }

  // Pace needs today's solar window. The chart only provides it in the
  // today view, so other ranges fall back to the sun module's window
  // (same server source of truth, refreshed on its own schedule).
  const win = (todayWindow?.sunrise && todayWindow?.sunset)
    ? todayWindow : getDayWindow();
  if(!win.sunrise || !win.sunset || kwh === null){
    return show(`Today ${kwh === null ? '–' : fmt(kwh, 1)} · typical ${typ} kWh`,
      'Today’s yield against your long-term average day.',
      typical && kwh !== null ? kwh / typical : 0);
  }

  const sunriseMs = new Date(win.sunrise).getTime();
  const sunsetMs = new Date(win.sunset).getTime();
  if(!isFinite(sunriseMs) || !isFinite(sunsetMs)){
    return show(`Today ${fmt(kwh, 1)} · typical ${typ} kWh`,
      'Today’s yield against your long-term average day.', typical ? kwh / typical : 0);
  }

  const offSec = (Date.now() - sunriseMs) / 1000;
  const spanSec = (sunsetMs - sunriseMs) / 1000;

  if(offSec >= spanSec){
    // Sunset passed: freeze at the actual final vs the typical day.
    return show(`Final ${fmt(kwh, 1)} · typical ${typ} kWh`,
      'How today actually finished against your long-term average day.',
      typical ? kwh / typical : 0);
  }
  // First ~30 minutes: too little evidence to pace against — state today.
  if(offSec < PACE_WARMUP_SECONDS){
    return show(`Today ${fmt(kwh, 1)} · typical ${typ} kWh`,
      'Early in the solar day — pacing starts after the first ~30 minutes.',
      typical ? kwh / typical : 0);
  }

  const remainingKwh =
    (cumulativeTypicalWs(Infinity) - cumulativeTypicalWs(offSec)) * WS_TO_KWH;
  return show(`On pace for ${fmt(kwh + remainingKwh, 1)} kWh · typical ${typ} kWh`,
    'Projected final yield if the rest of the day follows your long-term ' +
    'average day. Compared to your long-term average day — a power cut ' +
    'earlier today legitimately lowers it.',
    typical ? kwh / typical : 0);
}

// ---------- View: 7D (sequential compressed solar-day timeline) ----------
//
// The seven solar days are concatenated left-to-right into one continuous
// production timeline. Each day occupies ceil(daylight/15min)+1 columns:
// its sunrise zero point followed by one column per 15-minute bucket.
// Nighttime has zero horizontal width; the sunset zero of one day and the
// sunrise marker of the next share a single column. Missing buckets are
// explicit nulls so spanGaps:false breaks the line -- a data gap is never
// drawn as (or bridged through) zero.
function renderSessions(sessions){
  powerMode = 'sessions';
  todayWindow = null;
  // Days without any daylight window yet (today before sunrise) are omitted
  // rather than fabricated as empty sessions.
  const usable = sessions.filter(s => s.slots > 0);

  if(!usable.length){
    powerChart.$sessionDayMarks = null;
    powerChart.data.datasets = emptyMetricDatasets();
    powerChart.options.layout = {padding: {bottom: 18}};
    const emptyAxis = solarAxisConfig(12 * 3600);
    emptyAxis.ticks.display = false;
    powerChart.options.scales.x = emptyAxis;
    setInteraction('realtime');
    setTooltipCallbacks({});
    setChartMsg('No daylight readings in this period');
    animatedUpdate(powerChart);
    return;
  }
  setChartMsg(null);

  const solarData = [], invData = [];
  const dayMarks = [];
  let x = 0;

  usable.forEach((sess) => {
    const startX = x;
    const binSec = sess.bin_seconds;
    const riseMs = Date.parse(sess.sunrise);
    const bySlot = new Map();
    for(const b of sess.buckets) bySlot.set(Math.round(b.o / binSec), b);

    dayMarks.push({x: startX, label: fmtDayLabel(sess.date)});
    for(let k = 0; k < sess.slots; k++){
      const px = startX + 1 + k;
      const b = bySlot.get(k);
      if(b){
        // Tooltip metadata carries the real bucket-midpoint wall-clock time;
        // it cannot be recovered from the compressed visual x alone.
        const meta = {d: sess.date, ts: riseMs + (k + .5) * binSec * 1000, off: k * binSec};
        solarData.push({x: px, y: b.s, ...meta});
        invData.push({x: px, y: b.i, ...meta});
      } else {
        // Missing evidence -> explicit line break, not a zero.
        solarData.push({x: px, y: null});
        invData.push({x: px, y: null});
      }
    }
    if(sess.complete){
      // Sunset terminator: an intentional zero. The next day's sunrise
      // marker shares this exact column -- nighttime gets zero width.
      const zMeta = {d: sess.date, ts: riseMs + sess.slots * binSec * 1000, off: sess.slots * binSec};
      solarData.push({x: startX + sess.slots + 1, y: 0, ...zMeta});
      invData.push({x: startX + sess.slots + 1, y: 0});
      x = startX + sess.slots + 1;
    } else {
      // In-progress current day: the curve simply stops at the last slot.
      x = startX + sess.slots;
    }
  });

  powerChart.$sessionDayMarks = dayMarks;
  powerChart.data.datasets = [
    lineDataset({label: 'Solar Input (W)', data: solarData, rgb: solarRgb, fill: true}),
    lineDataset({label: 'Inverter Power (W)', data: invData, rgb: inverterRgb}),
  ];
  powerChart.options.layout = {padding: {bottom: 18}}; // room for date labels
  const xAxis = solarAxisConfig(0);
  // Column units, not seconds -- do not round the max up to whole hours.
  xAxis.min = 0;
  xAxis.max = x + 1;
  // Numeric ticks are meaningless here; the sessionDayLines plugin draws
  // the date labels, which also make clear the distance is not wall-clock.
  xAxis.title.display = false;
  xAxis.ticks.display = false;
  powerChart.options.scales.x = xAxis;
  setInteraction('realtime'); // both metrics align on shared columns now
  setTooltipCallbacks({
    title: items => {
      const p = items[0]?.raw;
      if(!p || !p.d) return '';
      return `${p.d} · ${new Date(p.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}`;
    },
    label: item => {
      const p = item.raw;
      if(!p || p.y === null) return '';
      return ` ${item.dataset.metric ?? item.dataset.label}: ${fmt(p.y, 0)} W`;
    },
    afterBody: items => {
      const p = items[0]?.raw;
      return p && p.off !== undefined ? [`${fmtSolarOffset(p.off)} after sunrise`] : [];
    },
  });
  animatedUpdate(powerChart);
}

// ---------- View: All (long-term normalized profile) ----------
function renderProfile(profile){
  powerMode = 'profile';
  todayWindow = null;
  const bins = profile.bins || [];

  if(!bins.length){
    powerChart.data.datasets = emptyMetricDatasets();
    powerChart.options.scales.x = solarAxisConfig(12 * 3600);
    setInteraction('solar');
    setTooltipCallbacks({});
    setChartMsg('Not enough history yet');
    animatedUpdate(powerChart);
    return;
  }
  setChartMsg(null);

  // Bins with zero samples stay empty (spanGaps:false breaks the line) --
  // missing data must not read as a smooth curve.
  const solarData = bins.map(b => ({x: b.o, y: b.s_avg, n: b.n}));
  const invData = bins.map(b => ({x: b.o, y: b.i_avg, n: b.n}));

  powerChart.data.datasets = [
    (() => {
      const ds = lineDataset({
        label: `Solar Input — avg over ${profile.day_count} days`,
        data: solarData, rgb: solarRgb, fill: true,
      });
      ds.metric = 'Solar Input';
      return ds;
    })(),
    (() => {
      const ds = lineDataset({
        label: 'Inverter Power — avg',
        data: invData, rgb: inverterRgb,
      });
      ds.metric = 'Inverter Power';
      return ds;
    })(),
  ];
  powerChart.options.scales.x = solarAxisConfig(bins[bins.length - 1].o);
  powerChart.options.layout = {}; // keep the All view's geometry unchanged
  setInteraction('solar');
  setTooltipCallbacks({
    title: items => {
      const p = items[0]?.raw;
      return p ? `${fmtSolarOffset(p.x)} after sunrise` : '';
    },
    label: item => ` ${item.dataset.metric} avg: ${fmt(item.raw.y, 0)} W`,
    afterBody: items => {
      const p = items[0]?.raw;
      return p ? [`from ${p.n} day-sample${p.n === 1 ? '' : 's'}`] : [];
    },
  });
  animatedUpdate(powerChart);
}

// ---------- Entry point ----------
// `sunInfo` is present for range=today ({sunrise, sunset}); other ranges
// ignore it.
function renderHistory(readings, sunInfo){
  if(state.range === 'today'){
    renderToday(readings, sunInfo);
  } else {
    renderRolling(readings);
  }
}

// ---------- Live point appending ----------
function appendLivePoint(reading){
  // Normalized views are rebuilt from the API on range switch / reload;
  // blind appends would corrupt their solar-clock x positions.
  if(state.range === '7d' || state.range === 'all') return;

  const t = new Date(reading.timestamp);
  const solarDs = powerChart.data.datasets[0].data;
  const powerDs = powerChart.data.datasets[1].data;

  if(state.range === 'today'){
    // Only append within today's solar window; keep the axis clamped to
    // min(now, sunset).
    if(!todayWindow || !todayWindow.sunrise) return;
    const {sunrise, sunset} = todayWindow;
    if(t < sunrise || t > sunset) return;
    powerChart.options.scales.x.max = sunset < t ? sunset : t;
  }

  // Detect gap since the last plotted point (e.g. after reconnect)
  if(solarDs.length){
    const prev = solarDs[solarDs.length - 1];
    if(prev?.x && (t - new Date(prev.x)) > GAP_THRESHOLD_MS){
      const gapT = new Date(new Date(prev.x).getTime() + 1000);
      solarDs.push({x: gapT, y: null});
      powerDs.push({x: gapT, y: null});
    }
  }

  solarDs.push({x: t, y: reading.Solar_Input});
  powerDs.push({x: t, y: reading.Inverter_Power});

  // Trim policies -- neither session may grow unbounded, but they are NOT
  // the same shape:
  //   - '1h' is a sliding window: oldest points leave as newest arrive.
  //   - 'today' is a bounded solar-day session (sunrise -> sunset), NOT
  //     sliding. Capping it erases the early morning one point per tick once
  //     the day's sample count crosses any fixed limit (guaranteed on pages
  //     opened in the afternoon), so its memory is bounded structurally:
  //     appends stop at sunset (guarded above) and stale points from before
  //     the current sunrise (e.g. a tail left over a midnight rollover) are
  //     purged by timestamp. TODAY_MAX_POINTS only acts as a failsafe.
  if(state.range === 'today'){
    const srMs = todayWindow?.sunrise ? Date.parse(todayWindow.sunrise) : NaN;
    if(isFinite(srMs)){
      let stale = 0;
      while(stale < solarDs.length &&
            new Date(solarDs[stale].x).getTime() < srMs){ stale++; }
      if(stale > 0){
        solarDs.splice(0, stale);
        powerDs.splice(0, stale);
      }
    }
    while(solarDs.length > TODAY_MAX_POINTS){
      solarDs.shift();
      powerDs.shift();
    }
  } else {
    const maxPoints = MAX_POINTS[state.range] || 3000;
    while(solarDs.length > maxPoints){ solarDs.shift(); powerDs.shift(); }
  }

  powerChart.update('none'); // no animation -> smooth, no flicker
}

// ---------- Daily Energy Log (per-day bars for one selected month) ----------
// The full day series (/api/daily-summary, ordered ascending) arrives in one
// fetch; the month select slices it client-side -- the same pattern the
// Cumulative chart uses with its range toggle. Rendering every stored day at
// once turned the axis into clutter after the first year, so the chart shows
// at most ~31 bars: every day of the selected month, newest month by
// default. The selection survives refetches while its month still has data.
let dailyDays = [];
let dailyMonth = null;

const dailyChart = new Chart(el('dailyChart').getContext('2d'), {
  type: 'bar',
  data: {
    labels: [],
    datasets: [{
      label: 'Energy (kWh)',
      data: [],
      backgroundColor: rgba(solarRgb, 0.8),
      borderRadius: 3,
      maxBarThickness: 26,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: ambientAnim(),
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          title: items => fmtDayLabel(items[0]?.label ?? ''),
          label: item => ` ${fmt(item.parsed.y, 1)} kWh`,
        }
      }
    },
    scales: {
      // Labels stay full YYYY-MM-DD (tooltips resolve them); the axis only
      // prints the day number so 31 bars fit without rotation.
      x: {
        grid: { display:false },
        ticks: {
          maxRotation: 0, minRotation: 0, autoSkip: true, maxTicksLimit: 15,
          callback(v){ const l = this.getLabelForValue(v); return typeof l === 'string' ? l.slice(8) : l; },
        },
      },
      y: { beginAtZero: true, grid: { color: themeColors.grid }, title:{display:true,text:'kWh',color:themeColors.axisTitle,font:{size:10}} }
    }
  }
});

// Months present in the stored series, ascending ('YYYY-MM').
function dailyMonthOptions(){
  const months = new Set(dailyDays.map(d => String(d.day).slice(0, 7)));
  return [...months].sort();
}

function syncDailyMonthSelect(months){
  const select = el('dailyMonth');
  if(!select) return;
  const current = select.value;
  select.textContent = '';
  for(const m of [...months].reverse()){
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = fmtMonthYear(m);
    select.appendChild(opt);
  }
  if(months.includes(current)) select.value = current;
  else if(dailyMonth && months.includes(dailyMonth)) select.value = dailyMonth;
}

function renderDailyMonth(){
  const months = dailyMonthOptions();
  syncDailyMonthSelect(months);
  const tag = el('dailyMonthTag');
  if(!months.length){
    dailyMonth = null;
    holderMsg('dailyChartMsg', 'No data yet');
    dailyChart.data.labels = [];
    dailyChart.data.datasets[0].data = [];
    dailyChart.update();
    if(tag) tag.hidden = true;
    return;
  }
  if(!dailyMonth || !months.includes(dailyMonth)) dailyMonth = months[months.length - 1];
  const select = el('dailyMonth');
  if(select) select.value = dailyMonth;
  const sliced = dailyDays.filter(d => String(d.day).slice(0, 7) === dailyMonth);
  holderMsg('dailyChartMsg', sliced.length ? null : 'No data yet');
  dailyChart.data.labels = sliced.map(d => d.day);
  dailyChart.data.datasets[0].data = sliced.map(d => d.energy_kwh);
  dailyChart.update();
  if(tag){
    const total = sliced.reduce((sum, d) => sum + (Number(d.energy_kwh) || 0), 0);
    tag.hidden = false;
    tag.textContent = `${fmtMonthLong(dailyMonth)} · ${fmt(total, 1)} kWh`;
  }
}

function renderDailySummary(days){
  if(days) dailyDays = days;
  renderDailyMonth();
}

function setDailyMonth(month){
  if(!dailyMonthOptions().includes(month)) return;
  dailyMonth = month;
  renderDailyMonth();
}

// ---------- Cumulative Energy (running total of daily kWh) ----------
// Reuses the same aggregated per-day series as the Daily Energy Log
// (/api/daily-summary, ordered ascending); the running total is computed
// client-side -- one pass over at most a few hundred points.
const CUMULATIVE_RANGE_DAYS = { '30d': 30, '90d': 90 };
let cumulativeRange = 'all';
let latestDailyDays = [];

const cumulativeChart = new Chart(el('cumulativeChart').getContext('2d'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [{
      label: 'Cumulative Energy (kWh)',
      data: [],
      borderColor: rgba(solarRgb, 0.9),
      backgroundColor: areaFill(solarRgb, 0.22),
      borderWidth: 1.8,
      pointRadius: 0,
      pointHoverRadius: 4,
      fill: true,
      tension: 0.25,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: ambientAnim(),
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#191c20',
        borderColor: '#34383f',
        borderWidth: 1,
        titleColor: '#e9e7e2',
        bodyColor: '#9aa1a9',
        padding: 10,
        callbacks: {
          title: items => fmtDayLabel(items[0]?.label ?? ''),
          label: item => {
            const day = item.raw?.dayKwh;
            return ` Total: ${fmt(item.parsed.y, 1)} kWh` +
              (day !== undefined ? ` (+${fmt(day, 1)} that day)` : '');
          },
        }
      }
    },
    scales: {
      x: { grid: { display:false }, ticks: { maxRotation: 45, minRotation: 0 } },
      y: { beginAtZero: true, grid: { color: themeColors.grid },
           title:{display:true,text:'Cumulative kWh',color:themeColors.axisTitle,font:{size:10}} }
    }
  }
});

function renderCumulative(days){
  if(days) latestDailyDays = days;
  const sliced = cumulativeRange === 'all'
    ? latestDailyDays
    : latestDailyDays.slice(-CUMULATIVE_RANGE_DAYS[cumulativeRange]);

  holderMsg('cumulativeChartMsg', sliced.length ? null : 'No data yet');

  let total = 0;
  const points = sliced.map(d => {
    total += d.energy_kwh || 0;
    return { x: d.day, y: total, dayKwh: d.energy_kwh };
  });

  cumulativeChart.data.labels = sliced.map(d => d.day);
  cumulativeChart.data.datasets[0].data = points;
  cumulativeChart.update();
}

function setCumulativeRange(range){
  if(!(range === 'all' || CUMULATIVE_RANGE_DAYS[range])) return;
  cumulativeRange = range;
  renderCumulative();
}

// ---------- Monthly Energy (per-month totals + year-over-year) ----------
// Consumes /api/generation/monthly, whose months are bucketed server-side
// from the exact same day series as the Daily Energy Log -- so a month's
// bar always equals the sum of that month's daily-log bars. The full series
// is fetched once and sliced client-side per toggle (12/24/All), the same
// pattern the Cumulative chart uses with the daily summary.
//
// Year-over-year rendering unlocks at >= 13 months of history
// (payload.yoy_available): every month gains a "same month last year"
// companion bar (existing steel series color, never a new hue) and a delta
// tag in the panel head. Before that, a muted tag says what's missing and
// the plain monthly bars work from day one.
const MONTHLY_RANGES = { '12': 12, '24': 24 };
// A past month counts as "partial data" when fewer than this fraction of
// its calendar days actually reported; the in-progress month is never
// called partial -- it is labeled "in progress" instead.
const MONTHLY_PARTIAL_FRACTION = 0.75;

let monthlyRange = '12';
let latestMonthly = null;
let monthlyByMonth = null;   // month -> {kwh, days, prevKwh} for tooltips/tag

const monthlyChart = new Chart(el('monthlyChart').getContext('2d'), {
  type: 'bar',
  data: {
    labels: [],
    datasets: [{
      label: 'Month total',
      data: [],
      backgroundColor: rgba(solarRgb, 0.8),
      borderRadius: 3,
      maxBarThickness: 26,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: ambientAnim(),
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: false,
        position: 'top',
        align: 'end',
        labels: {
          boxWidth: 10, boxHeight: 10, usePointStyle: true,
          pointStyle: 'circle', padding: 14,
        },
      },
      tooltip: {
        backgroundColor: '#191c20',
        borderColor: '#34383f',
        borderWidth: 1,
        titleColor: '#e9e7e2',
        bodyColor: '#9aa1a9',
        padding: 10,
        callbacks: {
          title: items => fmtMonthLong(items[0]?.label ?? ''),
          label: item => {
            const v = item.parsed.y;
            if(v === null || v === undefined) return '';
            if(item.datasetIndex === 0) return ` ${fmt(v, 1)} kWh`;
            return ` ${fmtMonthYear(shiftMonthKey(item.label, -12))}: ${fmt(v, 1)} kWh`;
          },
          afterBody: items => monthlyTooltipNotes(items[0]?.label),
        }
      }
    },
    scales: {
      x: {
        grid: { display:false },
        ticks: {
          maxRotation: 45, minRotation: 0,
          callback(value){ return fmtMonthShort(this.getLabelForValue(value)); },
        }
      },
      y: { beginAtZero: true, grid: { color: themeColors.grid },
           title:{display:true,text:'kWh',color:themeColors.axisTitle,font:{size:10}} }
    }
  }
});

const monthlyMsgEl = el('monthlyChartMsg');
function setMonthlyMsg(text){
  monthlyMsgEl.textContent = text || '';
  monthlyMsgEl.classList.toggle('show', !!text);
}

function shiftMonthKey(ym, delta){
  const year = Number(ym.slice(0, 4)), mon = Number(ym.slice(5, 7));
  const idx = year * 12 + (mon - 1) + delta;
  return `${Math.floor(idx / 12)}`.padStart(4, '0') +
         `-` + String(idx % 12 + 1).padStart(2, '0');
}

function currentMonthKey(){
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Days the month could have reported so far: elapsed days for the
// in-progress month, calendar length otherwise. Day keys are UTC dates
// (same assumption as the backend's bucketing).
function expectedDayCount(ym){
  const year = Number(ym.slice(0, 4)), mon = Number(ym.slice(5, 7));
  if(!year || !mon) return null;
  if(ym === currentMonthKey()) return new Date().getUTCDate();
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}

function fmtMonthLong(ym){
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1);
  return isNaN(d) ? ym : d.toLocaleDateString([], {month:'long', year:'numeric'});
}

function fmtMonthYear(ym){
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1);
  return isNaN(d) ? ym : d.toLocaleDateString([], {month:'short', year:'numeric'});
}

function fmtMonthShort(ym){
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1);
  return isNaN(d) ? ym : d.toLocaleDateString([], {month:'short', year:'2-digit'});
}

function monthlyTooltipNotes(ym){
  const ctx = monthlyByMonth?.get(ym);
  if(!ctx) return [];
  const notes = [];
  if(ctx.prevKwh !== null && ctx.prevKwh > 0){
    const pct = Math.round((ctx.kwh - ctx.prevKwh) / ctx.prevKwh * 100);
    notes.push(`${pct >= 0 ? '+' : ''}${pct}% vs same month last year`);
  }
  const expected = expectedDayCount(ym);
  if(expected !== null){
    if(ym === currentMonthKey()){
      notes.push(`month in progress · ${ctx.days}/${expected} days`);
    }else if(ctx.days < Math.ceil(expected * MONTHLY_PARTIAL_FRACTION)){
      notes.push(`partial data · ${ctx.days}/${expected} days`);
    }
  }
  return notes;
}

function updateMonthlyYoYTag(byMonth, months){
  const tag = el('monthlyYoYTag');
  if(!months.length || !(latestMonthly?.yoy_available)){
    // No comparison possible yet: say so once there is something to compare
    // later; stay silent on a completely empty dashboard.
    if(months.length){
      tag.hidden = false;
      tag.textContent = 'YoY needs more history';
      tag.title = 'The year-over-year comparison appears once 13 months of history exist.';
    }else{
      tag.hidden = true;
    }
    return;
  }
  // Headline delta = newest COMPLETE month with a previous-year twin.
  // The in-progress month would compare a partial total against a full one.
  const curKey = currentMonthKey();
  let best = null;
  for(const m of months){
    if(m.month === curKey) continue;
    const prevKwh = byMonth.get(m.month)?.prevKwh;
    if(prevKwh === null || prevKwh === undefined) continue;
    best = {month: m.month, kwh: m.kwh, prevKwh};
  }
  if(!best || best.prevKwh <= 0){ tag.hidden = true; return; }
  const pct = Math.round((best.kwh - best.prevKwh) / best.prevKwh * 100);
  tag.hidden = false;
  const sign = pct >= 0 ? '+' : '';
  const prevKey = shiftMonthKey(best.month, -12);
  tag.textContent =
    `${fmtMonthShort(best.month)} ${sign}${pct}% vs \u2019${prevKey.slice(2, 4)}`;
  tag.title = `${fmtMonthLong(best.month)}: ${fmt(best.kwh, 1)} kWh vs ` +
    `${fmtMonthYear(prevKey)}: ${fmt(best.prevKwh, 1)} kWh`;
}

// Rebuilds labels/datasets/tag/message from latestMonthly + monthlyRange.
// No update() call -- callers decide animation (data refresh vs theme flip).
function rebuildMonthly(){
  const months = latestMonthly?.months || [];

  if(!months.length){
    monthlyChart.data.labels = [];
    monthlyChart.data.datasets = [{
      label: 'Month total', data: [],
      backgroundColor: rgba(solarRgb, 0.8),
      borderRadius: 3, maxBarThickness: 26,
    }];
    monthlyChart.options.plugins.legend.display = false;
    el('monthlyYoYTag').hidden = true;
    setMonthlyMsg(latestMonthly ? 'No monthly data yet' : '');
    return;
  }

  const kwhByMonth = new Map(months.map(m => [m.month, m.kwh]));
  monthlyByMonth = new Map();
  for(const m of months){
    const prevKwh = kwhByMonth.get(shiftMonthKey(m.month, -12));
    monthlyByMonth.set(m.month, {kwh: m.kwh, days: m.days_with_data, prevKwh: prevKwh ?? null});
  }

  const windowSize = MONTHLY_RANGES[monthlyRange];
  const shown = windowSize ? months.slice(-windowSize) : months;

  // Incomplete current month: reduced fill alpha only -- never a new hue.
  const curKey = currentMonthKey();
  const mainColors = shown.map(m =>
    m.month === curKey ? rgba(solarRgb, 0.35) : rgba(solarRgb, 0.8));

  const datasets = [{
    label: 'Month total',
    data: shown.map(m => m.kwh),
    backgroundColor: mainColors,
    borderRadius: 3,
    maxBarThickness: 26,
  }];

  let hasPrevBars = false;
  if(latestMonthly.yoy_available){
    const prevData = shown.map(m => {
      const v = monthlyByMonth.get(m.month)?.prevKwh;
      if(v !== null) hasPrevBars = true;
      return v;
    });
    if(hasPrevBars){
      datasets.push({
        label: 'Same month last year',
        data: prevData,
        backgroundColor: rgba(inverterRgb, 0.5),
        borderRadius: 3,
        maxBarThickness: 26,
      });
    }
  }

  monthlyChart.data.labels = shown.map(m => m.month);
  monthlyChart.data.datasets = datasets;
  monthlyChart.options.plugins.legend.display = hasPrevBars;
  updateMonthlyYoYTag(monthlyByMonth, months);
  setMonthlyMsg(null);
}

function renderMonthly(payload){
  if(!payload || payload.error) return;
  latestMonthly = payload;
  rebuildMonthly();
  monthlyChart.update();
}

function setMonthlyRange(range){
  if(!(range === 'all' || MONTHLY_RANGES[range])) return;
  monthlyRange = range;
  rebuildMonthly();
  monthlyChart.update();
}

// ---------- Temperature (sidebar mini chart) ----------
// Consumes /api/insights/temperature: daylight-only aggregates computed
// server-side over the raw window. One small chart, two lenses selected by
// the panel-head toggle:
//   tod -> avg/max internal temperature vs seconds-after-sunrise bins
//          (same solar-clock shape as the All profile view)
//   out -> per DC-input band: energy-weighted efficiency % (right axis,
//          drawn in the theme's neutral text tone -- never a new accent)
//          next to temperature (left axis, amber -- the same color the
//          metric wears in the time view, so one idea keeps one hue)
// All colors register through themeColors/rgba exactly like the other
// charts; applyChartTheme() re-points them on toggle.
let tempView = 'tod';        // 'tod' (vs time of day) | 'out' (vs output)
let latestTemperature = null;

const tempChart = new Chart(el('tempChart').getContext('2d'), {
  type: 'line',
  data: { datasets: [] },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: ambientAnim(),
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: {
        display: false,
        position: 'top',
        align: 'end',
        labels: {
          boxWidth: 10, boxHeight: 10, usePointStyle: true,
          pointStyle: 'circle', padding: 14,
        },
      },
      tooltip: {
        backgroundColor: '#191c20',
        borderColor: '#34383f',
        borderWidth: 1,
        titleColor: '#e9e7e2',
        bodyColor: '#9aa1a9',
        padding: 10,
      }
    },
    scales: {
      x: { type: 'linear', grid: { color: themeColors.grid, drawTicks: false } },
      y: { grid: { color: themeColors.grid, drawTicks: false } },
    }
  }
});

const tempMsgEl = el('tempChartMsg');
function setTempMsg(text){
  tempMsgEl.textContent = text || '';
  tempMsgEl.classList.toggle('show', !!text);
}

function rebuildTemperature(){
  const tod = latestTemperature?.by_time_of_day ?? [];
  const bands = latestTemperature?.by_output ?? [];
  const bw = latestTemperature?.band_watts || 100;

  let datasets, scales, callbacks, legendDisplay;

  if(tempView === 'out'){
    const pts = bands.map(b => ({
      x: b.band_w, y: b.temp_avg, mx: b.temp_max, n: b.n,
    }));
    const effPts = bands
      .filter(b => b.eff !== null && b.eff !== undefined)
      .map(b => ({ x: b.band_w, y: b.eff * 100, n: b.n }));

    datasets = [
      {
        label: 'Temperature (°C)',
        isTempSeries: true,
        data: pts,
        yAxisID: 'y',
        borderColor: rgba(solarRgb, 0.9),
        backgroundColor: rgba(solarRgb, 0.08),
        borderWidth: 1.8,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.25,
        spanGaps: false,
        fill: true,
      },
      {
        label: 'Efficiency (%)',
        isEffSeries: true,
        data: effPts,
        yAxisID: 'yEff',
        borderColor: themeColors.text,
        backgroundColor: 'transparent',
        borderWidth: 1.8,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.25,
        spanGaps: false,
        fill: false,
      },
    ];
    scales = {
      x: {
        type: 'linear',
        min: 0,
        max: bands.length ? bands[bands.length - 1].band_w + bw : undefined,
        grid: { color: themeColors.grid, drawTicks: false },
        ticks: {
          maxRotation: 0, autoSkipPadding: 20,
          callback: v => (v >= 1000 ? `${v / 1000}k` : v),
        },
        title: { display: true, text: 'DC input (W)', color: themeColors.axisTitle, font:{size:10} },
      },
      y: {
        beginAtZero: false,
        grace: '12%',
        grid: { color: themeColors.grid, drawTicks: false },
        title: { display: true, text: '°C', color: themeColors.axisTitle, font:{size:10} },
      },
      yEff: {
        position: 'right',
        beginAtZero: false,
        grace: '12%',
        grid: { display: false }, // keep the left axis' grid only
        title: { display: true, text: 'efficiency', color: themeColors.axisTitle, font:{size:10} },
        ticks: { callback: v => `${Math.round(v)}%` },
      },
    };
    callbacks = {
      title: items => {
        const p = items[0]?.raw;
        return p ? `DC input ${p.x}–${p.x + bw} W` : '';
      },
      label: item => {
        const p = item.raw;
        if(item.dataset.isEffSeries) return ` eff ≈ ${fmt(p.y, 1)}%`;
        return ` ${fmt(p.y, 1)}°C avg · ${fmt(p.mx, 1)}°C max`;
      },
      afterBody: items => {
        const p = items[0]?.raw;
        return p && p.n ? [`from ${p.n} sample${p.n === 1 ? '' : 's'}`] : [];
      },
    };
    legendDisplay = true;
  } else {
    // Time-of-day lens: single amber series on the shared solar clock.
    datasets = [
      {
        label: 'Temperature (°C)',
        isTempSeries: true,
        data: tod.map(b => ({ x: b.o, y: b.temp_avg, mx: b.temp_max, n: b.n })),
        yAxisID: 'y',
        borderColor: rgba(solarRgb, 0.9),
        backgroundColor: rgba(solarRgb, 0.08),
        borderWidth: 1.8,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.25,
        spanGaps: false,
        fill: true,
      },
    ];
    scales = {
      x: solarAxisConfig(tod.length ? tod[tod.length - 1].o : 12 * 3600),
      y: {
        beginAtZero: false,
        grace: '12%',
        grid: { color: themeColors.grid, drawTicks: false },
        title: { display: true, text: '°C', color: themeColors.axisTitle, font:{size:10} },
      },
    };
    callbacks = {
      title: items => {
        const p = items[0]?.raw;
        return p ? `${fmtSolarOffset(p.x)} after sunrise` : '';
      },
      label: item => {
        const p = item.raw;
        return p.y === null || p.y === undefined
          ? ''
          : ` ${fmt(p.y, 1)}°C avg · ${fmt(p.mx, 1)}°C max`;
      },
      afterBody: items => {
        const p = items[0]?.raw;
        return p && p.n ? [`from ${p.n} sample${p.n === 1 ? '' : 's'}`] : [];
      },
    };
    legendDisplay = false;
  }

  tempChart.data.datasets = datasets;
  tempChart.options.scales = scales;
  tempChart.options.plugins.legend.display = legendDisplay;
  Object.assign(tempChart.options.plugins.tooltip, { callbacks });

  // Honest empty state: a single bin can't draw a trend (points are
  // radius-0), so anything below two bins/bands reports as collecting-data
  // even though the stat rows above may already carry real numbers.
  const drawable = tempView === 'out'
    ? bands.length >= 2
    : tod.length >= 2;
  setTempMsg(
    latestTemperature ? (drawable ? null : 'Not enough data yet') : ''
  );
}

function renderTemperature(payload){
  if(!payload || payload.error) return;
  latestTemperature = payload;
  if(tempView !== 'tod' && tempView !== 'out') tempView = 'tod';
  rebuildTemperature();
  tempChart.update();
}

// Switch lenses using the already-fetched payload -- no refetch.
function setTemperatureView(view){
  if(view !== 'tod' && view !== 'out') return;
  tempView = view;
  if(!latestTemperature) return; // first load renders in this view directly
  rebuildTemperature();
  tempChart.update();
}

// ---------- Weather Impact (production vs historical cloud cover) ----------
// Consumes /api/weather/correlation: one point per matched day (daily kWh vs
// that day's archived mean cloud cover), or per-class averages in the bucket
// lens. The scatter/buckets toggle rebuilds the single canvas by view
// (scatter and bar controllers can't share one instance), which also keeps
// theme flips trivial: every rebuild reads the live theme colors.
//
// Class colors come from the existing palette only -- amber accent for
// "clear" (the sun), the steel series color for "partly", the theme's
// neutral text tone for "cloudy". No new hue; everything re-themes via
// applyChartTheme() like every other chart.
let weatherView = 'scatter';   // 'scatter' (each matched day) | 'buckets' (class averages)
let latestWeatherCorrelation = null;
let weatherChart = null;

const weatherMsgEl = el('weatherChartMsg');
function setWeatherMsg(text){
  weatherMsgEl.textContent = text || '';
  weatherMsgEl.classList.toggle('show', !!text);
}

function weatherClassRgb(key){
  if(key === 'clear') return solarRgb;
  if(key === 'partly') return inverterRgb;
  return themeColors.textRgb;
}

const WEATHER_CLASSES = [
  { key: 'clear',  label: 'Clear',  range: '<25%' },
  { key: 'partly', label: 'Partly', range: '25–60%' },
  { key: 'cloudy', label: 'Cloudy', range: '>60%' },
];

function buildWeatherChart(){
  if(weatherChart){
    weatherChart.destroy();
    weatherChart = null;
  }
  const tooltip = {
    backgroundColor: themeColors.tooltipBg,
    borderColor: themeColors.tooltipBorder,
    borderWidth: 1,
    titleColor: themeColors.tooltipTitle,
    bodyColor: themeColors.tooltipBody,
    padding: 10,
  };

  let config;
  if(weatherView === 'buckets'){
    const buckets = latestWeatherCorrelation?.classes ?? {};
    config = {
      type: 'bar',
      data: {
        labels: WEATHER_CLASSES.map(c => c.label),
        datasets: [{
          label: 'Average energy',
          data: WEATHER_CLASSES.map(c => buckets[c.key]?.avg_kwh ?? null),
          backgroundColor: WEATHER_CLASSES.map(c => rgba(weatherClassRgb(c.key), 0.8)),
          borderRadius: 3,
          maxBarThickness: 40,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: ambientAnim(),
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltip,
            callbacks: {
              title: items => {
                const c = WEATHER_CLASSES[items[0]?.dataIndex];
                return c ? `${c.label} days (${c.range} cloud)` : '';
              },
              label: item => {
                const v = item.parsed.y;
                if(v === null || v === undefined) return '';
                return ` avg ${fmt(v, 1)} kWh`;
              },
              afterBody: items => {
                const b = buckets[WEATHER_CLASSES[items[0]?.dataIndex]?.key];
                if(!b || !b.days) return [];
                return [`over ${b.days} matched day${b.days === 1 ? '' : 's'}`,
                        `best ${fmt(b.best_day?.kwh, 1)} · worst ${fmt(b.worst_day?.kwh, 1)} kWh`];
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0 } },
          y: { beginAtZero: true, grace: '8%', border: { display: false },
               grid: { color: themeColors.grid, drawTicks: false },
               title: { display: true, text: 'kWh', color: themeColors.axisTitle, font:{size:10} } },
        },
      },
    };
  } else {
    const points = latestWeatherCorrelation?.points ?? [];
    // Per-point class colors (thresholds applied server-side): translucent
    // fills over slightly stronger rims.
    const fills = [], rims = [];
    for(const p of points){
      const key = p.cls === 'clear' || p.cls === 'partly' ? p.cls : 'cloudy';
      fills.push(rgba(weatherClassRgb(key), 0.45));
      rims.push(rgba(weatherClassRgb(key), 0.85));
    }
    config = {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Matched days',
          data: points.map(p => ({ x: p.cloud, y: p.kwh, date: p.date, rain: p.rain })),
          pointBackgroundColor: fills,
          pointBorderColor: rims,
          pointBorderWidth: 1,
          pointRadius: 3.2,
          pointHoverRadius: 5,
          showLine: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: ambientAnim(),
        interaction: { mode: 'nearest', intersect: true },
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltip,
            callbacks: {
              title: items => items[0]?.raw?.date ?? '',
              label: item => {
                const p = item.raw;
                return ` ${fmt(p.y, 1)} kWh at ${fmt(p.x, 0)}% cloud`;
              },
              afterBody: items => {
                const p = items[0]?.raw;
                if(!p) return [];
                return p.rain !== null && p.rain !== undefined
                  ? [`${fmt(p.rain, 1)} mm rain`]
                  : [];
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear', min: 0, max: 100,
            grid: { color: themeColors.grid, drawTicks: false },
            ticks: { maxRotation: 0, autoSkipPadding: 20, callback: v => `${v}%` },
            border: { display: false },
            title: { display: true, text: 'mean cloud cover', color: themeColors.axisTitle, font:{size:10} },
          },
          y: {
            beginAtZero: true, grace: '8%', border: { display: false },
            grid: { color: themeColors.grid, drawTicks: false },
            title: { display: true, text: 'kWh', color: themeColors.axisTitle, font:{size:10} },
          },
        },
      },
    };
  }

  weatherChart = new Chart(el('weatherChart').getContext('2d'), config);
}

function rebuildWeather(){
  const payload = latestWeatherCorrelation;
  setWeatherMsg(
    payload ? (payload.matched_days ? null : 'waiting for archived weather…') : ''
  );
  if(payload && payload.matched_days) buildWeatherChart();
  else if(weatherChart){ weatherChart.destroy(); weatherChart = null; }
}

function renderWeatherImpact(payload){
  if(!payload || payload.error) return;
  latestWeatherCorrelation = payload;
  if(weatherView !== 'scatter' && weatherView !== 'buckets') weatherView = 'scatter';
  rebuildWeather();
}

// Lens toggle using the already-fetched payload -- no refetch.
function setWeatherView(view){
  if(view !== 'scatter' && view !== 'buckets') return;
  weatherView = view;
  if(!latestWeatherCorrelation) return; // first load renders in this view directly
  rebuildWeather();
}

// ---------- Theme switching ----------
// Re-points every hardcoded canvas color and refreshes the live chart
// instances so grids/axes/ticks/tooltips/legends follow the dashboard
// theme immediately.
function applyChartTheme(themeName){
  const c = CHART_THEMES[themeName] ?? CHART_THEMES.dark;
  themeColors = c;
  solarRgb = c.solarRgb;
  inverterRgb = c.inverterRgb;
  setChartDefaults(c);

  const tooltip = {
    backgroundColor: c.tooltipBg,
    borderColor: c.tooltipBorder,
    borderWidth: 1,
    titleColor: c.tooltipTitle,
    bodyColor: c.tooltipBody,
    padding: 10,
  };
  // Spread keeps each chart's existing callbacks (power's are swapped per
  // view; cumulative and monthly own fixed ones). Weather may not exist yet
  // (built lazily once archived weather arrives).
  Object.assign(powerChart.options.plugins.tooltip, tooltip);
  Object.assign(dailyChart.options.plugins.tooltip, tooltip);
  Object.assign(cumulativeChart.options.plugins.tooltip, tooltip);
  Object.assign(monthlyChart.options.plugins.tooltip, tooltip);
  Object.assign(tempChart.options.plugins.tooltip, tooltip);
  if(weatherChart) Object.assign(weatherChart.options.plugins.tooltip, tooltip);

  // Series colors live on the datasets; re-point them so bars/lines/fills
  // follow the theme without waiting for the next data render.
  dailyChart.data.datasets[0].backgroundColor = rgba(solarRgb, 0.8);
  cumulativeChart.data.datasets[0].borderColor = rgba(solarRgb, 0.9);
  cumulativeChart.data.datasets[0].backgroundColor = areaFill(solarRgb, 0.22);
  // Power lines bake their rgb at build time (including the gradient fill,
  // which closes over it), so re-point them by metric: profile tags it,
  // other views match by label. The dashed projection line derives from
  // the live solar rgb too.
  for(const ds of powerChart.data.datasets){
    if(ds.isTypical){
      ds.borderColor = rgba(solarRgb, TYPICAL_ALPHA);
      continue;
    }
    const isSolar = ds.metric
      ? ds.metric === 'Solar Input'
      : /solar/i.test(ds.label || '');
    const rgb = isSolar ? solarRgb : inverterRgb;
    ds.borderColor = rgba(rgb, 1);
    if(ds.fill) ds.backgroundColor = areaFill(rgb);
  }
  // Monthly's per-bar alphas derive from the live rgb values, so rebuild.
  if(latestMonthly) rebuildMonthly();
  // Temperature's series colors are embedded at rebuild time as well.
  if(latestTemperature) rebuildTemperature();
  // Weather's class colors likewise (the chart instance is rebuilt per view).
  if(latestWeatherCorrelation) rebuildWeather();

  for(const chart of [powerChart, dailyChart, cumulativeChart, monthlyChart, tempChart]){
    for(const scale of Object.values(chart.options.scales)){
      if(scale.grid) scale.grid.color = c.grid;
      if(scale.title?.color) scale.title.color = c.axisTitle;
      // Tick labels resolve Chart.defaults.color once at creation, so a
      // later setChartDefaults() never reaches live instances — re-point
      // them here like grid/title (display:false scales are unaffected).
      if(scale.ticks) scale.ticks.color = c.text;
      if(scale.border) scale.border.display = false;
    }
    // Plain update(), not update('none'): Chart.js only commits element
    // recolors through its animation loop, so 'none' repaints geometry but
    // leaves stale bar/line colors on screen until the next hover. The
    // ambient 450ms morph reads as an intentional theme transition (and
    // stays instant for reduced-motion users, whose creation duration is 0).
    chart.update();
  }
}

export {
  renderHistory, renderSessions, renderProfile, appendLivePoint,
  renderDailySummary, setDailyMonth, dailyMonthOptions,
  renderCumulative, setCumulativeRange,
  renderMonthly, setMonthlyRange, applyChartTheme,
  loadTodayProjection, updatePaceTag,
  renderTemperature, setTemperatureView,
  renderWeatherImpact, setWeatherView };
