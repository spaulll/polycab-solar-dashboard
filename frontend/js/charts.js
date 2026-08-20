// Chart.js setup and data flow for the power line chart and the daily
// energy bar chart, including gap-breaking and live-point trimming.

import { GAP_THRESHOLD_MS, MAX_POINTS } from './config.js';
import { state } from './state.js';

const el = id => document.getElementById(id);

// ---------- Chart.js defaults (dark theme) ----------
Chart.defaults.color = '#8a9098';
Chart.defaults.font.family = "'SF Mono', Consolas, Menlo, ui-monospace, monospace";
Chart.defaults.font.size = 11;

const gridColor = 'rgba(255,255,255,0.05)';

const powerChart = new Chart(el('powerChart').getContext('2d'), {
  type: 'line',
  data: {
    datasets: [
      {
        label: 'Solar Input (W)',
        data: [],
        borderColor: '#f5a623',
        backgroundColor: 'rgba(245,166,35,0.08)',
        borderWidth: 1.8,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.25,
        spanGaps: false,
      },
      {
        label: 'Inverter Power (W)',
        data: [],
        borderColor: '#5b9bd5',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: false,
        tension: 0.25,
        spanGaps: false,
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 }, // avoid jank on frequent live updates
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        position: 'top',
        align: 'end',
        labels: { boxWidth: 10, boxHeight:10, usePointStyle: true, pointStyle: 'circle', padding: 14 }
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
      x: {
        type: 'time',
        time: { tooltipFormat: 'MMM d, HH:mm:ss' },
        grid: { color: gridColor, drawTicks: false },
        ticks: { maxRotation: 0, autoSkipPadding: 20 },
      },
      y: {
        beginAtZero: true,
        grace: '8%',
        grid: { color: gridColor, drawTicks: false },
        title: { display: true, text: 'Watts', color:'#565d64', font:{size:10} },
      }
    }
  }
});

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

// ---------- Time-axis tick config per range ----------
function applyAxisConfigForRange(range){
  const x = powerChart.options.scales.x;
  if(range === '1h'){
    x.time.unit = 'minute'; x.time.stepSize = 5;
    x.time.tooltipFormat = 'HH:mm:ss';
    x.ticks.source = 'auto';
  } else if(range === '24h'){
    x.time.unit = 'hour'; x.time.stepSize = 1;
    x.time.tooltipFormat = 'MMM d, HH:mm';
  } else if(range === '7d'){
    x.time.unit = 'day'; x.time.stepSize = 1;
    x.time.tooltipFormat = 'MMM d, HH:mm';
  } else { // all
    x.time.unit = undefined;
    x.time.tooltipFormat = 'MMM d, yyyy HH:mm';
  }
}

// ---------- Gap handling ----------
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

function renderHistory(readings){
  const {solar, power} = toPointArrays(readings);
  powerChart.data.datasets[0].data = solar;
  powerChart.data.datasets[1].data = power;
  applyAxisConfigForRange(state.range);
  powerChart.update();
}

// ---------- Live point appending ----------
function appendLivePoint(reading){
  const t = new Date(reading.timestamp);
  const solarDs = powerChart.data.datasets[0].data;
  const powerDs = powerChart.data.datasets[1].data;

  // Detect gap since the last plotted point (e.g. after reconnect)
  if(solarDs.length){
    const prevT = solarDs[solarDs.length - 1].x;
    if(prevT && (t - new Date(prevT)) > GAP_THRESHOLD_MS){
      const gapT = new Date(new Date(prevT).getTime() + 1000);
      solarDs.push({x: gapT, y: null});
      powerDs.push({x: gapT, y: null});
    }
  }

  solarDs.push({x: t, y: reading.Solar_Input});
  powerDs.push({x: t, y: reading.Inverter_Power});

  // Trim to a reasonable in-memory window depending on range so the chart
  // doesn't grow unbounded during a long session.
  const maxPoints = MAX_POINTS[state.range] || 3000;
  if(solarDs.length > maxPoints){ solarDs.shift(); powerDs.shift(); }

  powerChart.update('none'); // no animation -> smooth, no flicker
}

function renderDailySummary(days){
  dailyChart.data.labels = days.map(d => d.day);
  dailyChart.data.datasets[0].data = days.map(d => d.energy_kwh);
  dailyChart.update();
}

export { applyAxisConfigForRange, renderHistory, appendLivePoint, renderDailySummary };
