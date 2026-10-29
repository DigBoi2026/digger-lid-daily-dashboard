/* Unit tests for forecast_simple.js — the spend-led forecast.
   Run: node source/test_forecast_simple.js   (exit 0 = all pass)

   Synthetic first: a year built as last year x a known growth, so the forecast
   can be checked against the answer that produced it. Then a regression guard
   on the real books. */
const S = require('../forecast_simple.js');
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}
const near = (a, b, t = 0.01) => a != null && b != null && Math.abs(a - b) < t;

/* Two years, the second exactly g x the first on the weekday-aligned day, with
   spend s x. Revenue wobbles by weekday and by a mid-year event so nothing is
   trivially flat. */
function books(g, s) {
  const rows = [];
  for (let d = '2025-01-01'; d <= '2025-12-31'; d = S.addDays(d, 1)) {
    const k = rows.length, event = d >= '2025-06-10' && d <= '2025-06-30' ? 2 : 1;
    const rev = (1000 + 200 * (k % 7)) * event, ads = 300 + 50 * (k % 7);
    rows.push({ date: d, revenue: rev, totalAds: ads, revExGst: rev * 0.92, totalVC: rev * 0.45, totalFC: 500 });
  }
  const ly = rows.slice();
  ly.forEach(r => {
    const d = S.addDays(r.date, 364);
    if (d > '2026-09-30') return;
    rows.push({ date: d, revenue: r.revenue * g, totalAds: r.totalAds * s, revExGst: r.revenue * g * 0.92,
                totalVC: r.revenue * g * 0.45, totalFC: 600 });
  });
  return rows;
}

/* --------------------------------------------------------------- the formula */
{
  const rows = books(1.5, 2), by = S.index(rows);
  const lySpend = S.total(by, S.addDays('2026-06-01', -364), S.addDays('2026-06-30', -364), 'totalAds').sum;
  const lyRev = S.total(by, S.addDays('2026-06-01', -364), S.addDays('2026-06-30', -364), 'revenue').sum;
  // spend growing as it does today -> revenue grows as it does today, event included
  const same = S.period(by, '2026-05-20', '2026-06-01', '2026-06-30', lySpend * 2);
  ok('spend on trend: revenue = last year x today\'s growth', near(same.revenue / lyRev, 1.5, 1e-9), same.revenue / lyRev);
  ok('yoy revenue read from the trailing window', near(same.yoyRevenue, 1.5, 1e-9));
  ok('yoy spend read from the trailing window', near(same.yoySpendNow, 2, 1e-9));
  // half the spend growth -> half the revenue at e = 1, sqrt at e = 0.5
  const half = S.period(by, '2026-05-20', '2026-06-01', '2026-06-30', lySpend);
  ok('e = 1: revenue moves one-for-one with planned spend', near(half.revenue / same.revenue, 0.5, 1e-9));
  const e5 = S.period(by, '2026-05-20', '2026-06-01', '2026-06-30', lySpend, { elasticity: 0.5 });
  ok('e = 0.5: revenue moves with the square root of spend', near(e5.revenue / same.revenue, Math.SQRT1_2, 1e-9));
  const e0 = S.period(by, '2026-05-20', '2026-06-01', '2026-06-30', lySpend * 10, { elasticity: 0 });
  ok('e = 0: spend ignored', near(e0.revenue / lyRev, 1.5, 1e-9));
  ok('MER = revenue / spend', near(same.mer, same.revenue / same.spend, 1e-9));
}

/* --------------------------------------------------------------- refusals */
{
  const rows = books(1.5, 2), by = S.index(rows);
  ok('no last year for the period -> null', S.period(by, '2026-05-20', '2027-11-01', '2027-11-30', 1000) === null);
  ok('no last year for the trailing window -> null', S.period(by, '2025-06-20', '2025-07-01', '2025-07-31', 1000) === null);
  const pend = rows.map(r => r.date === '2026-05-20' ? Object.assign({}, r, { pending: true }) : r);
  ok('pending days are not learned from', S.index(pend)['2026-05-20'] === undefined);
}

/* --------------------------------------------------------------- P&L + band */
{
  const rows = books(1.5, 2);
  // spend well below trend, so elasticityUp does not apply and the band alone separates the cases
  const fc = S.forecast(rows, { from: '2026-05-20', band: { p10: -0.2, p95: 0.1 },
    periods: [{ name: 'Jun', start: '2026-06-01', end: '2026-06-30', spend: 3000 }] });
  const p = fc.periods[0], sc = p.scenarios;
  ok('contribution rate from the identity', near(fc.rates.contrib, 0.47, 1e-9), fc.rates.contrib);
  ok('fixed cost is the latest day, not a mean', fc.rates.fixedPerDay === 600);
  ok('profit = revenue x contrib - spend - fixed', near(sc.realistic.profit, sc.realistic.revenue * 0.47 - 3000 - 600 * 30, 1e-6));
  ok('band turned the right way: over-forecast at p95 -> pessimistic below', near(sc.pessimistic.revenue, p.revenue / 1.1, 1e-6));
  ok('under-forecast at p10 -> optimistic above', near(sc.optimistic.revenue, p.revenue / 0.8, 1e-6));
  ok('scenarios ordered', sc.pessimistic.revenue < sc.realistic.revenue && sc.realistic.revenue < sc.optimistic.revenue);

  // spend above trend: extra dollars work at 0.5 / 0.75 / 1 across the cases
  const up = S.forecast(rows, { from: '2026-05-20', band: {},
    periods: [{ name: 'Jun', start: '2026-06-01', end: '2026-06-30', spend: 120000, sale: true }] }).periods[0];
  const flat = S.period(S.index(rows), '2026-05-20', '2026-06-01', '2026-06-30', 120000, { elasticity: 0 }).revenue;
  const rel = up.yoySpendPlan / up.yoySpendNow;
  ok('above trend: realistic at e = 0.75', rel > 1 && near(up.scenarios.realistic.revenue, flat * Math.pow(rel, 0.75), 1e-6));
  ok('above trend: pessimistic at e = 0.5, optimistic at e = 1',
     near(up.scenarios.pessimistic.revenue, flat * Math.pow(rel, 0.5), 1e-6) && near(up.scenarios.optimistic.revenue, flat * rel, 1e-6));
  ok('pessimistic sale margin capped at 44.2%', near(up.scenarios.pessimistic.profit,
     up.scenarios.pessimistic.revenue * 0.442 - 120000 - 600 * 30, 1e-6));
  ok('realistic sale margin left at the measured rate', near(up.scenarios.realistic.profit,
     up.scenarios.realistic.revenue * 0.47 - 120000 - 600 * 30, 1e-6));
  const down = S.forecast(rows, { from: '2026-05-20', band: {},
    periods: [{ name: 'Jun', start: '2026-06-01', end: '2026-06-30', spend: 3000 }] }).periods[0];
  ok('below trend: a cut costs its full share in every case', near(down.scenarios.pessimistic.revenue, down.scenarios.optimistic.revenue, 1e-6));
}

