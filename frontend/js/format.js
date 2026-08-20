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

export { fmt, fmtTime, fmtClock, fmtDuration };
