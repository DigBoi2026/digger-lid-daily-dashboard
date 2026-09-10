#!/usr/bin/env node
/* Compute the current forecast and dump everything behind it as JSON, ready for
   source/export_forecast.py to render into a workbook.

   Split in two on purpose: the model is JavaScript because the board runs it in
   a browser, and a second implementation in Python would be a second set of
   answers to the same question. So this half runs the SAME forecast.js the page
   runs — same fits, same sale periods, same identity — and the Python half only
   formats what it is handed.

   Usage:
     node source/export_forecast.js [--live live.json] [--out bundle.json]
                                    [--from YYYY-MM-DD] [--to YYYY-MM-DD]
   With --live, rows from a saved /api/data response are merged over the
   committed snapshot, so the export is as current as the sheet. */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const F = require(path.join(ROOT, 'forecast.js'));

function argOf(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function loadGlobal(file, key) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const w = {};
  new Function('window', src)(w);
  return w[key];
}

const PRIOR = loadGlobal('prior_year.js', 'DL_PRIOR');
const DATA = loadGlobal('data.js', 'DL_DATA');
const live = argOf('live') ? JSON.parse(fs.readFileSync(argOf('live'), 'utf8')) : null;

/* Same merge order as the page: 2025 is static, the committed 2026 snapshot
   underneath, a live pull on top where one is supplied. */
const map = new Map();
[(PRIOR.daily || []), (DATA.daily || []), (live && live.daily) || []]
  .forEach(list => list.forEach(d => { if (d && d.date) map.set(d.date, d); }));
const ALL = [...map.values()].filter(d => d.revenue > 0).sort((a, b) => a.date < b.date ? -1 : 1);
if (!ALL.length) { console.error('no rows'); process.exit(1); }

/* The forecast origin is the last COMPLETE day, never simply the newest: a day
   with revenue typed but ad spend not yet is a real day of trade with a
   fictional cost side, and anchoring on it would export the fiction. */
function anchor() {
  const cap = argOf('from') || ((live && live.meta && live.meta.latestDataDate) || DATA.meta.latestDataDate);
  for (let i = ALL.length - 1; i >= 0; i--) if (ALL[i].date <= cap && !ALL[i].pending) return ALL[i].date;
  return ALL[ALL.length - 1].date;
}
const from = anchor();
const to = argOf('to', from.slice(0, 4) + '-12-31');
const horizon = Math.max(1, Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000));

const years = new Set(ALL.map(r => r.date.slice(0, 4)));
years.add(String(+from.slice(0, 4) + 1));
const sale = F.salePeriodModifiers(ALL, { years: [...years].sort() });
const ceiling = F.observedCeiling(ALL);

const runs = {};
['pessimistic', 'realistic', 'optimistic'].forEach(sc => {
  runs[sc] = F.projectPnl({ rows: ALL, from, horizon, scenario: sc,
                            modifiers: sale, observedCeiling: ceiling });
});
const bt = F.backtest(ALL, { model: { scenario: 'realistic', modifiers: sale } });
const R = runs.realistic;

/* Same dates last year, never the same month — a 22-day stub of September
   against a whole September once read a +132% month as -32%. */
const byDate = {}; ALL.forEach(r => byDate[r.date] = r.revenue);
const yearBefore = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCFullYear(t.getUTCFullYear() - 1); return t.toISOString().slice(0, 10); };
function priorSame(a, b) {
  let s = 0, n = 0, miss = 0;
  for (let d = a; d <= b; d = F.addDays(d, 1)) {
    const v = byDate[yearBefore(d)];
    if (v != null) { s += v; n++; } else miss++;
  }
  return { sum: n ? s : null, days: n, missing: miss };
}

