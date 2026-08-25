// Segmented range toggles: a sliding active indicator behind the buttons.
// Purely visual -- click handling and the .active class stay owned by each
// feature module (main.js, temperature.js, correlation.js). A
// MutationObserver follows class flips from any owner; a window
// 'viewchange' event (dispatched by main.js on view swaps) re-measures
// indicators inside views that were display:none while placed.

function enhance(container){
  if(container._seg) return;
  container._seg = true;
  container.classList.add('seg');

  const ind = document.createElement('span');
  ind.className = 'seg-ind';
  ind.setAttribute('aria-hidden', 'true');
  container.prepend(ind);

  let active = container.querySelector('button.active');

  function place(){
    if(!active){ ind.style.opacity = '0'; return; }
    ind.style.opacity = '1';
    ind.style.width = active.offsetWidth + 'px';
    ind.style.transform = `translateX(${active.offsetLeft}px)`;
  }

  new MutationObserver(() => {
    const a = container.querySelector('button.active');
    if(a !== active){ active = a; place(); }
  }).observe(container, { subtree: true, attributes: true, attributeFilter: ['class'] });

  window.addEventListener('viewchange', () => requestAnimationFrame(place));
  window.addEventListener('resize', place);
  place();
}

export function initSegmented(){
  document.querySelectorAll('.range-toggle').forEach(enhance);
}
