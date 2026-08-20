// Shared client-side state, mutated via setRange()/setNightMode().
// Keep this tiny: only cross-module values live here.

const state = {
  range: '1h',   // currently selected history range: 1h | 24h | 7d | all
  nightMode: false,
};

function setRange(range){
  state.range = range;
}

function setNightMode(night){
  state.nightMode = night;
}

export { state, setRange, setNightMode };
