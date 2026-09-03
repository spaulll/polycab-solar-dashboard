// Motion primitives: number tickers, value pops, card flashes and the
// reduced-motion gate. Transform/opacity-friendly; every animation degrades
// to an instant set when prefers-reduced-motion is active.

export function prefersReducedMotion(){
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const current = new WeakMap(); // element -> last rendered number

function easeOutQuart(t){
  return 1 - Math.pow(1 - t, 4);
}

// Gentle rise cue on a freshly-tweened number: re-trigger the .tick
// keyframe so live values glide instead of swapping harshly.
function popNumber(el){
  if(prefersReducedMotion()) return;
  if(!el || !el.classList) return;
  if(el._tickTimer) clearTimeout(el._tickTimer);
  el.classList.remove('tick');
  void el.offsetWidth; // restart the keyframe
  el.classList.add('tick');
  el._tickTimer = setTimeout(() => el.classList.remove('tick'), 480);
}

// Soft accent wash across the owning card so a fresh reading reads as alive
// without flashing the number itself. Throttled per card so rapid successive
// tweens (grid V + A on one tile) coalesce into a single sweep.
function flashCard(el){
  if(prefersReducedMotion()) return;
  const card = el?.closest?.('.stat-card, .gen-card');
  if(!card) return;
  const now = performance.now();
  if(card._flashAt && now - card._flashAt < 1500) return;
  card._flashAt = now;
  card.classList.remove('live-tick');
  void card.offsetWidth;
  card.classList.add('live-tick');
  clearTimeout(card._flashTimer);
  card._flashTimer = setTimeout(() => card.classList.remove('live-tick'), 750);
}

/**
 * Animate a .num element's textContent from its previous numeric value to
 * `to`, formatted with `digits` decimals. Snaps when the element has no
 * readable previous value (first paint / placeholder) or when reduced
 * motion is requested -- placeholders must never read as fake zeros.
 */
function tweenNumber(el, to, digits = 0){
  const target = Number(to);
  if(!Number.isFinite(target)){
    el.textContent = '–';
    current.delete(el);
    return;
  }
  const from = current.get(el);
  current.set(el, target);

  if(from === undefined || !Number.isFinite(from) || prefersReducedMotion()){
    el.textContent = target.toFixed(digits);
    return;
  }
  if(from === target){
    el.textContent = target.toFixed(digits);
    return;
  }

  // Restart any in-flight animation for this element.
  if(el._tween){ cancelAnimationFrame(el._tween.raf); }

  // Buttery count: slightly longer than before with a quart ease-out so
  // large jumps decelerate silkily instead of stopping abruptly.
  const delta = Math.abs(target - from);
  const dur = Math.min(850, Math.max(450, 450 + delta * 2));
  const t0 = performance.now();
  const state = { raf: 0 };
  el._tween = state;

  popNumber(el);
  flashCard(el);

  const step = now => {
    const p = Math.min(1, (now - t0) / dur);
    const v = from + (target - from) * easeOutQuart(p);
    if(p < 1){
      el.textContent = v.toFixed(digits);
      state.raf = requestAnimationFrame(step);
    }else{
      el.textContent = target.toFixed(digits);
      el._tween = null;
    }
  };
  state.raf = requestAnimationFrame(step);
}

// ---------- Scroll reveals ----------
// Progressive enhancement only: elements stay fully visible without JS.
// Once enabled, rows below the fold rise in as they scroll into view with a
// per-sibling stagger. Panels/cards keep their CSS view-enter choreography;
// this layer covers the quiet rows inside them.
let revealsInit = false;

function initReveals(){
  if(revealsInit) return;
  revealsInit = true;
  document.body.classList.add('js-anim');
  if(prefersReducedMotion()) return;

  const ROW_SEL = '.insight, .panel-status .meta-row, .pc-row, .err-row, .gen-alt';
  const rows = [...document.querySelectorAll(ROW_SEL)];
  if(!('IntersectionObserver' in window) || !rows.length){
    return;
  }

  // Stagger siblings inside the same parent so a panel's rows cascade.
  const groups = new Map();
  for(const row of rows){
    const key = row.parentElement;
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for(const list of groups.values()){
    list.forEach((row, i) => {
      row.classList.add('reveal');
      row.style.setProperty('--reveal-delay', `${Math.min(i * 0.06, 0.3)}s`);
    });
  }

  const io = new IntersectionObserver(entries => {
    for(const e of entries){
      if(e.isIntersecting){
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });

  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  // Views toggle display:none; re-check rows when the visible view changes.
  window.addEventListener('viewchange', () => {
    requestAnimationFrame(() =>
      document.querySelectorAll('.view.active .reveal:not(.in)').forEach(el => io.observe(el)));
  });
}

// Soft text swap for values that carry units/suffixes (insight rows, meta
// rows, yield cards): sets the text, then glides it up once via the
// compositor. Skips the glide on first paint (empty placeholder) and under
// reduced motion so honest empty states never animate in as content.
function pop(el){
  if(prefersReducedMotion()) return;
  if(!el || !el.animate) return;
  try{
    el.animate(
      [{ opacity: 0.35, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
      { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }catch(e){}
}

function swapText(el, text){
  if(!el) return;
  const next = text ?? '–';
  const cur = el.textContent ?? '';
  if(cur === next) return;
  const firstPaint = cur.trim() === '–' || cur.trim() === '';
  el.textContent = next;
  if(!firstPaint) pop(el);
}

export { tweenNumber, initReveals, pop, swapText };
