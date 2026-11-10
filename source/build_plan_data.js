/* FY27 Plan page data — the forecast part of the forecast report.
   Run: node source/build_plan_data.js [--from 2026-10-31]   (writes plan_data.js)

   A snapshot, rebuilt at each quarterly reforecast: the page shows the forecast
   as it stood at the snapshot date, paces the month in progress against it and
   tracks the quarterly profit targets from the live data. The forecast is the
   spend-led model (forecast_simple.js) with the BFCM 2026 plan
   (source/forecast_simple_report.js).

   Personal terms (the bonus) are deliberately not in here: this file is
   committed and the page is shared with the team. */
const S = require('../forecast_simple.js');
const R = require('./forecast_simple_report.js');
const fs = require('fs'), path = require('path');

/* Last year's quarters, read from the books rather than typed in: the sheet
   restates closed days (Q3 FY26 moved by $1,285 after 7 Oct 2026). */
const FY26_QUARTERS = { Q1: ['2025-07-01', '2025-09-30'], Q2: ['2025-10-01', '2025-12-31'],
                        Q3: ['2026-01-01', '2026-03-31'], Q4: ['2026-04-01', '2026-06-30'] };
const QUARTERS = { Q1: ['2026-07-01', '2026-09-30'], Q2: ['2026-10-01', '2026-12-31'],
                   Q3: ['2027-01-01', '2027-03-31'], Q4: ['2027-04-01', '2027-06-30'] };
const CASES = ['pessimistic', 'realistic', 'optimistic'];
/* Quarterly profit targets (proposal agreed on the 31 Oct 2026 snapshot): the
   realistic case, counted year to date from 1 October; the stretch sits 40%
   above it; year-to-date sales must stay at or above 85% of plan. */
const TARGET_QUARTERS = ['Q2', 'Q3', 'Q4'];
const STRETCH = 1.4, SALES_FLOOR = 0.85;
const monthEnd = m => S.addDays(S.addDays(m + '-01', 32).slice(0, 7) + '-01', -1);
const r0 = v => Math.round(v);

