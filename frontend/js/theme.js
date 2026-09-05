// Theme handling: three preferences (light | dark | auto) resolved to a
// light/dark <html data-theme> for styling. The preference lives in
// localStorage under 'theme'; missing/invalid means 'auto' (follow the OS),
// so first-time visitors track the system with zero clicks. data-theme-mode
// keeps the raw preference for the toggle icon; data-theme keeps the
// resolved value for CSS. `onChange` fires with the resolved theme after
// every applied change so consumers with canvas state outside CSS (Chart.js
// colors) can re-render.
//
// Every mutation routes through withThemeTransition(): a View Transition
// crossfade when the API exists and motion is allowed, otherwise an instant
// swap — one choke point, no other edits needed.

const STORAGE_KEY = 'theme';
const MODES = ['light', 'dark', 'auto'];
const CYCLE = { light: 'dark', dark: 'auto', auto: 'light' };
const mq = window.matchMedia('(prefers-color-scheme: dark)');

function systemTheme(){
  return mq.matches ? 'dark' : 'light';
}

function readPreference(){
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return MODES.includes(v) ? v : 'auto';
  } catch(e){
    return 'auto';
  }
}

export function themePreference(){
  return document.documentElement.getAttribute('data-theme-mode') === 'light'
    ? 'light'
    : document.documentElement.getAttribute('data-theme-mode') === 'dark'
      ? 'dark'
      : 'auto';
}

export function currentTheme(){
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' ? 'light' : 'dark';
}

// Single choke point for theme mutations: buttery crossfade via the View
// Transitions API, instant fallback without it or under reduced motion.
function withThemeTransition(mutate){
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!reduce && document.startViewTransition){
    document.startViewTransition(mutate);
  }else{
    mutate();
  }
}

function syncToggleLabel(pref = themePreference(), resolved = currentTheme()){
  const next = CYCLE[pref] ?? 'light';
  const btn = document.getElementById('themeToggle');
  if(!btn) return;
  const prefLabel = pref === 'auto' ? `auto (system ${resolved})` : pref;
  btn.setAttribute('aria-label', `Theme: ${prefLabel} — click for ${next} mode`);
  btn.setAttribute('title', `Theme: ${prefLabel} — click for ${next}`);
}

function applyResolved(resolved){
  withThemeTransition(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  });
  // Pass explicitly: the View Transition defers the DOM write, so reading
  // back data-theme here would still see the previous value.
  syncToggleLabel('auto', resolved);
}

function applyPreference(pref, onChange){
  const resolved = pref === 'auto' ? systemTheme() : pref;
  withThemeTransition(() => {
    document.documentElement.setAttribute('data-theme-mode', pref);
    document.documentElement.setAttribute('data-theme', resolved);
  });
  syncToggleLabel(pref, resolved);
  onChange?.(resolved);
}

export function initTheme(onChange){
  // The inline bootstrap in index.html already set data-theme-mode +
  // data-theme pre-CSS; re-sync here so the toggle label and charts match.
  const initial = readPreference();
  document.documentElement.setAttribute('data-theme-mode', initial);
  document.documentElement.setAttribute(
    'data-theme', initial === 'auto' ? systemTheme() : initial);
  syncToggleLabel();
  // Consumers with canvas state outside CSS (Chart.js colors) must also
  // match the initial theme -- not just the theme after a change.
  onChange?.(currentTheme());

  document.getElementById('themeToggle').addEventListener('click', () => {
    const next = CYCLE[themePreference()] ?? 'light';
    try { localStorage.setItem(STORAGE_KEY, next); } catch(e){}
    applyPreference(next, onChange);
  });

  // Follow the system only while the preference is 'auto'.
  mq.addEventListener('change', () => {
    if(themePreference() !== 'auto') return;
    const resolved = systemTheme();
    applyResolved(resolved);
    onChange?.(resolved);
  });
}
