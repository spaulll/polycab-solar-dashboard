// Today-at-a-glance mirror: copies the live stat cards + peak insight into
// the premium summary card. No new data source; purely presentational so the
// hero reads instantly on phones. All lookups are guarded -- if the source
// element is missing the glance field keeps its placeholder.

const $ = id => document.getElementById(id);

function text(id){
  const el = $(id);
  return el ? el.textContent.trim() : '';
}

function setText(id, value){
  const el = $(id);
  if(el && value) el.textContent = value;
}

function parseNum(s){
  if(!s || s === '–' || s === '—') return null;
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Peak insight renders like "3.24 kW" or "812 W" (value + unit in one node).
function splitPeak(s){
  if(!s || s === '–') return null;
  const m = String(s).match(/([\d.,]+)\s*([a-zA-Zµ°%]+)?/);
  if(!m) return null;
  return { num: m[1], unit: m[2] || 'W' };
}

function syncNumbers(){
  const solar = text('statSolar');
  const today = text('statToday');
  if(solar && solar !== '–') setText('glanceNow', solar);
  if(today && today !== '–') setText('glanceToday', today);

  const peak = splitPeak(text('insightPeakValue'));
  if(peak){
    setText('glancePeak', peak.num);
    setText('glancePeakUnit', peak.unit);
  }

  // Progress bar: now relative to today's peak (honest, no extra fetch).
  const nowW = parseNum(solar);
  const peakRaw = text('insightPeakValue');
  let peakW = parseNum(peakRaw);
  if(peakW != null && /kW/i.test(peakRaw)) peakW *= 1000;
  const fill = $('glanceFill');
  if(fill){
    let pct = 0;
    if(nowW != null && peakW != null && peakW > 0) pct = Math.max(0, Math.min(1, nowW / peakW));
    fill.style.width = `${Math.round(pct * 100)}%`;
  }
}

function syncState(){
  const mode = text('modeText').toLowerCase();
  const conn = text('connText').toLowerCase();
  const dot = $('glanceDot');
  const label = $('glanceState');
  const sub = $('glanceSub');
  if(!label) return;
  let state = 'Live';
  let cls = 'dot live';
  if(mode.includes('night')){
    state = 'Night · resting';
    cls = 'dot night';
  }else if(conn.includes('connect') || conn.includes('sync') || conn.includes('retry') || conn.includes('offline')){
    state = conn || 'Connecting';
    cls = 'dot down';
  }
  label.textContent = state;
  if(dot) dot.className = cls;
  if(sub) sub.textContent = mode.includes('night') ? 'inverter asleep · resumes at sunrise' : 'live summary';
}

export function initGlance(){
  syncNumbers();
  syncState();
  // Live stats update via textContent swaps (no events), so observe them.
  const watch = ['statSolar', 'statToday', 'insightPeakValue', 'modeText', 'connText'];
  const obs = new MutationObserver(() => { syncNumbers(); syncState(); });
  for(const id of watch){
    const el = $(id);
    if(el) obs.observe(el, { childList: true, characterData: true, subtree: true });
  }
  // Fallback tick in case a renderer replaces nodes wholesale.
  setInterval(() => { syncNumbers(); syncState(); }, 5000);
}
