// WebSocket client: connect, auto-reconnect, and hand every parsed message
// to a caller-supplied dispatcher. Knows nothing about charts or stats.

import { WS_URL, WS_RECONNECT_DELAY_MS } from './config.js';
import { setConn } from './ui.js';

let socket = null;
let reconnectTimer = null;
let dispatch = null; // current message dispatcher, kept for reconnects

function connectWebSocket(onMessage){
  dispatch = onMessage;
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    setConn('live');
    if(reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  socket.onclose = () => {
    // Degraded, not dead: reconnects are automatic. The pill escalates
    // from "syncing…" to "offline · Xm" on its own schedule (ui.js).
    setConn('syncing');
    scheduleReconnect();
  };

  socket.onerror = () => {
    setConn('syncing');
  };

  socket.onmessage = (event) => {
    dispatch(JSON.parse(event.data));
  };
}

function scheduleReconnect(){
  if(reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket(dispatch);
  }, WS_RECONNECT_DELAY_MS);
}

export { connectWebSocket };
