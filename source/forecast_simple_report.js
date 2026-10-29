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

const SALE = {
  ly: { hype: ['2025-11-16', '2025-11-17'], sale: ['2025-11-18', '2025-12-01'], bf: '2025-11-28', cm: '2025-12-01' },
  ty: { hype: ['2026-11-17', '2026-11-18'], sale: ['2026-11-19', '2026-12-01'], bf: '2026-11-27', cm: '2026-11-30' },
};

function build(rows, opts) {
  const o = Object.assign({ saleSpend: 230000, trim: 0.15 }, opts);
  const by = S.index(rows);
  const from = o.from || Object.keys(by).sort().pop();
  const perDay = (a, b) => S.total(by, a, b, 'totalAds').sum / S.daysBetween(a, b);

  if (from >= '2027-01-31') throw new Error(`Data runs to ${from}: nothing left to forecast after 31 Jan 2027`);

  /* The plan is anchored on October, whatever day the data has reached: on
     22 Nov "the current month's spend" is the sale, not the base rate. */
  const ly = [perDay('2025-10-01', '2025-10-31'), perDay('2025-11-01', '2025-11-30'),
              perDay('2025-12-01', '2025-12-31'), perDay('2026-01-01', '2026-01-31')];
  const now = perDay('2026-10-01', from < '2026-10-31' ? from : '2026-10-31');
  const [, dec, jan] = S.spendPlan(now, ly, o.trim);

  /* Spend: October's rate until the hype, the sale budget across hype and sale
     (hype days at the Scale planner's 0.865% of budget each, sale days level),
     then last year's December and January drop. */
  const hypeDay = o.saleSpend * 2101 / 242893;
  const saleDays = S.daysBetween(SALE.ty.sale[0], SALE.ty.sale[1]);
  const saleDay = (o.saleSpend - 2 * hypeDay) / saleDays;
  const spendOn = d => d < SALE.ty.hype[0] ? now : d <= SALE.ty.hype[1] ? hypeDay : d <= SALE.ty.sale[1] ? saleDay
                     : d < '2027-01-01' ? dec : jan;
  const spend = (a, b) => { let s = 0; for (let d = a; d <= b; d = S.addDays(d, 1)) s += spendOn(d); return s; };

  /* Each stretch with its own spend is its own period, so a sale budget lifts
     the sale and not the quiet fortnight before it. Only the days after the
     newest one are forecast; a stretch already traded drops out. */
  const next = S.addDays(from, 1);
  const stretch = (name, start, end, sale) => {
    const s = start > next ? start : next;
    return s > end ? null : { name, start: s, end, spend: spend(s, end), sale: !!sale };
  };
  const plan = [
    stretch('Rest of Oct', '2026-10-01', '2026-10-31'),
    stretch('Nov 2026', '2026-11-01', S.addDays(SALE.ty.hype[0], -1)),
    stretch('Nov 2026', SALE.ty.hype[0], '2026-11-30', true),
    stretch('Dec 2026', '2026-12-01', SALE.ty.sale[1], true),
    stretch('Dec 2026', S.addDays(SALE.ty.sale[1], 1), '2026-12-31'),
    stretch('Jan 2027', '2027-01-01', '2027-01-31'),
  ].filter(Boolean);
  const fc = S.forecast(rows, { from, sale: SALE, periods: plan });
  fc.periods.forEach(p => { if (p.missing) throw new Error(p.name + ' ' + p.start + ': no last-year days to lean on'); });

  /* A line of the report = the days already traded, as booked, plus the
     forecast for the rest, in every case alike. */
  const line = (name, start, end, periods) => {
    const last = end < from ? end : from;
    const act = k => start <= last ? S.total(by, start, last, k).sum : 0;
    const m = { name, start, end, spend: act('totalAds'), revenue: act('revenue'), lastYearRevenue: 0, scenarios: {} };
    for (const k of ['pessimistic', 'realistic', 'optimistic'])
      m.scenarios[k] = { revenue: act('revenue'), revExGst: act('revExGst'), profit: act('profit') };
    periods.forEach(p => {
      m.spend += p.spend; m.revenue += p.revenue; m.lastYearRevenue += p.lastYearRevenue;
      for (const k in p.scenarios) {
        const t = m.scenarios[k];
        t.revenue += p.scenarios[k].revenue; t.revExGst += p.scenarios[k].revExGst; t.profit += p.scenarios[k].profit;
      }
    });
    return m;
  };
  const of = name => fc.periods.filter(p => p.name === name);
  const months = [];
  if (of('Rest of Oct').length) months.push(line('Rest of Oct', next, '2026-10-31', of('Rest of Oct')));
  months.push(line('Nov 2026', '2026-11-01', '2026-11-30', of('Nov 2026')),
              line('Dec 2026', '2026-12-01', '2026-12-31', of('Dec 2026')),
              line('Jan 2027', '2027-01-01', '2027-01-31', of('Jan 2027')));
  // the same stretches the months use, so the sale line and the months agree to the dollar
  months.push(line('Hype + sale, 17 Nov - 1 Dec', SALE.ty.hype[0], SALE.ty.sale[1], fc.periods.filter(p => p.sale)));
  return { from, fc, months, periods: fc.periods, rates: { now, hypeDay, saleDay, saleDays, dec, jan } };
}

function print(out) {
  const $ = v => (v < 0 ? '-$' : '$') + Math.round(Math.abs(v)).toLocaleString();
  const r = out.rates, fc = out.fc;
  console.log(`Data to ${out.from}. Spend/day: ${$(r.now)} to ${SALE.ty.hype[0]}, hype ${$(r.hypeDay)}, sale ${$(r.saleDay)} x ${r.saleDays} days, then Dec ${$(r.dec)}, Jan ${$(r.jan)}`);
  console.log(`Backtest (30d, actual spend): MAPE ${(fc.backtest.mape * 100).toFixed(1)}%, bias ${(fc.backtest.bias * 100).toFixed(1)}%, n=${fc.backtest.n}; ` +
              `pessimistic x${(1 / (1 + fc.band.p95)).toFixed(3)}, optimistic x${(1 / (1 + fc.band.p10)).toFixed(3)}`);
  out.months.forEach(p => {
    console.log(`\n${p.name}  spend ${$(p.spend)}  MER ${(p.revenue / p.spend).toFixed(2)}` +
                (p.start <= out.from ? `  (actual to ${out.from < p.end ? out.from : p.end})` : ''));
    for (const k of ['pessimistic', 'realistic', 'optimistic']) {
      const s = p.scenarios[k];
      console.log(`  ${k.padEnd(12)} revenue ${$(s.revenue).padStart(11)}  ex GST ${$(s.revExGst).padStart(11)}  profit ${$(s.profit).padStart(9)}`);
    }
  });
}

function loadRows() {
  const load = (file, key) => {
    const w = {}; new Function('window', fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))(w); return w[key];
  };
  const map = new Map();
  [...(load('prior_year.js', 'DL_PRIOR').daily || []), ...(load('data.js', 'DL_DATA').daily || [])]
    .forEach(d => d && d.date && map.set(d.date, d));
  return [...map.values()];
}

module.exports = { SALE, build, loadRows };

if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? +process.argv[i + 1] : d; };
  print(build(loadRows(), { saleSpend: arg('--sale-spend', 230000), trim: arg('--trim', 0.15) }));
}
