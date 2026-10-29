/* Nov / Dec / Jan forecast from the spend-led model (forecast_simple.js).
   Run: node source/forecast_simple_report.js [--sale-spend 230000] [--trim 0.15]

   Spend: October's daily rate until the hype; the sale budget (--sale-spend,
   $230K per the Sale Plan) across hype and sale; then December and January
   follow last year's month-on-month fall from October's rate (--trim cuts
   last year's increases, of which there are none after November).
   Sale dates: the BFCM 2026 Sale Plan (Oct 2026). Hype Tue 17 and Wed 18
   Nov; sale Thu 19 Nov midday to Tue 1 Dec 11:59 PM, 13 days, Black Friday
   on day 9 and Cyber Monday on day 12. 2025 ran hype 16-17 Nov and the sale
   18 Nov to Cyber Monday 1 Dec, 14 days. */
const S = require('../forecast_simple.js');
const fs = require('fs'), path = require('path');
function loadGlobal(file, key) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const w = {}; new Function('window', src)(w); return w[key];
}
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? +process.argv[i + 1] : d; };
const prior = loadGlobal('prior_year.js', 'DL_PRIOR'), data = loadGlobal('data.js', 'DL_DATA');
const map = new Map();
[...(prior.daily || []), ...(data.daily || [])].forEach(d => d && d.date && map.set(d.date, d));
const rows = [...map.values()];
const by = S.index(rows);
const from = Object.keys(by).sort().pop();
const perDay = (a, b) => S.total(by, a, b, 'totalAds').sum / S.daysBetween(a, b);

const SALE = {
  ly: { hype: ['2025-11-16', '2025-11-17'], sale: ['2025-11-18', '2025-12-01'], bf: '2025-11-28', cm: '2025-12-01' },
  ty: { hype: ['2026-11-17', '2026-11-18'], sale: ['2026-11-19', '2026-12-01'], bf: '2026-11-27', cm: '2026-11-30' },
};

const octStart = from.slice(0, 7) + '-01';
const ly = [perDay('2025-10-01', '2025-10-31'), perDay('2025-11-01', '2025-11-30'),
            perDay('2025-12-01', '2025-12-31'), perDay('2026-01-01', '2026-01-31')];
const now = perDay(octStart, from);
const [, dec, jan] = S.spendPlan(now, ly, arg('--trim', 0.15));

/* Spend: October's rate until the hype, the sale budget across hype and sale
   (hype days at the Scale planner's 0.865% of budget each, sale days level),
   then last year's December and January drop. */
const saleBudget = arg('--sale-spend', 230000);
const hypeDay = saleBudget * 2101 / 242893;
const saleDays = S.daysBetween(SALE.ty.sale[0], SALE.ty.sale[1]);
const saleDay = (saleBudget - 2 * hypeDay) / saleDays;
const spendOn = d => d < SALE.ty.hype[0] ? now : d <= SALE.ty.hype[1] ? hypeDay : d <= SALE.ty.sale[1] ? saleDay
                   : d < '2027-01-01' ? dec : jan;
const spend = (a, b) => { let s = 0; for (let d = a; d <= b; d = S.addDays(d, 1)) s += spendOn(d); return s; };

/* Each stretch with its own spend is its own period, so a sale budget lifts
   the sale and not the quiet fortnight before it. */
const monthEnd = S.addDays(S.addDays(octStart, 40).slice(0, 7) + '-01', -1);
const stretch = (month, start, end) => ({ name: month, start, end, spend: spend(start, end) });
const fc = S.forecast(rows, { from, sale: SALE, periods: [
  stretch('Rest of Oct', S.addDays(from, 1), monthEnd),
  stretch('Nov 2026', '2026-11-01', S.addDays(SALE.ty.hype[0], -1)),
  stretch('Nov 2026', SALE.ty.hype[0], '2026-11-30'),
  stretch('Dec 2026', '2026-12-01', SALE.ty.sale[1]),
  stretch('Dec 2026', S.addDays(SALE.ty.sale[1], 1), '2026-12-31'),
  stretch('Jan 2027', '2027-01-01', '2027-01-31'),
] });
const win = S.forecast(rows, { from, sale: SALE, band: fc.band, periods: [
  stretch('Hype + sale, 17 Nov - 1 Dec', SALE.ty.hype[0], SALE.ty.sale[1])] }).periods[0];

/* Add the stretches back up into months. */
const months = [];
fc.periods.forEach(p => {
  if (p.missing) throw new Error(p.name + ' ' + p.start + ': no last-year days to lean on');
  let m = months.find(x => x.name === p.name);
  if (!m) months.push(m = { name: p.name, spend: 0, revenue: 0, lastYearRevenue: 0, scenarios: {} });
  m.spend += p.spend; m.revenue += p.revenue; m.lastYearRevenue += p.lastYearRevenue;
  for (const k in p.scenarios) {
    const t = m.scenarios[k] || (m.scenarios[k] = { revenue: 0, revExGst: 0, profit: 0 });
    t.revenue += p.scenarios[k].revenue; t.revExGst += p.scenarios[k].revExGst; t.profit += p.scenarios[k].profit;
  }
});
months.push(Object.assign(win, { name: win.name }));

const $ = v => (v < 0 ? '-$' : '$') + Math.round(Math.abs(v)).toLocaleString();
console.log(`Data to ${from}. Spend/day: ${$(now)} to ${SALE.ty.hype[0]}, hype ${$(hypeDay)}, sale ${$(saleDay)} x ${saleDays} days, then Dec ${$(dec)}, Jan ${$(jan)}`);
console.log(`Backtest (30d, actual spend): MAPE ${(fc.backtest.mape * 100).toFixed(1)}%, bias ${(fc.backtest.bias * 100).toFixed(1)}%, n=${fc.backtest.n}; ` +
            `band x${(1 / (1 + fc.band.p90)).toFixed(3)} .. x${(1 / (1 + fc.band.p10)).toFixed(3)}`);
months.forEach(p => {
  console.log(`\n${p.name}  spend ${$(p.spend)}  MER ${(p.revenue / p.spend).toFixed(2)}  last-year equivalent ${$(p.lastYearRevenue)}`);
  for (const k of ['pessimistic', 'realistic', 'optimistic']) {
    const s = p.scenarios[k];
    console.log(`  ${k.padEnd(12)} revenue ${$(s.revenue).padStart(11)}  ex GST ${$(s.revExGst).padStart(11)}  profit ${$(s.profit).padStart(9)}`);
  }
});
