// Insights panel: conversion loss and averages computed
// client-side over the currently loaded history range. Peak Production is
// NOT derived here -- it arrives separately from the server as MAX(raw DB
// reading) with its original record timestamp (see renderPeakInsight).

import { fmt } from './format.js';
import { state } from './state.js';

const el = id => document.getElementById(id);

function computeInsights(readings){
  el('insightsRangeTag').textContent = state.range.toUpperCase();
  if(!readings || readings.length === 0){
    el('insightLoss').textContent = '–%';
    el('lossBar').style.width = '0%';
    el('insightAvg').textContent = '–';
    el('insightSamples').textContent = '0 samples';
    return;
  }

  let sumSolar = 0, sumPower = 0, n = 0;
  for(const r of readings){
    if(r.solar_input !== null && r.solar_input !== undefined){
      sumSolar += r.solar_input;
      n++;
    }
    if(r.inverter_power !== null && r.inverter_power !== undefined){
      sumPower += r.inverter_power;
    }
  }

  const avgSolar = n ? sumSolar / n : 0;
  const avgPower = n ? sumPower / n : 0;
  const loss = avgSolar > 0 ? Math.max(0, (1 - (avgPower / avgSolar)) * 100) : 0;

  el('insightLoss').textContent = fmt(loss, 1) + '%';
  el('lossBar').style.width = Math.min(100, loss).toFixed(0) + '%';

  el('insightAvg').textContent = fmt(avgSolar, 0) + ' W';
  el('insightSamples').textContent = n + ' samples';
}

// Render the Peak Production insight from the server-computed raw-DB maximum.
// The timestamp is the original record time of the maximum row, so it always
// matches the actual stored reading regardless of the chart aggregation.
function renderPeakInsight(peak){
  if(!peak || peak.value === null || peak.value === undefined){
    el('insightPeakValue').textContent = '–';
    el('insightPeakTime').textContent = 'no data';
    return;
  }
  el('insightPeakValue').textContent = fmt(peak.value, 0) + ' W';
  el('insightPeakTime').textContent = new Date(peak.timestamp).toLocaleString([], {
    month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'
  });
}

export { computeInsights, renderPeakInsight };
