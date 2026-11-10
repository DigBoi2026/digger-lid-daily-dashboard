/* Tests for the FY27 Plan page: source/build_plan_data.js and plan.js's pace().
   Run: node source/test_plan_data.js   (exit 0 = all pass) */
const B = require('./build_plan_data.js');
const R = require('./forecast_simple_report.js');
const { pace, targetStatus } = require('../plan.js');
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
ok('no old-engine scorecard', p.scorecard === undefined);

/* Quarterly profit targets: the realistic case, year to date from 1 October. */
const tg = p.targets || [];
ok('three targets, Q2 to Q4', tg.map(t => t.q).join() === 'Q2,Q3,Q4', tg.map(t => t.q));
ok('every target counts from 1 October', tg.every(t => t.start === '2026-10-01'));
ok('target = realistic profit to date', tg.length === 3 &&
   tg[0].profit === p.fy.realistic.Q2.profit &&
   tg[1].profit === p.fy.realistic.Q2.profit + p.fy.realistic.Q3.profit &&
   tg[2].profit === p.fy.realistic.Q2.profit + p.fy.realistic.Q3.profit + p.fy.realistic.Q4.profit, tg.map(t => t.profit));
ok('stretch is the target + 40%', tg.every(t => Math.abs(t.stretch - t.profit * 1.4) <= 1), tg.map(t => [t.profit, t.stretch]));
ok('sales floor is 85% of realistic sales to date', tg.length === 3 &&
   near(tg[2].salesFloor, 0.85 * (p.fy.realistic.Q2.revExGst + p.fy.realistic.Q3.revExGst + p.fy.realistic.Q4.revExGst), 1), tg.map(t => t.salesFloor));
ok('targets as agreed at 31 Oct', tg.map(t => t.profit).join() === '215145,257047,474957', tg.map(t => t.profit));
ok('last year to date for reference', tg.length === 3 && tg[0].lastYear === p.fy26.q.Q2[1] && tg[1].lastYear === p.fy26.q.Q2[1] + p.fy26.q.Q3[1]);
ok('growth rate carried for the risk note', p.rates.growth > 1 && p.rates.growth < 2 && p.growthSensitivity > 0, [p.rates.growth, p.growthSensitivity]);
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
ok('FY26 read from the books and adds up', p.fy26.revExGst === sum(Object.values(p.fy26.q), v => v[0]) && p.fy26.revExGst > 4e6);
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

/* ---------------------------------------------------- profit targets against the books */
{
  const plan = { targets: [
    { q: 'Q2', start: '2026-10-01', qStart: '2026-10-01', end: '2026-12-31', profit: 100, stretch: 140, salesFloor: 500 },
    { q: 'Q3', start: '2026-10-01', qStart: '2027-01-01', end: '2027-03-31', profit: 200, stretch: 280, salesFloor: 900 } ] };
  const day = (date, profit, revExGst, pending) => ({ date, revenue: revExGst * 1.1, revExGst, profit, pending });
  const s = targetStatus(plan, [day('2026-10-01', 30, 200), day('2026-11-01', 20, 200), day('2026-11-02', 999, 999, true)]);
  ok('quarter in progress sums profit and sales to date', s[0].status === 'in progress' && s[0].actual === 50 && s[0].sales === 400 && s[0].through === '2026-11-01', s[0]);
  ok('a pending day is not counted', s[0].days === 2);
  ok('next quarter not started yet', s[1].status === 'not started', s[1].status);
  const met = targetStatus(plan, [day('2026-10-01', 60, 300), day('2026-12-31', 50, 300)]);
  ok('closed quarter at target: met', met[0].status === 'met', met[0].status);
  const beat = targetStatus(plan, [day('2026-10-01', 100, 300), day('2026-12-31', 50, 300)]);
  ok('closed quarter past the stretch: beat stretch', beat[0].status === 'beat stretch', beat[0].status);
  const miss = targetStatus(plan, [day('2026-10-01', 10, 300), day('2026-12-31', 10, 300)]);
  ok('closed quarter under target: missed', miss[0].status === 'missed', miss[0].status);
  const floor = targetStatus(plan, [day('2026-10-01', 200, 100), day('2026-12-31', 10, 100)]);
  ok('profit met but sales under the floor', floor[0].status === 'below sales floor', floor[0].status);
  ok('no data, no crash', targetStatus(plan, null)[0].status === 'not started');
  ok('no targets in the plan, empty list', targetStatus({}, []).length === 0);
}

console.log(`plan_data: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
