// Insights panel: conversion loss and averages computed
// client-side over the currently loaded history range. Peak Production is
// NOT derived here -- it arrives separately from the server as MAX(raw DB
// reading) with its original record timestamp (see renderPeakInsight).

import { fmt } from './format.js';
import { swapText } from './motion.js';

const el = id => document.getElementById(id);

function computeInsights(readings){
  if(!readings || readings.length === 0){
    swapText(el('insightLoss'), '–%');
    el('lossBar').style.width = '0%';
    swapText(el('insightAvg'), '–');
    swapText(el('insightSamples'), '0 samples');
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

  swapText(el('insightLoss'), fmt(loss, 1) + '%');
  el('lossBar').style.width = Math.min(100, loss).toFixed(0) + '%';

  swapText(el('insightAvg'), fmt(avgSolar, 0) + ' W');
  swapText(el('insightSamples'), n + ' samples');
}

// Render the Peak Production insight from the server-computed raw-DB maximum.
// The timestamp is the original record time of the maximum row, so it always
// matches the actual stored reading regardless of the chart aggregation.
function renderPeakInsight(peak){
  if(!peak || peak.value === null || peak.value === undefined){
    swapText(el('insightPeakValue'), '–');
    swapText(el('insightPeakTime'), 'no data');
    return;
  }
  swapText(el('insightPeakValue'), fmt(peak.value, 0) + ' W');
  swapText(el('insightPeakTime'), new Date(peak.timestamp).toLocaleString([], {
    month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'
  }));
}

export { computeInsights, renderPeakInsight };
