// Hash router for the three dashboard views (#/live, #/trends, #/insights).
// Back/forward and deep links work for free off the URL hash; the last view
// persists through prefs so a bare reload lands where the user left off.
// Consumers subscribe once; the active-view DOM toggling lives with them.

import { loadPref, savePref } from './prefs.js';

export const VIEWS = ['live', 'trends', 'insights'];
const DEFAULT_VIEW = 'live';

let current = null;
const listeners = new Set();

function readHash(){
  const h = location.hash.replace(/^#\/?/, '');
  return VIEWS.includes(h) ? h : null;
}

function emit(view, prev){
  current = view;
  savePref('view', view);
  listeners.forEach(fn => fn(view, prev));
}

// Programmatic navigation; no-op when already there.
function navigate(view){
  if(!VIEWS.includes(view) || view === current) return;
  location.hash = '#/' + view; // fires hashchange -> emit
}

function initRouter(onChange){
  if(onChange) listeners.add(onChange);

  const initial = readHash() ?? loadPref('view', VIEWS, DEFAULT_VIEW);
  // Deep-link restore without leaving an extra history entry.
  history.replaceState(null, '', '#/' + initial);
  emit(initial, null);

  window.addEventListener('hashchange', () => {
    const v = readHash();
    if(v && v !== current) emit(v, current);
    else if(!v) navigate(current); // cleared/invalid hash: re-assert
  });
}

export { initRouter, navigate };
