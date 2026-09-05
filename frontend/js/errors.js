// Error history: a notification counter on the Inverter Status card plus a
// popup modal (same visual language and behaviour as the weather popup /
// bottom sheet) listing recent error episodes newest first.
//
// The history itself lives server-side (bounded `error_log` table; the poll
// loop collapses consecutive identical failures into one episode). This
// module mirrors that episode rule live via the WS stream: readings mark a
// recovery, so a repeated identical error after a recovery logs as a new
// episode, while retries within an outage collapse. It also re-fetches on
// boot and whenever the popup opens (episodes logged while the page was
// closed are merged in, server list authoritative).

import { fetchErrors } from './api.js';

const el = id => document.getElementById(id);

const pill = el('errPill'), pillCount = el('errCount'), errNone = el('errNone');
const overlay = el('errorsOverlay');
const MAX_EPISODES = 50;

let errors = [];        // [{logged_at, message}] newest first
let recovered = false;  // a successful reading arrived since the last error
let retentionDays = null; // server rotation window (days), from /api/errors

// ---------- Counter (status card) ----------
function renderCounter(){
  const n = errors.length;
  pill.hidden = n === 0;
  errNone.hidden = n > 0;
  if(n) pillCount.textContent = String(n);
}

// ---------- Episode list (popup) ----------
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// "Aug 29, 14:03:21" — episode timestamps are UTC ISO strings.
function fmtWhen(iso){
  const d = new Date(iso);
  if(Number.isNaN(d.getTime())) return iso || '–';
  return d.toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// "Aug 29" (year appended when outside the current year) for range ends.
function fmtDay(iso){
  const d = new Date(iso);
  if(Number.isNaN(d.getTime())) return null;
  const opts = { month: 'short', day: 'numeric' };
  if(d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

function renderList(list){
  const sub = el('errorsSub');
  if(!list.length){
    sub.textContent = retentionDays
      ? `Nothing in the last ${retentionDays} days`
      : 'nothing recorded yet';
    sub.title = retentionDays
      ? `Error history rotates every ${retentionDays} days — older entries are deleted.`
      : '';
    el('errorsList').innerHTML = '<p class="err-empty">No errors recorded</p>';
    return;
  }
  // Newest first: the span runs oldest shown → newest shown, so the user
  // sees exactly which window these episodes come from.
  const newest = fmtDay(list[0].logged_at);
  const oldest = fmtDay(list[list.length - 1].logged_at);
  const span = (oldest && newest && oldest !== newest)
    ? `${oldest} – ${newest}` : (newest || oldest || '');
  sub.textContent = `${list.length} recorded episode${list.length === 1 ? '' : 's'}`
    + (span ? ` · ${span}` : '');
  sub.title = retentionDays
    ? `Showing the last ${retentionDays} days — older entries rotate away.`
    : '';
  el('errorsList').innerHTML = list.map(e => `
        <div class="err-item">
          <span class="err-when">${escapeHtml(fmtWhen(e.logged_at))}</span>
          <span class="err-what">${escapeHtml(e.message)}</span>
        </div>`).join('');
}

async function loadErrors(){
  try{
    const { errors: fetched, retentionDays: windowDays } = await fetchErrors(MAX_EPISODES);
    if(windowDays) retentionDays = windowDays;
    // Merge: fetched (authoritative) first, then any in-memory episodes the
    // fetch doesn't know about yet, deduped by timestamp+message. WS episode
    // timestamps are the exact strings the server logs with, so the key is
    // stable across both sources.
    const seen = new Set();
    const merged = [];
    for(const e of [...fetched, ...errors]){
      const key = `${e.logged_at}|${e.message}`;
      if(seen.has(key)) continue;
      seen.add(key);
      merged.push(e);
    }
    merged.sort((a, b) => new Date(b.logged_at) - new Date(a.logged_at));
    errors = merged.slice(0, MAX_EPISODES);
    renderCounter();
  }catch(e){
    console.error('Failed to load error history', e);
  }
}

/**
 * Fold one live WS error into the history. Mirrors the server's rule: a
 * repeat of the newest message with no successful reading in between is the
 * same episode still in progress, not a new one.
 */
function noteError(msg){
  if(!msg || !msg.message) return;
  if(!recovered && errors[0] && errors[0].message === msg.message) return;
  errors.unshift({ logged_at: msg.timestamp, message: msg.message });
  if(errors.length > MAX_EPISODES) errors.length = MAX_EPISODES;
  recovered = false;
  renderCounter();
}

// A successful reading arrived: the next error (even an identical message)
// is a new episode.
function noteRecovery(){
  recovered = true;
}

// ---------- Popup open/close (mirrors the weather popup) ----------
function openPopup(){
  renderList(errors);
  overlay.hidden = false;
  pill.setAttribute('aria-expanded', 'true');
  // Next frame so the transition from hidden -> visible actually runs.
  requestAnimationFrame(() => requestAnimationFrame(() =>
    overlay.classList.add('open')));
}

function closePopup(){
  overlay.classList.remove('open');
  pill.setAttribute('aria-expanded', 'false');
  setTimeout(() => { overlay.hidden = true; }, 360); // match spring fade-out
}

pill.addEventListener('click', () => {
  // Re-fetch on open: episodes logged while this page was closed are
  // otherwise missing from the in-memory copy.
  loadErrors().then(openPopup);
});
el('errorsClose').addEventListener('click', closePopup);
overlay.addEventListener('click', e => {
  if(e.target === overlay) closePopup();     // click on dimmed backdrop
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && !overlay.hidden) closePopup();
});

// ---------- Bottom sheet drag (touch, same as the weather sheet) ----------
(function initSheetDrag(){
  const card = overlay.querySelector('.weather-card');
  const handle = el('errorsDrag');
  let active = false, startY = 0, dy = 0;

  handle.addEventListener('pointerdown', e => {
    if(overlay.hidden || !overlay.classList.contains('open')) return;
    active = true;
    startY = e.clientY;
    dy = 0;
    card.style.transition = 'none';
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', e => {
    if(!active) return;
    dy = Math.max(0, e.clientY - startY);
    card.style.transform = `translateY(${dy}px)`;
    card.style.opacity = String(Math.max(0.55, 1 - dy / 400));
  });

  const release = () => {
    if(!active) return;
    active = false;
    card.style.transition = '';
    card.style.opacity = '';
    card.style.transform = '';
    if(dy > 90) closePopup();
  };
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
})();

export function initErrors(){
  loadErrors();
}

export { noteError, noteRecovery };
