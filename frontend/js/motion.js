// Motion primitives: number tickers and the reduced-motion gate.
// Transform/opacity-friendly; every animation degrades to an instant set
// when prefers-reduced-motion is active.

export function prefersReducedMotion(){
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const current = new WeakMap(); // element -> last rendered number

function easeOutCubic(t){
  return 1 - Math.pow(1 - t, 3);
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

  const dur = 500;
  const t0 = performance.now();
  const state = { raf: 0 };
  el._tween = state;

  const step = now => {
    const p = Math.min(1, (now - t0) / dur);
    const v = from + (target - from) * easeOutCubic(p);
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

export { tweenNumber };
