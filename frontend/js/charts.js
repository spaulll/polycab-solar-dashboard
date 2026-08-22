// Chart.js setup and rendering for the Power Over Time chart and the Daily
// Energy Log bar chart.
//
// Power Over Time renders four different views of the same underlying
// history, selected by range:
//
//   1h    recent rolling window on a real-time axis (high resolution)
//   today today's solar day: sunrise -> min(now, sunset), real-time axis
//   7d    seven solar days concatenated left-to-right on a compressed
//         axis of 15-minute buckets -- nighttime has zero width
//   all   long-term average profile vs position within the solar day
//
// Solar-day boundaries come from the backend (same astral source of truth
// as night mode), so nighttime is treated as a session boundary rather than
// a data gap. Genuine communication gaps inside a session still break the
// line (GAP_THRESHOLD_MS).

import { GAP_THRESHOLD_MS, MAX_POINTS } from './config.js';
import { state } from './state.js';
import { fmt } from './format.js';

const el = id => document.getElementById(id);

const SOLAR_RGB = '245,166,35';     // amber -- Solar Input
const INVERTER_RGB = '91,155,213';  // blue  -- Inverter Power
const rgba = (rgb, a) => `rgba(${rgb},${a})`;

// ---------- Chart.js defaults (dark theme) ----------
Chart.defaults.color = '#8a9098';
Chart.defaults.font.family = "'SF Mono', Consolas, Menlo, ui-monospace, monospace";
Chart.defaults.font.size = 11;

const gridColor = 'rgba(255,255,255,0.05)';

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
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
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
    ctx.fillStyle = '#8a9098';
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
        backgroundColor: '#14171a',
        borderColor: '#23282d',
        borderWidth: 1,
        titleColor: '#e8e6e1',
        bodyColor: '#c8ccd0',
        padding: 10,
      }
    },
    scales: {
      x: timeAxisConfig({ unit: 'minute', stepSize: 5, tooltipFormat: 'HH:mm:ss' }),
      y: {
        beginAtZero: true,
        grace: '8%',
        grid: { color: gridColor, drawTicks: false },
        title: { display: true, text: 'Watts', color:'#565d64', font:{size:10} },
      }
    }
  }
});

const chartMsgEl = el('chartMsg');
function setChartMsg(text){
  chartMsgEl.textContent = text || '';
  chartMsgEl.classList.toggle('show', !!text);
}

// ---------- Axis / legend / tooltip helpers ----------
function timeAxisConfig({ unit, stepSize, tooltipFormat, min, max } = {}){
  return {
    type: 'time',
    min: min ?? undefined,
    max: max ?? undefined,
    time: { unit, stepSize, tooltipFormat },
    grid: { color: gridColor, drawTicks: false },
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
    grid: { color: gridColor, drawTicks: false },
    ticks: {
      maxRotation: 0,
      stepSize: 2 * 3600,
      callback: v => '+' + solarClock(v),
    },
    title: { display: true, text: 'time after sunrise', color:'#565d64', font:{size:10} },
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
// left on the canvas context. We reuse Chart.defaults.color ('#8a9098'),
// the same gray used by every other label on the dashboard. Font family,
// size and spacing come from the shared legend options in the chart config.
function powerLegendEntries(chart){
  const fontColor = Chart.defaults.color;
  if(powerMode === 'profile'){
    return [
      { text: 'Solar Input (W)', fillStyle: rgba(SOLAR_RGB, 1), strokeStyle: rgba(SOLAR_RGB, 1),
        lineWidth: 2, lineDash: [], pointStyle: 'circle', fontColor, datasetIndex: -1 },
      { text: 'Inverter Power (W)', fillStyle: rgba(INVERTER_RGB, 1), strokeStyle: rgba(INVERTER_RGB, 1),
        lineWidth: 2, lineDash: [], pointStyle: 'circle', fontColor, datasetIndex: -1 },
    ];
  }
  return chart.data.datasets.map((ds, i) => ({
    text: ds.label,
    fillStyle: ds.borderColor,
    strokeStyle: ds.borderColor,
    lineWidth: ds.borderWidth,
    lineDash: [],
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
    backgroundColor: fill ? rgba(rgb, 0.08) : 'transparent',
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
    lineDataset({ label: 'Solar Input (W)', data: [], rgb: SOLAR_RGB, fill: true }),
    lineDataset({ label: 'Inverter Power (W)', data: [], rgb: INVERTER_RGB }),
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
    lineDataset({ label: 'Solar Input (W)', data: solar, rgb: SOLAR_RGB, fill: true }),
    lineDataset({ label: 'Inverter Power (W)', data: power, rgb: INVERTER_RGB }),
  ];
  powerChart.options.scales.x = timeAxisConfig({
    unit: 'minute', stepSize: 5, tooltipFormat: 'HH:mm:ss'
  });
  setInteraction('realtime');
  setTooltipCallbacks({});
  powerChart.update();
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
    powerChart.update();
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
    lineDataset({ label: 'Solar Input (W)', data: solar, rgb: SOLAR_RGB, fill: true }),
    lineDataset({ label: 'Inverter Power (W)', data: power, rgb: INVERTER_RGB }),
  ];
  powerChart.options.scales.x = timeAxisConfig({
    unit: 'hour', stepSize: 1, tooltipFormat: 'HH:mm:ss', min: sunrise ?? undefined, max: end,
  });
  setInteraction('realtime');
  setTooltipCallbacks({});
  // Case D -- correct daylight axis, simply no readings yet today.
  setChartMsg(scoped.length ? null : 'No readings yet today');
  powerChart.update();
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
    powerChart.update();
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
    lineDataset({label: 'Solar Input (W)', data: solarData, rgb: SOLAR_RGB, fill: true}),
    lineDataset({label: 'Inverter Power (W)', data: invData, rgb: INVERTER_RGB}),
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
  powerChart.update();
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
    powerChart.update();
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
        data: solarData, rgb: SOLAR_RGB, fill: true,
      });
      ds.metric = 'Solar Input';
      return ds;
    })(),
    (() => {
      const ds = lineDataset({
        label: 'Inverter Power — avg',
        data: invData, rgb: INVERTER_RGB,
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
  powerChart.update();
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

  // Trim to a reasonable in-memory window depending on range so the chart
  // doesn't grow unbounded during a long session.
  const maxPoints = MAX_POINTS[state.range] || 3000;
  while(solarDs.length > maxPoints){ solarDs.shift(); powerDs.shift(); }

  powerChart.update('none'); // no animation -> smooth, no flicker
}

// ---------- Daily Energy Log (date -> kWh totals; unchanged role) ----------
const dailyChart = new Chart(el('dailyChart').getContext('2d'), {
  type: 'bar',
  data: {
    labels: [],
    datasets: [{
      label: 'Energy (kWh)',
      data: [],
      backgroundColor: 'rgba(245,166,35,0.75)',
      borderRadius: 3,
      maxBarThickness: 26,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 150 },
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display:false }, ticks: { maxRotation: 45, minRotation: 0 } },
      y: { beginAtZero: true, grid: { color: gridColor }, title:{display:true,text:'kWh',color:'#565d64',font:{size:10}} }
    }
  }
});

function renderDailySummary(days){
  dailyChart.data.labels = days.map(d => d.day);
  dailyChart.data.datasets[0].data = days.map(d => d.energy_kwh);
  dailyChart.update();
}

export { renderHistory, renderSessions, renderProfile, appendLivePoint, renderDailySummary };
