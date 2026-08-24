// Average Daily Yield card: range-selectable stats from
// /api/generation/stats. The two date inputs are constrained to the
// backend's reported available range (min_date .. today); on first load no
// range is sent so the backend applies its last-30-days default, and the
// inputs are synced from the echoed from/to.

import { fetchGenerationStats } from './api.js';
import { fmtEnergy } from './format.js';

const el = id => document.getElementById(id);

const fromInput = el('yieldFrom'), toInput = el('yieldTo');

const unit = name => '<span class="unit">' + name + '</span>';

// Guarded request id so a slow response for an old range can't overwrite
// the numbers of a newer selection.
let reqId = 0;

function setEnergy(id, kwh){
  const parts = fmtEnergy(kwh);
  el(id).innerHTML = parts ? parts[0] + unit(parts[1]) : '–';
}

function setDateLabel(id, day){
  el(id).textContent = day
    ? new Date(day.date + 'T00:00:00').toLocaleDateString([], {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
      })
    : 'no data';
}

function render(s){
  setEnergy('yieldAvg', s.average_daily_kwh);
  const total = fmtEnergy(s.total_kwh);
  el('yieldMeta').textContent = s.days
    ? `${s.days} day${s.days === 1 ? '' : 's'} with data · ${total[0]} ${total[1]} total`
    : 'no data in this range';
  setEnergy('yieldBest', s.best_day?.kwh);
  setDateLabel('yieldBestDate', s.best_day);
  setEnergy('yieldWorst', s.worst_day?.kwh);
  setDateLabel('yieldWorstDate', s.worst_day);
}

async function loadYieldStats(){
  const currentReq = ++reqId;
  // Only send an explicit range once both inputs hold a value; otherwise
  // let the backend apply its default and sync the inputs afterwards.
  const hasRange = !!(fromInput.value && toInput.value);
  try{
    const s = await fetchGenerationStats(
      hasRange ? fromInput.value : null,
      hasRange ? toInput.value : null
    );
    if(currentReq !== reqId) return;
    if(s.error){
      console.warn('Generation stats:', s.error);
      el('yieldMeta').textContent = s.error;
      return;
    }
    // Constrain both pickers to what the database actually has.
    if(s.min_date){ fromInput.min = s.min_date; toInput.min = s.min_date; }
    if(s.max_date){ fromInput.max = s.max_date; toInput.max = s.max_date; }
    if(!hasRange && s.from){
      fromInput.value = s.from;
      toInput.value = s.to;
    }
    render(s);
  }catch(e){
    console.error('Failed to load generation stats', e);
  }
}

function initYieldCard(){
  fromInput.addEventListener('change', loadYieldStats);
  toInput.addEventListener('change', loadYieldStats);
}

export { initYieldCard, loadYieldStats };
