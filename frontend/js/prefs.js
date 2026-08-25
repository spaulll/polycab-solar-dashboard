// UI preferences persisted in localStorage so the dashboard remembers how
// the user last left it (selected ranges per panel). Keys are namespaced to
// this dashboard and stable across releases:
//
//   polycab.dashboard.powerRange       Power Over Time range
//   polycab.dashboard.cumulativeRange  Cumulative Energy range
//   polycab.dashboard.monthlyRange     Monthly Energy range
//   polycab.dashboard.temperatureView  Temperature panel lens
//   polycab.dashboard.weatherView      Weather Impact panel lens
//   polycab.dashboard.powercutsRange   Powercuts counter window
//
// Reads are validated against the caller's allowed values and fall back
// silently when storage is unavailable, corrupted, or holds a value that no
// longer exists (e.g. an option removed from the UI). Writes are best
// effort -- private-mode/quota failures never break the dashboard.

const PREFIX = 'polycab.dashboard.';

function loadPref(name, allowedValues, fallback){
  try{
    const value = localStorage.getItem(PREFIX + name);
    return allowedValues.includes(value) ? value : fallback;
  }catch(e){
    return fallback;
  }
}

function savePref(name, value){
  try{
    localStorage.setItem(PREFIX + name, String(value));
  }catch(e){ /* storage unavailable -> defaults simply won't persist */ }
}

export { loadPref, savePref };
