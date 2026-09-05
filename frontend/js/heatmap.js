// Year heatmap calendar: GitHub-style daily-yield grid below the Daily Log.
// Pure HTML/CSS (not Chart.js). Reuses GET /api/daily-summary full series
// (no backend change, no extra fetch): gap days stay blank, never
// zero-filled. Year selector defaults to the current year, lists prior years
// when data exists, persists via prefs.js (heatmapYear).

import { loadPref, savePref } from './prefs.js';

const el = id => document.getElementById(id);

const YEAR_KEY = 'heatmapYear';

let latestDays = [];
let selectedYear = null;

function yearsInData(){
  const years = new Set();
  for(const d of latestDays){
    const y = String(d.day || '').slice(0, 4);
    if(/^\d{4}$/.test(y)) years.add(y);
  }
  const cur = String(new Date().getFullYear());
  years.add(cur);
  return [...years].sort();
}

function maxKwhForYear(year){
  let max = 0;
  for(const d of latestDays){
    if(String(d.day).slice(0, 4) !== String(year)) continue;
    const v = Number(d.energy_kwh);
    if(Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

function levelFor(kwh, max){
  if(kwh === null || kwh === undefined || Number.isNaN(Number(kwh))) return 0;
  if(!(max > 0)) return 1;
  const f = Number(kwh) / max;
  if(f <= 0) return 1;
  if(f <= 0.25) return 1;
  if(f <= 0.5) return 2;
  if(f <= 0.75) return 3;
  return 4;
}

function syncYearSelect(){
  const select = el('heatmapYear');
  if(!select) return;
  const years = yearsInData();
  const prev = select.value;
  select.textContent = '';
  for(const y of [...years].reverse()){
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    select.appendChild(opt);
  }
  if(years.includes(prev)){
    select.value = prev;
    selectedYear = prev;
  }else if(selectedYear && years.includes(selectedYear)){
    select.value = selectedYear;
  }else{
    const fallback = loadPref(YEAR_KEY, years, years[years.length - 1]);
    select.value = fallback;
    selectedYear = fallback;
  }
}

function renderGrid(){
  const grid = el('heatmapGrid');
  const note = el('heatmapNote');
  if(!grid) return;
  if(!selectedYear){
    grid.innerHTML = '';
    if(note){ note.hidden = true; }
    return;
  }
  const year = Number(selectedYear);
  const byDay = new Map();
  for(const d of latestDays){
    if(String(d.day).slice(0, 4) !== String(selectedYear)) continue;
    byDay.set(d.day, Number(d.energy_kwh));
  }
  const max = maxKwhForYear(selectedYear);

  // Weeks as columns (Mon-first), rows = weekdays. Leading/trailing blanks
  // pad the first/last week so every column has 7 cells.
  const jan1 = new Date(year, 0, 1);
  // JS getDay: 0=Sun..6=Sat; convert to Mon-first offset (0=Mon).
  const lead = (jan1.getDay() + 6) % 7;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  const daysInYear = isLeap ? 366 : 365;
  const total = lead + daysInYear;
  const weeks = Math.ceil(total / 7);

  const frag = document.createDocumentFragment();
  let dayIndex = 1 - lead; // 1-based day-of-year; <=0 or >daysInYear = pad
  let withData = 0;
  for(let w = 0; w < weeks; w++){
    const col = document.createElement('div');
    col.className = 'hm-week';
    for(let r = 0; r < 7; r++){
      const cell = document.createElement('span');
      if(dayIndex < 1 || dayIndex > daysInYear){
        cell.className = 'hm-day pad';
        cell.setAttribute('aria-hidden', 'true');
      }else{
        const dt = new Date(year, 0, dayIndex);
        const iso = `${selectedYear}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        if(byDay.has(iso)){
          const kwh = byDay.get(iso);
          withData++;
          cell.className = `hm-day lv${levelFor(kwh, max)}`;
          cell.title = `${iso} · ${Number(kwh).toFixed(1)} kWh`;
        }else{
          cell.className = 'hm-day lv0';
          cell.title = `${iso} · no data`;
        }
      }
      col.appendChild(cell);
      dayIndex++;
    }
    frag.appendChild(col);
  }
  grid.replaceChildren(frag);

  if(note){
    const curYear = String(new Date().getFullYear());
    if(String(selectedYear) === curYear){
      note.hidden = false;
      note.textContent = `partial year · ${withData} days · blank = no data`;
      note.title = 'The current year is in progress; blank days have no recorded data (never zero-filled).';
    }else if(withData < daysInYear){
      note.hidden = false;
      note.textContent = `blank = no data · ${withData}/${daysInYear} days`;
      note.title = 'Gap days stay blank; they are never filled with zeros.';
    }else{
      note.hidden = true;
      note.textContent = `${withData}/${daysInYear} days`;
      note.title = 'Complete year.';
    }
  }
}

function renderHeatmap(days){
  if(days) latestDays = days;
  syncYearSelect();
  renderGrid();
}

function initHeatmap(){
  const select = el('heatmapYear');
  if(select){
    // Restore before first data so the initial render uses the saved year
    // when it exists; otherwise defaults to the current year on first data.
    const saved = (() => {
      try{ return localStorage.getItem('polycab.dashboard.' + YEAR_KEY); }
      catch(e){ return null; }
    })();
    if(saved) selectedYear = saved;
    select.addEventListener('change', e => {
      selectedYear = e.target.value;
      savePref(YEAR_KEY, selectedYear);
      renderGrid();
    });
  }
}

export { initHeatmap, renderHeatmap };
