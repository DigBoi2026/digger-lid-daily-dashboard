/* Tests for the FY27 Plan page: source/build_plan_data.js and plan.js's pace().
   Run: node source/test_plan_data.js   (exit 0 = all pass) */
const B = require('./build_plan_data.js');
const R = require('./forecast_simple_report.js');
const { pace } = require('../plan.js');
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}
const near = (a, b, t = 2) => Math.abs(a - b) <= t;
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

/* ---------------------------------------------------- the builder, end of October */
const rows = R.loadRows();
const p = B.build(rows, '2026-10-31');
ok('as at the date asked', p.asOf === '2026-10-31');
ok('last month is October, against October last year', p.lastMonth.month === '2026-10' && p.lastMonth.lastYear.revenue > 0);
ok('scorecard made the day before the month began', p.scorecard.madeOn === '2026-09-30');
ok('scorecard: spend-led cases ordered', p.scorecard.spendLed.pessimistic.revenue < p.scorecard.spendLed.realistic.revenue &&
   p.scorecard.spendLed.realistic.revenue < p.scorecard.spendLed.optimistic.revenue);
ok('three months and the sale, nothing for October', p.months.length === 4 && !p.months.some(m => /Oct/.test(m.name)), p.months.map(m => m.name));
ok('cases ordered in every month', p.months.every(m => m.cases.pessimistic.revenue < m.cases.realistic.revenue && m.cases.realistic.revenue < m.cases.optimistic.revenue));
const dayTot = (a, b, i) => sum(p.daily.filter(d => d[0] >= a && d[0] <= b), d => d[i]);
for (const m of p.months.filter(m => !/Hype/.test(m.name)))
  ok(`daily forecast adds up to ${m.name}, every case`, [1, 2, 3].every(i => near(dayTot(m.start, m.end, i), m.cases[['pessimistic', 'realistic', 'optimistic'][i - 1]].revenue, 3)));
const sale = p.months.find(m => /Hype/.test(m.name));
ok('the sale line is the same days as the months', near(dayTot(sale.start, sale.end, 2), sale.cases.realistic.revenue, 3));
ok('forecast days run 1 Nov to 31 Jan, once each', p.daily.length === 92 && p.daily[0][0] === '2026-11-01' && p.daily.at(-1)[0] === '2027-01-31');
for (const c of ['pessimistic', 'realistic', 'optimistic'])
  ok(`FY27 ${c} = its quarters`, p.fy[c].FY.profit === sum(['Q1', 'Q2', 'Q3', 'Q4'], q => p.fy[c][q].profit));
ok('Q1 is actual in every case', p.fy.pessimistic.Q1.profit === p.fy.optimistic.Q1.profit);
ok('accuracy carried from the backtest', p.accuracy.n30 >= 100 && p.accuracy.mape30 > 0 && p.accuracy.mape30 < 0.15);
ok('the committed snapshot carries no personal terms', !/bonus|hurdle|payout/i.test(JSON.stringify(p)));

/* ---------------------------------------------------- the committed file */
{
  const w = {}; new Function('window', fs.readFileSync(path.join(__dirname, '..', 'plan_data.js'), 'utf8'))(w);
  ok('plan_data.js parses and declares its date', w.DL_PLAN && /^\d{4}-\d{2}-\d{2}$/.test(w.DL_PLAN.asOf));
  ok('plan_data.js carries no personal terms', !/bonus|hurdle|payout/i.test(JSON.stringify(w.DL_PLAN)));
}

/* ---------------------------------------------------- pace of the month in progress */
{
  const plan = { asOf: '2026-10-31', daily: [['2026-11-01', 80, 100, 120], ['2026-11-02', 80, 100, 120], ['2026-11-03', 80, 100, 120]] };
  ok('no days after the snapshot: no pace', pace(plan, [{ date: '2026-10-31', revenue: 500 }]) === null);
  const a = pace(plan, [{ date: '2026-11-01', revenue: 110 }, { date: '2026-11-02', revenue: 100 }]);
  ok('pace sums actual and forecast over the same days', a.days === 2 && a.actual === 210 && a.realistic === 200 && near(a.vsRealistic, 0.05, 1e-9));
  ok('inside the range', a.band === 'inside');
  ok('a pending day is not counted', pace(plan, [{ date: '2026-11-01', revenue: 110 }, { date: '2026-11-02', revenue: 999, pending: true }]).days === 1);
  ok('below the range', pace(plan, [{ date: '2026-11-01', revenue: 70 }]).band === 'below');
  ok('above the range', pace(plan, [{ date: '2026-11-01', revenue: 130 }]).band === 'above');
  ok('a day outside the forecast is ignored', pace(plan, [{ date: '2027-03-01', revenue: 130 }]) === null);
}

console.log(`plan_data: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
