// Savings & Impact sidebar panel: rupee savings and CO2 avoided, derived
// server-side in the `impact` block of /api/generation/summary. Lifetime
// figures follow the inverter's own e_total counter (Inverter Lifetime);
// month/year come from the same stored day buckets as the KPI strip. Same
// fetch lifecycle as the strip: once on load, refreshed on the daily-summary
// cadence (day mode only) and on wake_up -- the wiring lives in main.js.

import { fetchGenerationSummary } from './api.js';
import { fmtEnergy, fmtMoney, fmtCO2 } from './format.js';
import { swapText } from './motion.js';

const el = id => document.getElementById(id);

function render(summary){
  const impact = summary?.impact;
  const panel = el('impactPanel');
  // No tariff configured: hide the whole panel rather than imply ₹0 saved.
  if(!impact || impact.enabled !== true){
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const cur = impact.currency || '';
  swapText(el('impactLifetime'), fmtMoney(impact.lifetime_inr, cur));

  // Basis line under the primary figure: what was generated and at which
  // rate -- savings are always kWh x current tariff, never stored history.
  const kwh = fmtEnergy(impact.lifetime_kwh);
  swapText(el('impactBasis'),
    (kwh ? `${kwh[0]} ${kwh[1]} generated` : 'lifetime') +
    ` · @ ${cur}${Number(impact.tariff)}/kWh`);
  el('impactPrimary').title =
    'Figures are estimated from generated energy × the current flat tariff ' +
    `(${cur}${Number(impact.tariff)}/kWh). Changing the tariff recomputes ` +
    'every figure — past rates are not stored.';

  swapText(el('impactMonth'), fmtMoney(impact.this_month_inr, cur));
  swapText(el('impactYear'), fmtMoney(impact.this_year_inr, cur));

  const co2 = fmtCO2(impact.lifetime_co2_kg);
  swapText(el('impactCO2'), co2 ? `${co2[0]} ${co2[1]}` : '–');
}

async function loadImpact(){
  try{
    render(await fetchGenerationSummary());
  }catch(e){
    console.error('Failed to load savings & impact', e);
  }
}

export { loadImpact };