const bundle = {
  meta: {
    generated: new Date().toISOString(),
    source: (live && live.meta && live.meta.source) || DATA.meta.source,
    priorSource: PRIOR.meta.source,
    dataThrough: ALL[ALL.length - 1].date,
    live: !!live,
    from, to, horizon,
    pendingTail: ALL.filter(r => r.pending).map(r => r.date),
    monthsMissing: PRIOR.meta.monthsMissing || [],
  },
  headline: ['pessimistic', 'realistic', 'optimistic'].map(sc => {
    const p = runs[sc], ly = priorSame(F.addDays(from, 1), F.addDays(from, horizon));
    return { scenario: sc, revenue: p.total, adSpend: p.adSpend, profit: p.profit,
             margin: p.total ? p.profit / p.total : null,
             mer: p.adSpend ? p.total / p.adSpend : null,
             priorYear: ly.sum, vsPriorYear: ly.sum ? p.total / ly.sum : null,
             breakevenPerDay: p.breakevenPerDay };
  }),
  months: R.months.map(m => {
    const ds = R.days.filter(d => d.month === m.month);
    const ly = priorSame(ds[0].date, ds[ds.length - 1].date);
    const row = { month: m.month, days: m.days,
                  seasonIndex: m.seasonIndex || R.basis.season.index[+m.month.slice(5, 7)],
                  yearsObserved: R.basis.season.observations[+m.month.slice(5, 7)] || 0,
                  priorYearSameDates: ly.sum };
    ['pessimistic', 'realistic', 'optimistic'].forEach(sc => {
      const mm = runs[sc].months.find(x => x.month === m.month);
      row[sc + 'Revenue'] = mm.revenue; row[sc + 'Profit'] = mm.profit;
    });
    row.adSpend = m.adSpend; row.fixedCost = m.fixed; row.margin = m.margin; row.mer = m.mer;
    row.vsPriorYear = ly.sum ? m.revenue / ly.sum : null;
    return row;
  }),
  daily: R.days.map((d, i) => ({
    date: d.date, dow: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][F.dow(d.date)],
    pessimistic: runs.pessimistic.days[i].revenue,
    realistic: d.revenue,
    optimistic: runs.optimistic.days[i].revenue,
    adSpend: d.adSpend, profit: d.profit,
    seasonIndex: d.seasonIndex, modifier: R.modifierEffect.at(d.date),
    priorYearSameDate: byDate[yearBefore(d.date)] != null ? byDate[yearBefore(d.date)] : null,
    yearsObserved: d.observations,
  })),
  actuals: ALL.map(r => ({
    date: r.date, dow: r.dow || null, revenue: r.revenue, revExGst: r.revExGst,
    orders: r.orders, sessions: r.sessions, aov: r.aov, cvr: r.cvr,
    totalAds: r.totalAds, mer: r.mer, roas: r.roas,
    totalVC: r.totalVC, totalFC: r.totalFC, totalExp: r.totalExp,
    profit: r.profit, profitPct: r.profitPct,
    pending: r.pending ? r.pending.join(' + ') : null,
  })),
  basis: {
    level: R.level, drift: R.drift, driftAnnual: Math.pow(R.drift, 365 / 28),
    priorWeight: R.priorWeight,
    growth: R.basis.growth,
    yearLevel: R.basis.season.yearLevel,
    seasonIndex: R.basis.season.index,
    seasonObservations: R.basis.season.observations,
    dowIndex: R.basis.dowIdx,
    pnl: R.pnl,
    observedCeiling: ceiling,
    accuracy: bt,
  },
  salePeriods: sale.map(m => ({
    key: m.key, name: m.name, start: m.start, end: m.end,
    lift: m.lift, payback: m.payback, paybackEnd: m.paybackEnd,
    measuredIn: m.measured.from, ownMeasurement: m.measured.own,
    measuredLift: m.measured.lift, pulledForward: m.measured.pulled,
    profile: (m.profile || []).map(o => ({ date: o.date, lift: o.lift })),
    allYears: (m.measured.allYears || []).map(y => ({ year: y.year, day: y.day,
      lift: y.lift, payback: y.payback, paybackDays: y.paybackDays,
      baseline: y.baseline, paybackDaysObserved: y.paybackObserved })),
  })),
  yoyByMonth: (() => {
    const m = {};
    ALL.forEach(r => { const k = r.date.slice(0, 7); (m[k] = m[k] || { sum: 0, days: 0 }); m[k].sum += r.revenue; m[k].days++; });
    const dim = k => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 0)).getUTCDate();
    return Object.keys(m).sort().map(k => {
      const prev = (+k.slice(0, 4) - 1) + k.slice(4);
      return { month: k, days: m[k].days, complete: m[k].days >= dim(k), revenue: m[k].sum,
               priorYear: m[prev] ? m[prev].sum : null,
               yoy: (m[prev] && m[k].days >= dim(k) && m[prev].days >= dim(prev)) ? m[k].sum / m[prev].sum : null };
    });
  })(),
};

const out = argOf('out', path.join(ROOT, 'source', 'forecast_bundle.json'));
fs.writeFileSync(out, JSON.stringify(bundle, null, 1));
console.log('wrote ' + out);
console.log('  from ' + from + ' for ' + horizon + ' days, data through ' + bundle.meta.dataThrough +
            (bundle.meta.live ? ' (live)' : ' (snapshot)'));
bundle.headline.forEach(h => console.log('  ' + h.scenario.padEnd(12) +
  ' revenue $' + Math.round(h.revenue).toLocaleString() + '  profit $' + Math.round(h.profit).toLocaleString()));
