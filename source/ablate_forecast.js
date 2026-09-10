/* Ablation study for forecast.js — a DIAGNOSTIC, not a test.
   Run: node source/ablate_forecast.js

   Answers one question about every moving part of the model: what does the
   backtest lose when this part is removed? A component that does not move the
   error is complexity for its own sake and should go; one that moves it a lot
   is where the accuracy actually comes from. Walk-forward, refit at every
   origin, on the real 2025+2026 books, exactly as the page measures itself. */
const F = require('../forecast.js');
const fs = require('fs'), path = require('path');
function loadGlobal(file, key) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const w = {}; new Function('window', src)(w); return w[key];
}
const prior = loadGlobal('prior_year.js', 'DL_PRIOR'), data = loadGlobal('data.js', 'DL_DATA');
const REAL = [...(prior.daily || []), ...(data.daily || [])]
  .filter(d => d && d.date && d.revenue > 0).sort((a, b) => a.date < b.date ? -1 : 1);

const ones = {}; for (let i = 0; i < 7; i++) ones[i] = 1;
const flatSeason = { index: {}, observations: {}, yearLevel: {}, cells: 0 };
for (let m = 1; m <= 12; m++) { flatSeason.index[m] = 1; flatSeason.observations[m] = 0; }

const pct = v => v == null ? '   —  ' : ((v * 100).toFixed(1) + '%').padStart(6);
const row = (name, model, rows) => {
  const bt = F.backtest(rows || REAL, { model: Object.assign({ scenario: 'realistic' }, model) });
  const cells = [30, 60, 90].map(h => bt[h] ? pct(bt[h].mape) + ' (' + (bt[h].bias >= 0 ? '+' : '') + (bt[h].bias * 100).toFixed(0).padStart(3) + '%)' : '    —         ');
  const cold = bt[30] && bt[30].coldStart ? pct(bt[30].coldStart.mape) : '   —  ';
  console.log(name.padEnd(44) + cells.join('  ') + '   cold30 ' + cold + (bt[30] ? '  n=' + bt[30].n : ''));
  return bt;
};
console.log('MAPE (bias) at 30 / 60 / 90 days, origins with a prior year; cold30 = origins without one\n');

console.log('— baselines —');
row('naive: trailing 28d mean, nothing else', { dowIdx: ones, season: flatSeason, driftMode: 'flat', priorWeight: 0, levelMode: 'trailing' });
row('naive + day-of-week', { season: flatSeason, driftMode: 'flat', priorWeight: 0, levelMode: 'trailing' });
row('seasonal naive: last year x yoy only', { priorWeight: 1 });
console.log('\n— the model, then each part removed —');
const full = row('FULL MODEL', {});
row('  - day-of-week index', { dowIdx: ones });
row('  - month index (season)', { season: flatSeason });
row('  - growth trend (level held flat)', { driftMode: 'flat' });
row('  - growth trend, using best month instead', { growthMode: 'high' });
row('  - growth trend, using latest 3 months', { growthMode: 'recent' });
row('  - prior-year blend (A only)', { priorWeight: 0 });
row('  - shape-mode level (trailing)', { levelMode: 'trailing' });
row('  - shape-mode level (median)', { levelMode: 'median' });
row('  - prior-year smoothing (+/-0)', { priorSmooth: 0 });
row('  - event scaling threshold (1.0)', { eventThreshold: 1.0 });
console.log('\n— tuning knobs —');
[14, 21, 28, 42, 56].forEach(w => row('  level window ' + w + 'd', { levelWindow: w }));
[0.3, 0.5, 0.65, 0.8].forEach(w => row('  prior weight fixed ' + w, { priorWeight: w }));
[1, 3, 7].forEach(s => row('  prior smooth +/-' + s, { priorSmooth: s }));
console.log('\n— sale periods (modifiers fitted on the full book: mildly optimistic) —');
const mods = F.salePeriodModifiers(REAL, { years: ['2025', '2026', '2027'] });
row('  with declared sale periods', { modifiers: mods });
console.log('\n— scenarios as forecasts —');
row('  pessimistic', { scenario: 'pessimistic' });
row('  optimistic', { scenario: 'optimistic' });