/* --------------------------------------------------------------- sale dates */
/* BFCM 2025 (hype 16-17 Nov, sale 18 Nov - CM 1 Dec, 14 days) onto the 2026
   plan (hype 17-18 Nov, sale 19 Nov - Tue 1 Dec, 13 days). */
{
  const LY = { hype: ['2025-11-16', '2025-11-17'], sale: ['2025-11-18', '2025-12-01'], bf: '2025-11-28', cm: '2025-12-01' };
  const TY = { hype: ['2026-11-17', '2026-11-18'], sale: ['2026-11-19', '2026-12-01'], bf: '2026-11-27', cm: '2026-11-30' };
  const m = S.saleMap(LY, TY, { lastWeight: 1.5 });
  const one = d => { const p = m(d); return p && p.length === 1 && p[0].w === 1 ? p[0].date : p; };
  ok('hype day 1 <- last year\'s hype day 1', one('2026-11-17') === '2025-11-16', m('2026-11-17'));
  ok('the run-up lull moves with the hype', one('2026-11-15') === '2025-11-14');
  ok('before the run-up: plain 364-day match', m('2026-11-05') === null);
  ok('launch day <- last year\'s launch day', one('2026-11-19') === '2025-11-18');
  ok('launch day 2 <- last year\'s day 2', one('2026-11-20') === '2025-11-19');
  ok('Black Friday <- Black Friday', one('2026-11-27') === '2025-11-28');
  ok('the weekend after it <- the same weekend', one('2026-11-28') === '2025-11-29' && one('2026-11-29') === '2025-11-30');
  ok('Cyber Monday <- Cyber Monday', one('2026-11-30') === '2025-12-01');
  const mid = m('2026-11-23');
  ok('a middle day <- the average of 2025\'s eight middle days', mid.length === 8 && near(mid.reduce((s, p) => s + p.w, 0), 1, 1e-9) &&
     mid[0].date === '2025-11-20' && mid[7].date === '2025-11-27', mid);
  ok('the day after Cyber Monday <- 1.5 middle days', near(m('2026-12-01').reduce((s, p) => s + p.w, 0), 1.5, 1e-9));
  ok('after the sale: same calendar date', one('2026-12-25') === '2025-12-25' && one('2027-01-15') === '2026-01-15');
  // sale-equivalent length: 2 launch + 6 middle + BF + 2 weekend + CM + 1.5 = 13.5 of 2025's 14
  let w = 0; for (let d = TY.sale[0]; d <= TY.sale[1]; d = S.addDays(d, 1)) w += m(d).reduce((s, p) => s + p.w, 0);
  ok('a shorter sale books fewer middle days', near(w, 13.5, 1e-9), w);
}

/* --------------------------------------------------------------- spend plan */
{
  const plan = S.spendPlan(5000, [3500, 5600, 3080, 1540], 0.15);
  ok('increase trimmed by 15%', near(plan[0], 5000 * (1 + 0.85 * 0.6), 1e-6), plan[0]);
  ok('decrease kept as last year', near(plan[1], plan[0] * 0.55, 1e-6) && near(plan[2], plan[1] * 0.5, 1e-6));
  ok('trim 0 = last year\'s shape exactly', near(S.spendPlan(5000, [3500, 5600], 0)[0], 8000, 1e-6));
}

/* --------------------------------------------------------------- real books */
{
  const load = (file, key) => { const w = {}; new Function('window', fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))(w); return w[key]; };
  const prior = load('prior_year.js', 'DL_PRIOR'), data = load('data.js', 'DL_DATA');
  const rows = [...(prior.daily || []), ...(data.daily || [])];
  const bt = S.backtest(rows, { horizon: 30 });
  ok('real books: 30-day backtest has origins', bt && bt.n >= 100, bt && bt.n);
  // regression guard: measured 9.1% on data to 2026-10-25. Fails loudly if a change breaks the model.
  ok('real books: 30-day MAPE under 12%', bt && bt.mape < 0.12, bt && +bt.mape.toFixed(3));
  ok('real books: spend matters (e = 0 is worse)', S.backtest(rows, { horizon: 30, elasticity: 0 }).mape > bt.mape);
}

console.log(`forecast_simple: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
