/* Tests for source/forecast_simple_report.js — the Nov / Dec / Jan report.
   Run: node source/test_forecast_simple_report.js   (exit 0 = all pass)

   The data refreshes every day, so the report must stay right as the newest
   day moves through November, the sale and December: days already traded are
   actuals, only the days after the newest one are forecast, and the spend
   plan stays anchored on October rather than on whatever month is current.
   The "today" figures allow 1%, so a sheet restating an old day does not
   fail the build; a change to the model or the report moves them by more. */
const R = require('./forecast_simple_report.js');
const S = require('../forecast_simple.js');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}
const near = (a, b, t = 1) => a != null && b != null && Math.abs(a - b) < t;

const real = R.loadRows().filter(r => r.date <= '2026-10-25' && !r.pending);

/* Extend the book past today with invented days: last year's same weekday
   x 1.5, spending $6,000 a day ($20,000 on sale days). Only the shape matters. */
function extend(rows, to) {
  const by = S.index(rows), out = rows.slice();
  for (let d = '2026-10-26'; d <= to; d = S.addDays(d, 1)) {
    const ly = by[S.addDays(d, -364)];
    const rev = ly.revenue * 1.5, ads = d >= R.SALE.ty.sale[0] && d <= R.SALE.ty.sale[1] ? 20000 : 6000;
    out.push({ date: d, revenue: rev, totalAds: ads, revExGst: rev * 0.924, totalVC: rev * 0.45,
               totalFC: 2707, profit: rev * 0.474 - ads - 2707 });
  }
  return out;
}
const sum = (rows, a, b, k) => rows.filter(r => r.date >= a && r.date <= b).reduce((s, r) => s + r[k], 0);
const month = (out, name) => out.months.find(m => m.name === name);

/* ---------------------------------------------------- today: unchanged */
{
  const out = R.build(real);
  ok('today: forecast from the newest finished day', out.from === '2026-10-25', out.from);
  ok('today: pre-sale spend is October\'s rate', near(out.rates.now, sum(real, '2026-10-01', '2026-10-25', 'totalAds') / 25, 0.01));
  ok('today: Nov realistic as reported on 29 Oct', near(month(out, 'Nov 2026').scenarios.realistic.revenue, 1274404, 1274404 * 0.01),
     Math.round(month(out, 'Nov 2026').scenarios.realistic.revenue));
  ok('today: sale window realistic as reported (sum of the month stretches)', near(out.months.find(m => /Hype/.test(m.name)).scenarios.realistic.revenue, 1116105, 1116105 * 0.01));
  const nov = month(out, 'Nov 2026'), dec = month(out, 'Dec 2026'), win = out.months.find(m => /Hype/.test(m.name));
  ok('today: sale line = the sale stretches of Nov and Dec, to the dollar', near(win.scenarios.realistic.revenue,
     out.periods.filter(p => p.sale).reduce((s, p) => s + p.scenarios.realistic.revenue, 0), 0.01));
}

/* ---------------------------------------------------- 5 Nov: part of November traded */
{
  const rows = extend(real, '2026-11-05');
  const out = R.build(rows);
  ok('5 Nov: forecast from 5 Nov', out.from === '2026-11-05', out.from);
  ok('5 Nov: no forecast period starts on or before the newest day',
     out.periods.every(p => p.start > out.from), out.periods.map(p => p.start));
  ok('5 Nov: no "Rest of Oct" once October is over', !month(out, 'Rest of Oct'));
  ok('5 Nov: pre-sale spend still October\'s rate', near(out.rates.now, sum(rows, '2026-10-01', '2026-10-31', 'totalAds') / 31, 0.01),
     out.rates.now);
  const nov = month(out, 'Nov 2026'), act = sum(rows, '2026-11-01', '2026-11-05', 'revenue');
  const fcNov = out.periods.filter(p => p.name === 'Nov 2026');
  for (const k of ['pessimistic', 'realistic', 'optimistic']) {
    ok(`5 Nov: Nov ${k} = actual 1-5 Nov + forecast 6-30 Nov`,
       nov && near(nov.scenarios[k].revenue, act + fcNov.reduce((s, p) => s + p.scenarios[k].revenue, 0), 1));
  }
  ok('5 Nov: Nov spend = actual 1-5 Nov + plan 6-30 Nov',
     nov && near(nov.spend, sum(rows, '2026-11-01', '2026-11-05', 'totalAds') + fcNov.reduce((s, p) => s + p.spend, 0), 1));
}

/* ---------------------------------------------------- 22 Nov: inside the sale */
{
  const rows = extend(real, '2026-11-22');
  const out = R.build(rows);
  const win = out.months.find(m => /Hype/.test(m.name));
  const act = sum(rows, R.SALE.ty.hype[0], '2026-11-22', 'revenue');
  const fcWin = out.periods.filter(p => p.sale).reduce((s, p) => s + p.scenarios.realistic.revenue, 0);
  ok('22 Nov: the sale stretches are flagged', out.periods.some(p => p.sale));
  ok('22 Nov: sale window = actual so far + forecast for the rest', win && near(win.scenarios.realistic.revenue, act + fcWin, 1),
     win && [Math.round(win.scenarios.realistic.revenue), Math.round(act + fcWin)]);
  ok('22 Nov: every forecast period starts after the newest day',
     out.periods.every(p => p.start >= '2026-11-23'), out.periods.map(p => p.start));
  ok('22 Nov: pre-sale spend still October\'s rate', near(out.rates.now, sum(rows, '2026-10-01', '2026-10-31', 'totalAds') / 31, 0.01));
}

/* ---------------------------------------------------- after January: nothing left */
{
  const rows = extend(real, '2027-01-31');
  let threw = null;
  try { R.build(rows); } catch (e) { threw = e.message; }
  ok('after 31 Jan: refuses with a reason rather than forecasting the past', /nothing left|after/i.test(threw || ''), threw);
}

console.log(`forecast_simple_report: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
