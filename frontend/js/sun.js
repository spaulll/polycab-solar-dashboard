// Sun strip: sunrise/sunset times plus a local 1-second countdown ticker.
// Refreshes from the server when a countdown reaches zero (to flip
// sunrise<->sunset) and periodically to stay accurate over long sessions.

import { SUN_COUNTDOWN_TICK_MS } from './config.js';
import { fmtClock, fmtDuration } from './format.js';
import { fetchSunInfo } from './api.js';

const el = id => document.getElementById(id);

let sunTargetSunrise = null; // Date
let sunTargetSunset = null;  // Date
let sunIsNight = false;

function updateSunInfo(sun){
  sunTargetSunrise = sun.next_sunrise ? new Date(sun.next_sunrise) : null;
  sunTargetSunset = sun.next_sunset ? new Date(sun.next_sunset) : null;
  sunIsNight = !!sun.is_night;

  el('sunNextSunrise').textContent = fmtClock(sun.next_sunrise);
  el('sunNextSunset').textContent = fmtClock(sun.next_sunset);

  el('sunCountdownLabel').textContent = sunIsNight ? 'Time to sunrise' : 'Time to sunset';

  tickSunCountdown(); // render immediately instead of waiting for next tick
}

function tickSunCountdown(){
  const target = sunIsNight ? sunTargetSunrise : sunTargetSunset;
  if(!target){
    el('sunCountdown').textContent = '–';
    return;
  }
  const secondsLeft = (target - new Date()) / 1000;
  el('sunCountdown').textContent = fmtDuration(secondsLeft);

  // If the countdown reaches zero, refresh from the server to flip
  // sunrise<->sunset mode and pick up the new target time.
  if(secondsLeft <= 0){
    refreshSunInfo();
  }
}

async function refreshSunInfo(){
  try{
    updateSunInfo(await fetchSunInfo());
  }catch(e){
    console.error('Failed to load sun info', e);
  }
}

function startSunTicker(){
  setInterval(tickSunCountdown, SUN_COUNTDOWN_TICK_MS);
}

export { updateSunInfo, refreshSunInfo, startSunTicker };
