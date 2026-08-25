// WebSocket client: connect, auto-reconnect, and hand every parsed message
// to a caller-supplied dispatcher. Knows nothing about charts or stats.
// Connection trouble surfaces through the connection pill plus a toast on
// drop/recovery so silent stalls never masquerade as live data.

import { WS_URL, WS_RECONNECT_DELAY_MS } from './config.js';
import { setConn } from './ui.js';
import { toast } from './toast.js';

let socket = null;
let reconnectTimer = null;
let dispatch = null; // current message dispatcher, kept for reconnects
let wasDegraded = false;

function connectWebSocket(onMessage){
  dispatch = onMessage;
  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    setConn('live');
    if(wasDegraded){
      wasDegraded = false;
      toast('Back online', 'ok');
    }
    if(reconnectTimer){ clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  socket.onclose = () => {
    // Degraded, not dead: reconnects are automatic. The pill escalates
    // from "syncing…" to "offline · Xm" on its own schedule (ui.js).
    if(!wasDegraded){
      wasDegraded = true;
      toast('Connection lost — reconnecting…');
    }
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
