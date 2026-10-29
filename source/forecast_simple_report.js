/* Nov / Dec / Jan forecast from the spend-led model (forecast_simple.js).
   Run: node source/forecast_simple_report.js [--trim 0.15]

   Spend plan: last year's month-on-month change in daily ad spend, applied to
   this October's, with increases trimmed by --trim and decreases kept.
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
const [nov, dec, jan] = S.spendPlan(now, ly, arg('--trim', 0.15));

/* The month's spend falls across its days the way last year's did on the
   matched days, so the hype-and-sale window gets its share of the plan. */
const saleMap = S.saleMap(SALE.ly, SALE.ty, { lastWeight: 1.5 });
const lySpend = (a, b) => S.lastYear(by, a, b, 'totalAds', S.DEFAULTS.lag, saleMap).sum;
const windowSpend = nov * 30 * lySpend(SALE.ty.hype[0], '2026-11-30') / lySpend('2026-11-01', '2026-11-30')
                  + dec * 31 * lySpend('2026-12-01', '2026-12-01') / lySpend('2026-12-01', '2026-12-31');

const monthEnd = S.addDays(S.addDays(octStart, 40).slice(0, 7) + '-01', -1);
const fc = S.forecast(rows, { from, sale: SALE, periods: [
  { name: 'Rest of Oct', start: S.addDays(from, 1), end: monthEnd, spend: now * S.daysBetween(S.addDays(from, 1), monthEnd) },
  { name: 'Nov 2026', start: '2026-11-01', end: '2026-11-30', spend: nov * 30 },
  { name: 'Dec 2026', start: '2026-12-01', end: '2026-12-31', spend: dec * 31 },
  { name: 'Jan 2027', start: '2027-01-01', end: '2027-01-31', spend: jan * 31 },
  { name: 'Hype + sale, 17 Nov - 1 Dec', start: SALE.ty.hype[0], end: SALE.ty.sale[1], spend: windowSpend },
] });

const $ = v => (v < 0 ? '-$' : '$') + Math.round(Math.abs(v)).toLocaleString();
console.log(`Data to ${from}. Spend/day: Oct ${$(now)} -> Nov ${$(nov)}, Dec ${$(dec)}, Jan ${$(jan)}`);
console.log(`Backtest (30d, actual spend): MAPE ${(fc.backtest.mape * 100).toFixed(1)}%, bias ${(fc.backtest.bias * 100).toFixed(1)}%, n=${fc.backtest.n}; ` +
            `band x${(1 / (1 + fc.band.p90)).toFixed(3)} .. x${(1 / (1 + fc.band.p10)).toFixed(3)}`);
fc.periods.forEach(p => {
  if (p.missing) { console.log(p.name, ': no last-year days to lean on'); return; }
  console.log(`\n${p.name}  spend ${$(p.spend)}  MER ${p.mer.toFixed(2)}  last-year equivalent ${$(p.lastYearRevenue)}`);
  for (const k of ['pessimistic', 'realistic', 'optimistic']) {
    const s = p.scenarios[k];
    console.log(`  ${k.padEnd(12)} revenue ${$(s.revenue).padStart(11)}  ex GST ${$(s.revExGst).padStart(11)}  profit ${$(s.profit).padStart(9)}`);
  }
});
