// Pull-down-to-refresh on the Live view, touch devices only. When the page
// sits at scroll top and the user drags down past the threshold, the
// caller's refresh function runs and an indicator reports progress.
// Desktop pointers and other views are ignored entirely.

import { prefersReducedMotion } from './motion.js';

const THRESHOLD = 70;
const MAX_PULL = 110;

export function initPullToRefresh(onRefresh){
  if(!('ontouchstart' in window)) return;

  const indicator = document.createElement('div');
  indicator.className = 'pull-hint';
  indicator.setAttribute('aria-hidden', 'true');
  document.body.appendChild(indicator);

  let startY = null;
  let pulling = false;
  let armed = false;   // passed the threshold at some point this gesture
  let busy = false;

  function target(){
    return document.querySelector('.view.active[data-view="live"]');
  }

  function setHint(text){
    indicator.textContent = text;
    indicator.classList.toggle('show', !!text);
  }

  function reset(view){
    if(view){
      // Spring back instead of snapping: a short ease-out on the same
      // transform the drag writes, then release it for the next gesture.
      if(!prefersReducedMotion() && view.style.transform){
        view.style.transition = 'transform 0.45s cubic-bezier(0.22, 1, 0.36, 1)';
        view.style.transform = '';
        setTimeout(() => { view.style.transition = ''; }, 480);
      }else{
        view.style.transform = '';
      }
    }
    setHint('');
    startY = null;
    pulling = false;
  }

  document.addEventListener('touchstart', e => {
    if(busy) return;
    if(window.scrollY > 0) return;
    if(!target()) return;                       // Live view only
    if(e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    armed = false;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if(startY === null || busy) return;
    const dy = e.touches[0].clientY - startY;
    if(dy <= 0){
      if(pulling) reset(target());
      return;
    }
    // Only engage once plain scrolling had its chance (small slop).
    if(!pulling && dy < 12) return;
    pulling = true;
    const view = target();
    const damped = Math.min(MAX_PULL, dy * 0.45);
    if(damped >= THRESHOLD) armed = true;

    if(!prefersReducedMotion() && view){
      view.style.transform = `translateY(${damped}px)`;
    }
    setHint(armed ? 'Release to refresh' : 'Pull to refresh');
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if(startY === null) return;
    const view = target();
    if(armed && !busy){
      busy = true;
      setHint('Refreshing…');
      Promise.resolve()
        .then(onRefresh)
        .catch(() => {})
        .finally(() => {
          busy = false;
          reset(view);
        });
      return;
    }
    reset(view);
  });

}
