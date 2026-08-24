// Number/date formatting helpers shared across the dashboard.

function fmt(n, digits = 1){
  if(n === null || n === undefined || Number.isNaN(n)) return '–';
  return Number(n).toFixed(digits);
}

function fmtTime(iso){
  if(!iso) return 'no data yet';
  const d = new Date(iso);
  return 'updated ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
}

function fmtClock(iso){
  if(!iso) return '–';
  const d = new Date(iso);
  return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

function fmtDuration(totalSeconds){
  if(totalSeconds === null || totalSeconds === undefined || totalSeconds < 0) return '–';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// Energy in human units: kWh below 1 MWh, MWh above (lifetime totals).
// Returns [value, unit] for callers that render the unit separately,
// or null when there is no value to show.
function fmtEnergy(kwh){
  if(kwh === null || kwh === undefined || Number.isNaN(Number(kwh))) return null;
  const n = Number(kwh);
  return n >= 1000
    ? [(n / 1000).toFixed(2), 'MWh']
    : [n.toFixed(1), 'kWh'];
}

// Money as one compact currency string: Indian-style digit grouping below a
// lakh (₹48,250), then lakh/crore compaction (₹1.24 L, ₹2.31 Cr) so large
// lifetime figures never overflow their row. `currency` is prepended as-is.
function fmtMoney(amount, currency = ''){
  if(amount === null || amount === undefined || Number.isNaN(Number(amount))) return '–';
  const n = Number(amount);
  const cur = currency || '';
  if(n >= 1e7) return cur + (n / 1e7).toFixed(2) + ' Cr';
  if(n >= 1e5) return cur + (n / 1e5).toFixed(2) + ' L';
  return cur + Math.round(n).toLocaleString('en-IN');
}

// CO2 avoided in human units: kilograms below a tonne, tonnes above
// (switch at >= 1000 kg). Returns [value, unit] like fmtEnergy,
// or null when there is no value to show.
function fmtCO2(kg){
  if(kg === null || kg === undefined || Number.isNaN(Number(kg))) return null;
  const n = Number(kg);
  return n >= 1000
    ? [(n / 1000).toFixed(2), 't']
    : [Math.round(n).toString(), 'kg'];
}

export { fmt, fmtTime, fmtClock, fmtDuration, fmtEnergy, fmtMoney, fmtCO2 };
