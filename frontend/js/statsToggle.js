// Collapsible live-readings strip. Shut by default so the Power Over Time
// chart stays in view; the toggle carries a live mini-summary so the key
// numbers are still glanceable. Choice persists via prefs.js.

import { loadPref, savePref } from './prefs.js';

export function initStatsToggle(){
  const btn = document.getElementById('statsToggle');
  const grid = document.getElementById('statsGrid');
  if(!btn || !grid) return;

  const set = (open) => {
    btn.setAttribute('aria-expanded', String(open));
    grid.hidden = !open;
    savePref('statsOpen', open ? 'open' : 'shut');
  };

  btn.addEventListener('click', () => set(grid.hidden));
  set(loadPref('statsOpen', ['open', 'shut'], 'shut') === 'open');
}