function build(allRows, from) {
  const rows = allRows.filter(r => r.date <= from);
  const by = S.index(rows);
  const T = (a, b, k) => S.total(by, a, b, k).sum;
  const FY26 = { q: {} };
  for (const q in FY26_QUARTERS) FY26.q[q] = [r0(T(...FY26_QUARTERS[q], 'revExGst')), r0(T(...FY26_QUARTERS[q], 'profit'))];
  FY26.revExGst = Object.values(FY26.q).reduce((s, v) => s + v[0], 0);
  FY26.profit = Object.values(FY26.q).reduce((s, v) => s + v[1], 0);
  const month = from.slice(0, 7);
  const lyMonth = (+month.slice(0, 4) - 1) + month.slice(4);

  /* The month just closed, against the same month last year. */
  const closed = m => ({ revenue: r0(T(m + '-01', monthEnd(m), 'revenue')), adSpend: r0(T(m + '-01', monthEnd(m), 'totalAds')),
                         orders: r0(T(m + '-01', monthEnd(m), 'orders')), profit: r0(T(m + '-01', monthEnd(m), 'profit')) });
  const lastMonth = { month, actual: closed(month), lastYear: closed(lyMonth) };

  /* The forecast from month end: Nov, Dec, Jan and the sale, by case. */
  const rep = R.build(rows, { from });
  const months = rep.months.filter(m => !/^Rest of/.test(m.name)).map(m => {
    const sale = /Hype/.test(m.name);
    const [a, b] = sale ? [R.SALE.ly.hype[0], R.SALE.ly.sale[1]] : (() => { const s = m.start.slice(0, 7); const ly = (+s.slice(0, 4) - 1) + s.slice(4); return [ly + '-01', monthEnd(ly)]; })();
    return { name: m.name, start: m.start, end: m.end, adSpend: r0(m.spend),
             lastYear: { revenue: r0(T(a, b, 'revenue')), profit: r0(T(a, b, 'profit')) },
             cases: Object.fromEntries(CASES.map(k => [k, { revenue: r0(m.scenarios[k].revenue), profit: r0(m.scenarios[k].profit) }])) };
  });

  /* Each forecast day, so the page can pace the month in progress from live
     data: a stretch's forecast spread over its days in proportion to the
     matching days last year. */
  const map = S.saleMap(R.SALE.ly, R.SALE.ty, { lastWeight: 1.5 });
  const daily = [];
  rep.periods.forEach(p => {
    const w = [];
    for (let d = p.start; d <= p.end; d = S.addDays(d, 1)) w.push([d, S.lastYear(by, d, d, 'revenue', S.DEFAULTS.lag, map).sum]);
    const tot = w.reduce((s, x) => s + x[1], 0) || 1;
    w.forEach(([d, v]) => daily.push([d, ...CASES.map(k => r0(p.scenarios[k].revenue * v / tot))]));
  });

  /* FY27 by quarter, ex GST: actuals to date, the report's stretches, then
     Feb-Jun on last year's spend pattern (increases trimmed 15%). */
  const perDay = (a, b) => T(a, b, 'totalAds') / S.daysBetween(a, b);
  const lyH = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'].map(m => perDay(m + '-01', monthEnd(m)));
  const plan = S.spendPlan(rep.rates.jan, lyH, 0.15);
  const late = S.forecast(rows, { from, band: rep.fc.band, periods: ['2027-02', '2027-03', '2027-04', '2027-05', '2027-06']
    .map((m, i) => ({ name: m, start: m + '-01', end: monthEnd(m), spend: plan[i] * S.daysBetween(m + '-01', monthEnd(m)) })) }).periods;
  const qOf = d => Object.keys(QUARTERS).find(q => d >= QUARTERS[q][0] && d <= QUARTERS[q][1]);
  const fy = {};
  CASES.forEach(k => {
    fy[k] = {};
    for (const q in QUARTERS) {
      const a = QUARTERS[q][0], b = QUARTERS[q][1] < from ? QUARTERS[q][1] : from;
      fy[k][q] = { revExGst: a <= b ? T(a, b, 'revExGst') : 0, profit: a <= b ? T(a, b, 'profit') : 0 };
    }
  });
  [...rep.periods, ...late].forEach(p => {
    if (p.missing) throw new Error(p.name + ': no last-year days to lean on');
    const q = qOf(p.start);
    CASES.forEach(k => { fy[k][q].revExGst += p.scenarios[k].revExGst; fy[k][q].profit += p.scenarios[k].profit; });
  });
  CASES.forEach(k => {
    for (const q in QUARTERS) { fy[k][q].revExGst = r0(fy[k][q].revExGst); fy[k][q].profit = r0(fy[k][q].profit); }
    fy[k].FY = { revExGst: Object.keys(QUARTERS).reduce((s, q) => s + fy[k][q].revExGst, 0),
                 profit: Object.keys(QUARTERS).reduce((s, q) => s + fy[k][q].profit, 0) };
  });

  /* Quarterly profit targets, year to date from 1 October, with last year's
     same stretch for reference. */
  const targets = [];
  TARGET_QUARTERS.forEach((q, i) => {
    const prev = targets[i - 1] || { profit: 0, sales: 0, lastYear: 0 };
    const profit = prev.profit + fy.realistic[q].profit, sales = prev.sales + fy.realistic[q].revExGst;
    targets.push({ q, start: QUARTERS.Q2[0], qStart: QUARTERS[q][0], end: QUARTERS[q][1],
                   quarter: fy.realistic[q].profit, profit, sales, stretch: r0(profit * STRETCH), salesFloor: r0(sales * SALES_FLOOR),
                   lastYear: prev.lastYear + FY26.q[q][1] });
  });
  targets.forEach(t => { delete t.sales; });

  /* Growth now and what it is worth: the forecast holds today's same-day
     growth for every forecast day, so a fade is the main risk to Nov-Jan. */
  const growth = rep.periods[0].yoyRevenue;
  const nearMonths = months.filter(m => !/Hype/.test(m.name));
  const growthSensitivity = r0(nearMonths.reduce((s, m) => s + m.cases.realistic.revenue, 0) * rep.fc.rates.contrib * 0.1 / growth);

  const bt = rep.fc.backtest;
  return {
    meta: { asOf: from, builtOn: new Date().toISOString().slice(0, 10) },
    asOf: from, builtFrom: 'forecast_simple.js · source/build_plan_data.js',
    lastMonth, months, daily, fy, fy26: FY26, targets, growthSensitivity,
    spendPlan: { preSale: r0(rep.rates.now), hype: r0(rep.rates.hypeDay), sale: r0(rep.rates.saleDay), saleDays: rep.rates.saleDays,
                 dec: r0(rep.rates.dec), jan: r0(rep.rates.jan), febToJun: plan.map(r0), saleBudget: 230000 },
    accuracy: { mape30: +bt.mape.toFixed(4), bias30: +bt.bias.toFixed(4), n30: bt.n,
                pessimisticBelow: +(1 - 1 / (1 + bt.p95)).toFixed(4), optimisticAbove: +(1 / (1 + bt.p10) - 1).toFixed(4) },
    rates: { contribution: +rep.fc.rates.contrib.toFixed(4), fixedPerDay: r0(rep.fc.rates.fixedPerDay), growth: +growth.toFixed(3) },
    sale: R.SALE.ty,
  };
}

module.exports = { build };

if (require.main === module) {
  const i = process.argv.indexOf('--from');
  const rows = R.loadRows();
  const by = S.index(rows);
  const from = i > -1 ? process.argv[i + 1] : Object.keys(by).sort().pop();
  const out = build(rows, from);
  const file = path.join(__dirname, '..', 'plan_data.js');
  fs.writeFileSync(file, '// Auto-generated by source/build_plan_data.js. Do not hand-edit.\n' +
    `// Forecast as at ${from}; rebuild at each quarterly reforecast.\n` +
    'window.DL_PLAN = ' + JSON.stringify(out) + ';\n');
  console.log(`plan_data.js written: forecast as at ${from}, ${out.daily.length} forecast days`);
}
