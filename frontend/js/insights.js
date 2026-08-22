// Insights panel: conversion loss, peak production, and averages computed
// client-side over the currently loaded history range.

import { fmt } from './format.js';
import { state } from './state.js';

const el = id => document.getElementById(id);

function computeInsights(readings){
  el('insightsRangeTag').textContent = state.range.toUpperCase();
  if(!readings || readings.length === 0){
    el('insightLoss').textContent = '–%';
    el('lossBar').style.width = '0%';
    el('insightPeakValue').textContent = '–';
    el('insightPeakTime').textContent = 'no data';
    el('insightAvg').textContent = '–';
    el('insightSamples').textContent = '0 samples';
    return;
  }

  let sumSolar = 0, sumPower = 0, n = 0;
  let peak = null;
  for(const r of readings){
    if(r.solar_input !== null && r.solar_input !== undefined){
      sumSolar += r.solar_input;
      n++;
      if(peak === null || r.solar_input > peak.solar_input) peak = r;
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

  if(peak){
    el('insightPeakValue').textContent = fmt(peak.solar_input, 0) + ' W';
    // Normalized-profile bins carry their solar-day position as a label
    // instead of a wall-clock timestamp.
    el('insightPeakTime').textContent = peak.label
      ?? new Date(peak.timestamp).toLocaleString([], {
        month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'
      });
  }

  el('insightAvg').textContent = fmt(avgSolar, 0) + ' W';
  el('insightSamples').textContent = n + ' samples';
}

export { computeInsights };
