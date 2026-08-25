// Toast stack: transient status messages (WS drop/reconnect, export ready).
// One visible stack, newest at the bottom; duplicate consecutive messages
// collapse into the existing toast instead of stacking spam.

const STACK_ID = 'toasts';
let stack = null;

function ensureStack(){
  if(stack) return stack;
  stack = document.createElement('div');
  stack.id = STACK_ID;
  stack.setAttribute('role', 'status');
  stack.setAttribute('aria-live', 'polite');
  document.body.appendChild(stack);
  return stack;
}

function toast(message, { kind = 'info', timeout = 4000 } = {}){
  const host = ensureStack();

  // Collapse duplicates: refresh an existing identical toast's timer.
  for(const existing of host.children){
    if(existing._msg === message){
      clearTimeout(existing._timer);
      existing._timer = setTimeout(() => dismiss(existing), timeout);
      return existing;
    }
  }

  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node._msg = message;
  node.textContent = message;

  node.addEventListener('click', () => dismiss(node));
  host.appendChild(node);

  // Next frame so the enter transition runs.
  requestAnimationFrame(() => requestAnimationFrame(() =>
    node.classList.add('in')));

  node._timer = setTimeout(() => dismiss(node), timeout);
  return node;
}

function dismiss(node){
  if(!node.isConnected) return;
  clearTimeout(node._timer);
  node.classList.remove('in');
  node.classList.add('out');
  setTimeout(() => node.remove(), 250); // matches the CSS exit transition
}

export { toast };
