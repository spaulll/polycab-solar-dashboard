// Theme handling: applies dark/light to <html data-theme>, persists explicit
// choices in localStorage, and follows the system preference until the user
// toggles manually. `onChange` fires after every applied change so consumers
// with canvas state outside CSS (Chart.js colors) can re-render.

const STORAGE_KEY = 'theme';
const mq = window.matchMedia('(prefers-color-scheme: dark)');

export function currentTheme(){
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' ? 'light' : 'dark';
}

function apply(theme){
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeToggle')
    .setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
}

export function initTheme(onChange){
  // The inline bootstrap in index.html already set data-theme pre-CSS;
  // re-apply here so the toggle's aria-label is in sync.
  const initial = currentTheme();
  apply(initial);
  // Consumers with canvas state outside CSS (Chart.js colors) must also
  // match the initial theme -- not just the theme after a change.
  onChange?.(initial);

  document.getElementById('themeToggle').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(STORAGE_KEY, next); } catch(e){}
    apply(next);
    onChange?.(next);
  });

  // Follow the system only while the user has made no explicit choice.
  mq.addEventListener('change', (e) => {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch(err){}
    if(stored === 'light' || stored === 'dark') return;
    const next = e.matches ? 'dark' : 'light';
    apply(next);
    onChange?.(next);
  });
}
