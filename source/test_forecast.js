/* Unit tests for forecast.js — the forecast engine.
   Run: node source/test_forecast.js   (exit 0 = all pass)

   Two kinds of test here. Most are synthetic: a series built with a KNOWN
   seasonal shape, so the fit can be checked against the truth that produced it.
   The rest run against the real 2025 + 2026 books and assert the properties
   that actually went wrong during development — an unbalanced panel skewing the
   month index, a drift clamp compounding to x3.46 a year, a Father's Day peak
   inflating the level. Each of those is a regression test for a real defect. */
const F = require('../forecast.js');
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}
const near = (a, b, t = 0.01) => a != null && b != null && Math.abs(a - b) < t;

/* --------------------------------------------------------------- helpers */

function loadGlobal(file, key) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const w = {};
  new Function('window', src)(w);
  return w[key];
}
/* Synthetic year: flat level, a known day-of-week shape, a known month shape. */
function synth(startYear, years, opts) {
  opts = opts || {};
  const dowShape = opts.dow || [0.8, 1.2, 1.2, 1.1, 1.0, 0.9, 0.8];   // Sun..Sat
  const monShape = opts.month || { 6: 2, 11: 2 };                      // else 1
  const base = opts.base || 10000, growth = opts.growth || 1;
  const out = [];
  for (let y = startYear; y < startYear + years; y++) {
    for (let m = 1; m <= 12; m++) {
      const dim = F.daysInMonth(y, m);
      for (let d = 1; d <= dim; d++) {
        const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const lvl = base * Math.pow(growth, y - startYear);
        out.push({ date, revenue: lvl * dowShape[F.dow(date)] * (monShape[m] || 1) });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------- fitDow */
(() => {
  const rows = synth(2024, 2);
  const idx = F.fitDow(rows);
  const truth = [0.8, 1.2, 1.2, 1.1, 1.0, 0.9, 0.8];
  const mean = truth.reduce((a, b) => a + b) / 7;
  let allClose = true;
  for (let i = 0; i < 7; i++) if (!near(idx[i], truth[i] / mean, 0.03)) allClose = false;
  ok('fitDow recovers the shape that generated the series', allClose, idx);
  ok('fitDow indices average to ~1', near(Object.values(idx).reduce((a, b) => a + b) / 7, 1, 0.02));
})();

/* ------------------------------------------------------------ fitSeason */
(() => {
  const rows = synth(2024, 2, { month: { 6: 2, 11: 2 } });
  const s = F.fitSeason(rows);
  // 10 months at 1 and 2 at 2 -> geometric centring puts the flat months
  // slightly below 1 and the big months near 2x that.
  ok('fitSeason finds June big', s.index[6] / s.index[3] > 1.9 && s.index[6] / s.index[3] < 2.1, s.index[6] / s.index[3]);
  ok('fitSeason finds Nov big', near(s.index[11], s.index[6], 0.02), [s.index[11], s.index[6]]);
  ok('fitSeason flat months are equal', near(s.index[2], s.index[9], 0.02), [s.index[2], s.index[9]]);
  ok('fitSeason counts observations', s.observations[6] === 2 && s.observations[1] === 2, s.observations);
  ok('fitSeason exposes a per-year level', Object.keys(s.yearLevel).length === 2, s.yearLevel);
})();

/* THE unbalanced-panel regression. Year A holds the big months, year B holds
   only small ones. Normalising each year against its own average — the first
   implementation — makes year B's months read high and year A's read low, and
   the resulting index is a blend of two incompatible bases. A joint fit must
   return the SAME index for a month whichever year happens to carry it. */
(() => {
  const full = synth(2024, 2, { month: { 6: 2, 11: 2 } });
  const unbalanced = full.filter(r => {
    if (r.date < '2025-01-01') return true;                 // 2024 complete
    return r.date < '2025-05-01';                           // 2025 = Jan..Apr only
  });
  const a = F.fitSeason(full).index, b = F.fitSeason(unbalanced).index;
  ok('unbalanced panel: June index survives losing a year of small months',
     near(a[6] / a[3], b[6] / b[3], 0.05), [a[6] / a[3], b[6] / b[3]]);
  ok('unbalanced panel: Jan index not inflated by a small-months-only year',
     near(a[1] / a[3], b[1] / b[3], 0.05), [a[1] / a[3], b[1] / b[3]]);
})();

/* Part-months must never enter the fit. */
(() => {
  const rows = synth(2024, 1).filter(r => r.date <= '2024-06-08');   // Jan-May whole, Jun partial
  const s = F.fitSeason(rows);
  ok('part-month is excluded from the index', s.observations[6] === 0, s.observations[6]);
  ok('whole months before it are kept', s.observations[5] === 1, s.observations[5]);
  ok('a month no year completes falls back to 1, flagged n=0',
     s.index[12] === 1 && s.observations[12] === 0, [s.index[12], s.observations[12]]);
})();

/* ------------------------------------------------------------ fitGrowth */
(() => {
  const rows = synth(2024, 2, { growth: 1.5 });
  const g = F.fitGrowth(rows);
  ok('fitGrowth recovers x1.5', near(g.yoy, 1.5, 0.02), g.yoy);
  ok('fitGrowth counts whole months only', g.n === 12, g.n);
})();
(() => {
  // 8 days of a month must not masquerade as a collapse: the -32% / +132% bug.
  const rows = synth(2024, 2, { growth: 1.5 }).filter(r => r.date <= '2025-09-08');
  const g = F.fitGrowth(rows);
  ok('growth ignores the partial current month', near(g.yoy, 1.5, 0.02), g.yoy);
})();

/* ------------------------------------------------------------- levelOf */
(() => {
  const rows = synth(2024, 2);
  const dowIdx = F.fitDow(rows), season = F.fitSeason(rows);
  const lvl = F.levelOf(rows, dowIdx, season.index, 28, 'trailing');
  const flat = rows.filter(r => r.date.slice(0, 7) === '2025-03');
  const rawMean = flat.reduce((a, r) => a + r.revenue, 0) / flat.length;
  ok('levelOf is deseasonalised, not a raw mean',
     lvl > rawMean * 0.8 && lvl < rawMean * 1.3, [lvl, rawMean]);
  ok('levelOf returns null with no usable rows', F.levelOf([], dowIdx, season.index, 28) === null);
})();
(() => {
  // Pending days carry revenue but no spend; they must not move the level.
  const rows = synth(2024, 2);
  const withPending = rows.map((r, i) =>
    i >= rows.length - 3 ? Object.assign({}, r, { pending: ['adSpend'] }) : r);
  const dowIdx = F.fitDow(rows), season = F.fitSeason(rows);
  ok('pending days are excluded from the level',
     near(F.levelOf(withPending, dowIdx, season.index, 28, 'trailing'),
          F.levelOf(rows.slice(0, -3), dowIdx, season.index, 28, 'trailing'), 1));
})();

/* ------------------------------------------------------------- project */
(() => {
  const rows = synth(2024, 2);
  const p = F.project({ rows, from: '2025-12-31', horizon: 90 });
  ok('project returns one entry per horizon day', p.days.length === 90, p.days.length);
  ok('project buckets into months', p.months.length === 3, p.months.map(m => m.month));
  ok('project total equals the sum of its days',
     near(p.total, p.days.reduce((a, d) => a + d.revenue, 0), 1));
  ok('project is flat on a flat series', near(p.drift, 1, 0.02), p.drift);
  // A flat synthetic year should forecast Jan..Mar close to its own level.
  const jan = p.months[0];
  ok('flat series forecasts near its own level',
     jan.revenue > 10000 * 31 * 0.85 && jan.revenue < 10000 * 31 * 1.15, jan.revenue);
})();
(() => {
  const rows = synth(2024, 2);
  const base = F.project({ rows, from: '2025-12-31', horizon: 60 });
  const lifted = F.project({ rows, from: '2025-12-31', horizon: 60,
    modifiers: [{ start: '2026-01-05', end: '2026-01-11', lift: 0.5, payback: -0.3, paybackEnd: '2026-01-18' }] });
  const win = d => d.date >= '2026-01-05' && d.date <= '2026-01-11';
  const pb  = d => d.date > '2026-01-11' && d.date <= '2026-01-18';
  const s = (p, f) => p.days.filter(f).reduce((a, d) => a + d.revenue, 0);
  ok('modifier lifts its own window by the amount asked',
     near(s(lifted, win) / s(base, win), 1.5, 0.001), s(lifted, win) / s(base, win));
  ok('modifier payback cuts the window after it',
     near(s(lifted, pb) / s(base, pb), 0.7, 0.001), s(lifted, pb) / s(base, pb));
  ok('modifier leaves untouched days untouched',
     near(s(lifted, d => d.date > '2026-01-18'), s(base, d => d.date > '2026-01-18'), 1));
  ok('modified days are flagged', lifted.days.filter(d => d.modified).length === 14,
     lifted.days.filter(d => d.modified).length);
})();
(() => {
  const rows = synth(2024, 2);
  const o = F.project({ rows, from: '2025-12-31', horizon: 90, scenario: 'optimistic' });
  const r = F.project({ rows, from: '2025-12-31', horizon: 90, scenario: 'realistic' });
  const p = F.project({ rows, from: '2025-12-31', horizon: 90, scenario: 'pessimistic' });
  ok('scenarios order pessimistic < realistic < optimistic',
     p.total < r.total && r.total < o.total, [p.total, r.total, o.total]);
  ok('unknown scenario falls back to realistic',
     near(F.project({ rows, from: '2025-12-31', horizon: 90, scenario: 'nope' }).total, r.total, 1));
})();

/* THE drift regression. A per-28-day clamp of 1.10 compounds to x3.46 a year;
   drift must never imply growth beyond what the business has actually done. */
(() => {
  const rows = synth(2024, 2, { growth: 1.4 });
  // Force a steep recent ramp so the raw 28-over-28 ratio wants to run away.
  const ramped = rows.map(r => r.date >= '2025-12-01'
    ? Object.assign({}, r, { revenue: r.revenue * 3 }) : r);
  const p = F.project({ rows: ramped, from: '2025-12-31', horizon: 90 });
  const impliedAnnual = Math.pow(p.drift, 365 / 28);
  const g = F.fitGrowth(ramped);
  ok('drift cannot imply faster growth than the best year-on-year month seen',
     impliedAnnual <= Math.max(g.high, 1.05) + 0.01, [impliedAnnual, g.high]);
  ok('drift floor is the reciprocal of its ceiling',
     F.project({ rows: rows.map(r => r.date >= '2025-12-01'
        ? Object.assign({}, r, { revenue: r.revenue / 5 }) : r),
       from: '2025-12-31', horizon: 30 }).drift >= 1 / (Math.pow(Math.max(g.high, 1.05), 28 / 365)) - 0.01);
})();

/* ------------------------------------------------------------- asMetric */

/* Re-pointing the engine at a different measure. The whole point is that
   nothing else changes, so these check the mapping is faithful and — the part
   that matters — that PENDING is handled per-measure. A day the sheet has not
   finished carries revenue and orders but no ad spend: unusable for revenue,
   perfectly good for an order count. Dropping those days from an order forecast
   would throw away real data for no reason. */
(() => {
  const rows = [
    { date: '2026-01-01', revenue: 100, orders: 10, newOrders: 7, pending: ['adSpend', 'profit'] },
    { date: '2026-01-02', revenue: 200, orders: 20, newOrders: 15, pending: null },
    { date: '2026-01-03', revenue: 0, orders: 0, newOrders: null, pending: null },
  ];
  const o = F.asMetric(rows, 'orders');
  ok('asMetric maps a named field onto revenue', o.map(r => r.revenue).join() === '10,20,0', o);
  ok('asMetric keeps the dates', o.map(r => r.date).join() === '2026-01-01,2026-01-02,2026-01-03');
  ok('asMetric clears pending by default — orders do not depend on ad spend',
     o.every(r => r.pending === null), o.map(r => r.pending));
  ok('asMetric keeps pending when the caller says the measure needs it',
     F.asMetric(rows, 'revenue', { keepPending: true })[0].pending.length === 2);
  const d = F.asMetric(rows, r => Math.max(0, (r.orders || 0) - (r.newOrders || 0)));
  ok('asMetric takes a function, for a derived series', d.map(r => r.revenue).join() === '3,5,0', d);
  ok('asMetric turns a null into 0 rather than NaN',
     F.asMetric([{ date: '2026-01-01', orders: null }], 'orders')[0].revenue === 0);
  ok('asMetric drops rows with no date', F.asMetric([{ orders: 5 }], 'orders').length === 0);
  ok('asMetric carries the P&L fields through, so fitPnl still works on revenue',
     F.asMetric([{ date: '2026-01-01', revenue: 9, revExGst: 8, totalVC: 4, totalAds: 2, totalFC: 1 }],
       'revenue')[0].totalFC === 1);

  /* And the engine really does run on the mapped series. */
  const synthRows = synth(2024, 2);
  const withOrders = synthRows.map(r => Object.assign({}, r, { orders: Math.round(r.revenue / 300) }));
  const p = F.project({ rows: F.asMetric(withOrders, 'orders'), from: '2025-12-31', horizon: 30 });
  ok('the engine projects an order count like any other series',
     p && p.total > 0 && p.days.length === 30, p && p.total);
  ok('and its level is in orders, not dollars', p.level < 200, p.level);
})();

/* --------------------------------------------------------- sale periods */

(() => {
  ok('nthDowOfMonth finds the first Sunday of Sep 2026',
     F.nthDowOfMonth(2026, 9, 0, 1) === '2026-09-06', F.nthDowOfMonth(2026, 9, 0, 1));
  ok('nthDowOfMonth finds the first Sunday of Sep 2025',
     F.nthDowOfMonth(2025, 9, 0, 1) === '2025-09-07', F.nthDowOfMonth(2025, 9, 0, 1));
  ok('nthDowOfMonth finds the fourth Thursday of Nov 2026',
     F.nthDowOfMonth(2026, 11, 4, 4) === '2026-11-26', F.nthDowOfMonth(2026, 11, 4, 4));
  ok('nthDowOfMonth returns null when the nth does not exist',
     F.nthDowOfMonth(2026, 2, 0, 5) === null, F.nthDowOfMonth(2026, 2, 0, 5));
  ok("Father's Day is declared as a sale period, not left to the month index",
     F.SALE_PERIODS.some(sp => sp.key === 'fathers'), F.SALE_PERIODS.map(sp => sp.key));
  ok('EOFY and BFCM are NOT sale periods — the month index already prices them',
     !F.SALE_PERIODS.some(sp => sp.key === 'eofy' || sp.key === 'bfcm'), F.SALE_PERIODS.map(sp => sp.key));
  ok('the events list says which mechanism carries each event',
     F.EVENTS.every(e => e.via === 'index' || e.via === 'sale') &&
     F.EVENTS.find(e => e.key === 'fathers').via === 'sale' &&
     F.EVENTS.find(e => e.key === 'eofy').via === 'index',
     F.EVENTS.map(e => e.key + ':' + e.via));
})();

/* Plant a promotion of a KNOWN size into a flat synthetic series, then check
   the fit recovers it — the only way to know the measurement is a measurement
   and not a coincidence. */
function withPromo(rows, day, runUp, lift) {
  const start = F.addDays(day, -(runUp - 1));
  return rows.map(r => (r.date >= start && r.date <= day)
    ? Object.assign({}, r, { revenue: r.revenue * (1 + lift) }) : r);
}
(() => {
  const flat = synth(2024, 2);
  const day = F.nthDowOfMonth(2025, 9, 0, 1);
  const rows = withPromo(flat, day, 14, 0.5);
  const sp = F.SALE_PERIODS.find(s2 => s2.key === 'fathers');
  const fits = F.fitSale(rows, sp, F.fitDow(rows), F.fitSeason(rows).yearLevel);
  const f2025 = fits.find(f => f.year === '2025');
  ok('fitSale recovers a planted +50% lift', f2025 && near(f2025.lift, 0.5, 0.05), f2025 && f2025.lift);
  ok('fitSale dates the run-up from the event backwards',
     f2025 && f2025.runStart === F.addDays(day, -13), f2025 && f2025.runStart);
  ok('fitSale returns a per-day profile the length of the run-up',
     f2025 && f2025.profile.length === 14, f2025 && f2025.profile.length);
  ok('a flat planted promotion gives a flat profile',
     f2025 && f2025.profile.every(o => near(o.lift, 0.5, 0.08)), f2025 && f2025.profile.map(o => +o.lift.toFixed(2)));
  ok('the year with no promotion measures no lift',
     fits.find(f => f.year === '2024') && Math.abs(fits.find(f => f.year === '2024').lift) < 0.05,
     fits.find(f => f.year === '2024') && fits.find(f => f.year === '2024').lift);
})();

(() => {
  const flat = synth(2024, 2);
  const day = F.nthDowOfMonth(2025, 9, 0, 1);
  // A promotion with no slump after it: nothing was pulled forward on net, so
  // the payback window must not invent one.
  const rows = withPromo(flat, day, 14, 0.5);
  const sp = F.SALE_PERIODS.find(s2 => s2.key === 'fathers');
  const f = F.fitSale(rows, sp, F.fitDow(rows), F.fitSeason(rows).yearLevel).find(x => x.year === '2025');
  ok('no slump after the promotion means no payback window',
     f && (f.payback == null || f.payback >= 0 || f.paybackDays == null), f && [f.payback, f.paybackDays]);
})();

(() => {
  // A promotion followed by a real slump: the payback window must be long
  // enough to repay what was pulled forward, and no longer.
  const flat = synth(2024, 2);
  const day = F.nthDowOfMonth(2025, 9, 0, 1);
  let rows = withPromo(flat, day, 14, 0.4);              // pulls 5.6 day-equivalents
  rows = rows.map(r => (r.date > day && r.date <= F.addDays(day, 28))
    ? Object.assign({}, r, { revenue: r.revenue * 0.7 }) : r);   // -30% after
  const sp = F.SALE_PERIODS.find(s2 => s2.key === 'fathers');
  const f = F.fitSale(rows, sp, F.fitDow(rows), F.fitSeason(rows).yearLevel).find(x => x.year === '2025');
  ok('payback size is measured', f && near(f.payback, -0.3, 0.06), f && f.payback);
  ok('payback length repays what was pulled forward, near enough',
     f && f.paybackDays >= 14 && f.paybackDays <= 24, f && [f.pulled, f.paybackDays]);
})();

(() => {
  // A promotion is a DECISION: the most recent year that actually ran one sizes
  // the modifier. Averaging in a year that ran none would halve it.
  const flat = synth(2024, 3);
  const rows = withPromo(flat, F.nthDowOfMonth(2026, 9, 0, 1), 14, 0.5);   // 2026 only
  const mods = F.salePeriodModifiers(rows, { years: ['2026', '2027'] });
  ok('salePeriodModifiers dates one modifier per year asked for',
     mods.length === 2, mods.map(m => m.key));
  ok('it is sized from the most recent year that registered',
     mods[0].measured.from === '2026' && near(mods[0].lift, 0.5, 0.05), mods[0] && mods[0].lift);
  ok('every year measured is reported alongside, not hidden',
     mods[0].measured.allYears.length >= 2, mods[0].measured.allYears.map(y => y.year));
  ok('next year gets the event on ITS date, not this one repeated',
     mods[1].end === F.nthDowOfMonth(2027, 9, 0, 1), mods[1].end);
  ok('the run-up profile is carried onto the modifier, dated',
     mods[1].profile.length === 14 && mods[1].profile[13].date === mods[1].end,
     mods[1].profile && mods[1].profile.length);
  ok('a year with no promotion anywhere produces no modifiers',
     F.salePeriodModifiers(synth(2024, 2), { years: ['2025'] }).length === 0);
})();

/* Each year must use its OWN measurement where it has one. Carrying the
   reference year's lift onto a historical year that ran no promotion is a false
   statement about the past, and it does damage in the wrong direction: it
   deflates the prior year, inflates year-on-year growth, and pushes the whole
   forecast UP by roughly a quarter. */
(() => {
  const flat = synth(2024, 3);
  const rows = withPromo(flat, F.nthDowOfMonth(2026, 9, 0, 1), 14, 0.5);   // 2026 only
  const mods = F.salePeriodModifiers(rows, { years: ['2024', '2025', '2026', '2027'] });
  const keys = mods.map(m => m.key);
  ok('a measured year with no promotion gets no modifier',
     keys.indexOf('fathers:2024') === -1 && keys.indexOf('fathers:2025') === -1, keys);
  ok('the year that did promote gets its own measurement',
     mods.find(m => m.key === 'fathers:2026').measured.own === true);
  ok('a future year is sized from the most recent that registered',
     mods.find(m => m.key === 'fathers:2027').measured.own === false &&
     mods.find(m => m.key === 'fathers:2027').measured.from === '2026');
  /* And the consequence, stated as a test: mis-dating it upward is worse than
     not declaring it at all. */
  const bad = mods.concat([Object.assign({}, mods[0], {
    key: 'bad:2025', start: '2025-08-25', end: '2025-09-07',
    profile: null, lift: 0.5, payback: 0, paybackEnd: null })]);
  const good = F.project({ rows, from: '2026-09-06', horizon: 90, modifiers: mods });
  const wrong = F.project({ rows, from: '2026-09-06', horizon: 90, modifiers: bad });
  ok('declaring a promotion in a year that had none inflates the forecast',
     wrong.total > good.total * 1.05, [good.total, wrong.total]);
})();

/* THE level regression. A sale period must be divided back OUT of the level, or
   the forecast reads a fortnight of discounting as the new run rate. */
(() => {
  const flat = synth(2024, 2);
  const day = F.nthDowOfMonth(2025, 9, 0, 1);
  const rows = withPromo(flat, day, 14, 0.5);
  const clean = F.project({ rows: flat, from: day, horizon: 30 });
  const dirty = F.project({ rows, from: day, horizon: 30 });
  const mods = F.salePeriodModifiers(rows, { years: ['2025'] });
  const fixed = F.project({ rows, from: day, horizon: 30, modifiers: mods });
  ok('an undeclared promotion inflates the level', dirty.level > clean.level * 1.15,
     [clean.level, dirty.level]);
  ok('declaring it brings the level back to the un-promoted one',
     near(fixed.level / clean.level, 1, 0.08), fixed.level / clean.level);
  ok('and brings the forward forecast back with it',
     near(fixed.total / clean.total, 1, 0.1), fixed.total / clean.total);
})();

(() => {
  // Forward: a sale period in the horizon must lift its own days and cut the
  // ones after, on the measured profile rather than a flat block.
  const flat = synth(2024, 3);
  const rows = withPromo(flat, F.nthDowOfMonth(2026, 9, 0, 1), 14, 0.5);
  const mods = F.salePeriodModifiers(rows, { years: ['2027'] });
  const from = '2027-08-01';
  const base = F.project({ rows, from, horizon: 90 });
  const lift = F.project({ rows, from, horizon: 90, modifiers: mods });
  const m = mods[0];
  const inWin = d => d.date >= m.start && d.date <= m.end;
  const sIn = p => p.days.filter(inWin).reduce((a, d) => a + d.revenue, 0);
  ok('next September lifts inside the run-up window',
     sIn(lift) > sIn(base) * 1.35, sIn(lift) / sIn(base));
  ok('run-up days are flagged as modified',
     lift.days.filter(d => inWin(d) && d.modified).length === 14,
     lift.days.filter(d => inWin(d) && d.modified).length);
  ok('days outside the sale period and its payback are untouched',
     near(lift.days.filter(d => d.date > m.paybackEnd).reduce((a, d) => a + d.revenue, 0),
          base.days.filter(d => d.date > m.paybackEnd).reduce((a, d) => a + d.revenue, 0), 1));
})();

/* ----------------------------------------------- composing declarations */

/* Three kinds of declaration, one arithmetic. These assert the composition
   rules, because two mechanisms answering the same overlap differently is the
   worst outcome available. */
(() => {
  const a = { key: 'a', name: 'Sale A', start: '2026-03-01', end: '2026-03-10', lift: 0.5,
              payback: -0.2, paybackEnd: '2026-03-20' };
  const b = { key: 'b', name: 'Launch B', start: '2026-03-05', end: '2026-03-15', lift: 0.3 };
  const c = F.composeMods([a, b], { observedCeiling: 2.0 });

  ok('a day only one declaration touches gets that one factor',
     near(c.at('2026-03-02'), 1.5, 1e-9), c.at('2026-03-02'));
  ok('overlapping lifts multiply, they do not add',
     near(c.at('2026-03-06'), 1.5 * 1.3, 1e-9), c.at('2026-03-06'));
  ok('a payback multiplies against a lift that overlaps it',
     near(c.at('2026-03-12'), 0.8 * 1.3, 1e-9), c.at('2026-03-12'));
  ok('a day nothing touches is exactly 1', c.at('2026-02-01') === 1 && c.at('2026-04-01') === 1);
  ok('the peak is reported', near(c.peak, 1.95, 1e-9), c.peak);
  ok('a peak inside the book is not flagged', c.beyondBook === false, [c.peak, c.ceiling]);
  ok('a peak past anything in the book is flagged, and NOT clipped',
     (() => { const d = F.composeMods([a, b], { observedCeiling: 1.8 });
              return d.beyondBook === true && near(d.at('2026-03-06'), 1.95, 1e-9); })());
  ok('with no ceiling given nothing is flagged',
     F.composeMods([a, b]).beyondBook === false);

  ok('overlapping days are counted', c.overlaps.length === 11, c.overlaps.length);
  ok('overlaps group by WHICH declarations collide, so one collision is one run',
     c.runs.length === 1 && c.runs[0].start === '2026-03-05' && c.runs[0].end === '2026-03-15',
     c.runs.map(r => r.start + '..' + r.end));
  ok('a run names every declaration in it',
     c.runs[0].names.indexOf('Sale A') !== -1 && c.runs[0].names.indexOf('Launch B') !== -1,
     c.runs[0].names);
  /* A run can span a lift and its neighbour's payback, so the peak alone would
     hide that part of it cuts. Both ends are reported. */
  ok('a run reports both ends, not just its peak',
     near(c.runs[0].peak, 1.95, 1e-9) && near(c.runs[0].low, 0.8 * 1.3, 1e-9),
     [c.runs[0].peak, c.runs[0].low]);
  ok('a separate, non-adjacent collision is its own run',
     F.composeMods([a, b,
       { key: 'x', name: 'X', start: '2026-06-01', end: '2026-06-05', lift: 0.2 },
       { key: 'y', name: 'Y', start: '2026-06-03', end: '2026-06-08', lift: 0.2 }]).runs.length === 2);
  ok('no declarations means no overlap and no peak',
     F.composeMods([]).runs.length === 0 && F.composeMods([]).peak === 1);
  ok('a profile beats the flat lift on the days it covers',
     near(F.composeMods([Object.assign({}, a, {
       profile: [{ date: '2026-03-02', lift: 0.9 }] })]).at('2026-03-02'), 1.9, 1e-9));
})();

(() => {
  const rows = synth(2024, 2);
  const ceil = F.observedCeiling(rows);
  ok('observedCeiling finds the biggest recurring swing in a synthetic year',
     ceil > 1.8 && ceil < 2.6, ceil);
  ok('observedCeiling returns null with no rows', F.observedCeiling([]) === null);
})();

/* An override re-sizes a measured sale period without flattening its shape. */
(() => {
  const flat = synth(2024, 3);
  const day26 = F.nthDowOfMonth(2026, 9, 0, 1);
  const rows = flat.map(r => {
    // a ramped promotion, so there is a shape to preserve
    const k = Math.round((Date.parse(day26) - Date.parse(r.date)) / 86400000);
    if (k < 0 || k > 13) return r;
    return Object.assign({}, r, { revenue: r.revenue * (1 + 0.6 * (1 - k / 14)) });
  });
  const plain = F.salePeriodModifiers(rows, { years: ['2027'] })[0];
  const bigger = F.salePeriodModifiers(rows, { years: ['2027'],
    overrides: { 'fathers:2027': { lift: plain.lift * 2 } } })[0];
  ok('an override changes the size', near(bigger.lift, plain.lift * 2, 1e-9), [plain.lift, bigger.lift]);
  ok('an override is flagged as the user\'s', bigger.overridden === true && plain.overridden === false);
  ok('the measured lift is still reported alongside',
     near(bigger.measured.lift, plain.lift, 1e-9), bigger.measured.lift);
  const shapeOf = m => m.profile.map(o => o.lift / m.profile[m.profile.length - 1].lift);
  ok('the measured ramp is scaled, not flattened',
     shapeOf(plain).every((v, i) => near(v, shapeOf(bigger)[i], 1e-6)),
     [shapeOf(plain).slice(0, 3), shapeOf(bigger).slice(0, 3)]);
  ok('a scaled profile really is bigger day by day',
     bigger.profile.every((o, i) => o.lift > plain.profile[i].lift), null);
  /* And an override can declare a promotion in a year the book measured none —
     a sale being planned — which is the one thing that may reach past history. */
  const declared = F.salePeriodModifiers(synth(2024, 2), { years: ['2026'],
    overrides: { 'fathers:2026': { lift: 0.35 } } });
  ok('an override can declare a sale period with no precedent at all',
     declared.length === 1 && near(declared[0].lift, 0.35, 1e-9) &&
     declared[0].measured.lift === null && declared[0].profile === null, declared.length);
})();

/* --------------------------------------------------------------- fitPnl */
(() => {
  const rows = synth(2024, 2).map(r => Object.assign({}, r, {
    revExGst: r.revenue * 0.92, totalVC: r.revenue * 0.45,
    totalAds: r.revenue * 0.28, totalFC: 2000,
  }));
  // A hiring step in the last month: the estimator must take the step, not a mean.
  rows.forEach(r => { if (r.date >= '2025-12-01') r.totalFC = 3000; });
  const pnl = F.fitPnl(rows, 90);
  ok('fitPnl reads the GST rate', near(pnl.exGstRate, 0.92, 0.005), pnl.exGstRate);
  ok('fitPnl reads the variable cost rate', near(pnl.vcRate, 0.45, 0.005), pnl.vcRate);
  ok('fitPnl contribution = exGst - VC', near(pnl.contribRate, 0.47, 0.005), pnl.contribRate);
  ok('fitPnl takes the LATEST fixed cost, not the average', pnl.fcPerDay === 3000, pnl.fcPerDay);
  ok('fitPnl still reports the average, for contrast',
     pnl.fcPerDayAvg > 2000 && pnl.fcPerDayAvg < 3000, pnl.fcPerDayAvg);
  ok('fitPnl ad-rate index is flat when efficiency is flat',
     near(pnl.adRateIndex[3], 1, 0.02) && near(pnl.adRateIndex[11], 1, 0.02),
     [pnl.adRateIndex[3], pnl.adRateIndex[11]]);
  ok('fitPnl returns null with nothing usable', F.fitPnl([]) === null);
})();
(() => {
  // Efficiency that really does vary by month must show up in the index.
  const rows = synth(2024, 2).map(r => {
    const cheap = F.monthOf(r.date) === 6;
    return Object.assign({}, r, { revExGst: r.revenue * 0.92, totalVC: r.revenue * 0.45,
      totalAds: r.revenue * (cheap ? 0.14 : 0.28), totalFC: 2000 });
  });
  const pnl = F.fitPnl(rows, 90);
  ok('ad-rate index sees June as the efficient month',
     pnl.adRateIndex[6] < pnl.adRateIndex[3] * 0.6, [pnl.adRateIndex[6], pnl.adRateIndex[3]]);
  ok('ad-rate index counts its observations', pnl.adRateN[6] === 2, pnl.adRateN[6]);
})();

/* ----------------------------------------------------------- projectPnl */
(() => {
  const rows = synth(2024, 2).map(r => Object.assign({}, r, {
    revExGst: r.revenue * 0.92, totalVC: r.revenue * 0.45,
    totalAds: r.revenue * 0.28, totalFC: 2000,
  }));
  const p = F.projectPnl({ rows, from: '2025-12-31', horizon: 90 });
  ok('projectPnl adds spend and profit to every day',
     p.days.every(d => d.adSpend > 0 && d.profit != null), null);
  // The identity, day by day: profit = rev*contrib - ad - fixed
  const d0 = p.days[0];
  ok('day profit follows the P&L identity',
     near(d0.profit, d0.revenue * p.pnl.contribRate - d0.adSpend - p.pnl.fcPerDay, 0.01));
  ok('month totals equal the sum of their days',
     near(p.months[0].profit, p.days.filter(d => d.month === p.months[0].month)
       .reduce((a, d) => a + d.profit, 0), 0.01));
  ok('breakeven per day is stated in dollars',
     near(p.breakevenPerDay, 2000 / (p.pnl.contribRate - p.pnl.adRate), 1), p.breakevenPerDay);
  // Operating leverage: fixed cost does not flex, so profit must swing harder
  // than revenue between scenarios. This is the whole point of holding it fixed.
  const o = F.projectPnl({ rows, from: '2025-12-31', horizon: 90, scenario: 'optimistic' });
  const pe = F.projectPnl({ rows, from: '2025-12-31', horizon: 90, scenario: 'pessimistic' });
  const revSwing = (o.total - pe.total) / pe.total;
  const proSwing = (o.profit - pe.profit) / Math.abs(pe.profit);
  ok('profit swings harder than revenue across scenarios', proSwing > revSwing, [revSwing, proSwing]);
  ok('an explicit adRate overrides the fitted one',
     F.projectPnl({ rows, from: '2025-12-31', horizon: 30, adRate: 0.5 }).adSpend >
     F.projectPnl({ rows, from: '2025-12-31', horizon: 30 }).adSpend);
})();

/* ------------------------------------------------------------- backtest */
(() => {
  const rows = synth(2024, 2);
  const bt = F.backtest(rows, { horizons: [30], step: 30 });
  ok('backtest scores a flat series almost perfectly', bt[30] && bt[30].mape < 0.05, bt[30] && bt[30].mape);
  ok('backtest reports how many origins it scored', bt[30].n > 3, bt[30].n);
  ok('backtest reports the quantiles the band is drawn from',
     bt[30].p10 != null && bt[30].p90 != null && bt[30].p10 <= bt[30].p90, bt[30]);
  ok('backtest separates origins with no prior year to lean on',
     bt[30].coldStart == null || bt[30].coldStart.n > 0, bt[30].coldStart);
})();

/* ---------------------------- a launch inside a sale period's baseline */
(function () {
  /* Flat $10,000 a day through 2025 and 2026 with a known weekday shape. Plant
     a +50% promotion for the 14 days ending on Father's Day 2026 (6 Sep) and a
     +30% product launch on the three weeks before it (6-22 Aug) — the launch
     sits exactly inside the promotion's 21-day baseline. Measured naively the
     promotion reads about +15%; with the launch declared it reads the +50% it
     really was. */
  const base = synth(2025, 2, { month: {} });
  const rows = base.map(r => {
    let f = 1;
    if (r.date >= '2026-08-24' && r.date <= '2026-09-06') f = 1.5;
    else if (r.date >= '2026-08-06' && r.date <= '2026-08-22') f = 1.3;
    return { date: r.date, revenue: r.revenue * f };
  }).filter(r => r.date <= '2026-09-08');
  const naive = F.salePeriodModifiers(rows, { years: ['2026'] }).find(m => m.key === 'fathers:2026');
  const launch = { key: 'user:0', kind: 'user', name: 'Launch', start: '2026-08-06', end: '2026-08-22', lift: 0.3, payback: 0 };
  const corrected = F.salePeriodModifiers(rows, { years: ['2026'], modifiers: [launch] }).find(m => m.key === 'fathers:2026');
  ok('launch-in-baseline: measured naively, the promotion is understated', naive && naive.lift < 0.25, naive && naive.lift);
  ok('launch-in-baseline: with the launch declared, the planted +50% is recovered',
     corrected && Math.abs(corrected.lift - 0.5) < 0.06, corrected && corrected.lift);
  ok('launch-in-baseline: a declaration outside the baseline changes nothing',
     (() => { const far = { key: 'user:1', kind: 'user', name: 'x', start: '2026-03-01', end: '2026-03-10', lift: 0.3, payback: 0 };
              const c2 = F.salePeriodModifiers(rows, { years: ['2026'], modifiers: [far] }).find(m => m.key === 'fathers:2026');
              /* Not identical: deflating ten March days nudges the global weekday
                 and year-level fits by a hair. Within a point is unchanged. */
              return c2 && Math.abs(c2.lift - naive.lift) < 0.01; })());
})();

/* ---------------------------------------- a product launched mid-window */
(function () {
  /* Two years of days. Nothing until 1 Oct 2025 (a $20/day trickle in Aug-Sep),
     then a flat $1000/day with no seasonality at all. A correct fit says every
     month is x1; the joint fit used to say October x6 and November x11, because
     {Oct,Nov,Dec} of 2025 and {Jan..Sep} of 2026 share no month and the year
     effects were unidentifiable — and the trickle months made it worse. */
  const rows = [];
  for (let d = new Date('2024-09-10T00:00:00Z'); d <= new Date('2026-09-08T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const v = iso >= '2025-10-01' ? 1000 : iso >= '2025-08-01' ? 20 : 0;
    rows.push({ date: iso, revenue: v });
  }
  const se = F.fitSeason(rows, true);
  const idx = Object.values(se.index);
  ok('launch: no month index blows up on a flat product', Math.max(...idx) < 1.3 && Math.min(...idx) > 0.77, idx.map(v => +v.toFixed(2)));
  ok('launch: the trickle months are not read as seasonality', se.index[8] > 0.8 && se.index[9] > 0.8, [se.index[8], se.index[9]]);
  ok('launch: the disconnected block is reported', se.disconnected > 0, se.disconnected);
  const p = F.project({ rows, from: '2026-09-08', horizon: 90, scenario: 'realistic', sparse: true });
  ok('launch: the forecast is the run rate, not a x50 launch echo',
     p.total > 60000 && p.total < 130000, Math.round(p.total));
  ok('launch: nothing in it is NaN', p.days.every(d => isFinite(d.revenue)));
  const bt = F.backtest(rows, { sparse: true, model: { scenario: 'realistic' } });
  /* The trickle counts as the first sale, so the last two origins do see a
     (tiny) prior year; what matters is that the cold-start figure is measured
     and finite either way, and that the model does not over-forecast a ramp. */
  ok('launch: the cold-start error is measured and finite',
     bt[30] && bt[30].coldStart && isFinite(bt[30].coldStart.mape) && bt[30].coldStart.n > 30, bt[30] && bt[30].coldStart);
  /* Dense revenue is unaffected: one connected panel, no trickle months. */
})();

/* ------------------------------------------------- the real books */
let REAL = null;
try {
  const prior = loadGlobal('prior_year.js', 'DL_PRIOR');
  const data  = loadGlobal('data.js', 'DL_DATA');
  REAL = [...(prior.daily || []), ...(data.daily || [])]
    .filter(d => d && d.date && d.revenue > 0)
    .sort((a, b) => a.date < b.date ? -1 : 1);
} catch (e) { /* snapshots absent — the synthetic tests above still stand */ }

if (!REAL || REAL.length < 400) {
  console.log('  (skipped the real-book tests: prior_year.js / data.js not both present)');
} else {
  const season = F.fitSeason(REAL), growth = F.fitGrowth(REAL), pnl = F.fitPnl(REAL);

  ok('real: two years of daily rows loaded', REAL.length > 500, REAL.length);
  ok('real: June and November are the two big months',
     season.index[6] > 1.5 && season.index[11] > 2 &&
     Math.max(...[1,2,3,4,5,7,8,9,10,12].map(m => season.index[m])) < 1.5,
     [season.index[6], season.index[11]]);
  ok('real: January is the weakest month (trade shutdown)',
     season.index[1] === Math.min(...Object.values(season.index).filter(v => v !== 1)),
     season.index[1]);
  ok('real: months 2025 never filled in are flagged n=1, not invented',
     season.observations[3] === 1 && season.observations[4] === 1,
     [season.observations[3], season.observations[4]]);
  ok('real: year-on-year growth is measured from whole months', growth.n >= 5, growth.n);
  ok('real: growth is between x1 and x3', growth.yoy > 1 && growth.yoy < 3, growth.yoy);

  /* The Father's Day regression. On 2026-09-08 the trailing window's September
     days are 1-8, which hold the whole Father's Day peak; deseasonalising them
     by a flat September index read the business 23% larger than it was. */
  const dowIdx = F.fitDow(REAL);
  const lvlTrailing = F.levelOf(REAL, dowIdx, season.index, 28, 'trailing', '2026-09-08');
  const lvlShape    = F.levelOf(REAL, dowIdx, season.index, 28, 'shape', '2026-09-08',
                                F.priorShaper(REAL));
  ok('real: the day-shape level is lower than the naive one over a peak',
     lvlShape < lvlTrailing, [lvlShape, lvlTrailing]);

  const p = F.projectPnl({ rows: REAL, from: '2026-09-08', horizon: 114 });
  ok('real: drift never implies more than the best year-on-year month',
     Math.pow(p.drift, 365 / 28) <= growth.high + 0.01,
     [Math.pow(p.drift, 365 / 28), growth.high]);
  ok('real: November is forecast as the biggest month',
     p.months.find(m => m.month === '2026-11').revenue ===
     Math.max(...p.months.map(m => m.revenue)));
  /* The sanity bound that started all this. Every forecast month must land
     within the year-on-year range the business has actually recorded — a
     forecast above its own best month ever is the model talking, not the data. */
  const ly = { '2026-09': 148654, '2026-10': 356456, '2026-11': 710170, '2026-12': 283078 };
  p.months.forEach(m => {
    const r = m.revenue / ly[m.month];
    ok(`real: ${m.month} lands inside the observed YoY range (x${growth.low.toFixed(2)}..x${(growth.high * 1.2).toFixed(2)})`,
       r > growth.low && r < growth.high * 1.2, r);
  });
  ok('real: fixed cost is the latest step, above the 90-day average',
     pnl.fcPerDay >= pnl.fcPerDayAvg, [pnl.fcPerDay, pnl.fcPerDayAvg]);
  ok('real: contribution rate is between 40% and 55%',
     pnl.contribRate > 0.4 && pnl.contribRate < 0.55, pnl.contribRate);
  ok('real: the big months are the efficient ones on ad spend',
     pnl.adRateIndex[6] < 1 && pnl.adRateIndex[11] < 1 && pnl.adRateIndex[7] > 1,
     [pnl.adRateIndex[6], pnl.adRateIndex[11], pnl.adRateIndex[7]]);

  /* The real Father's Day. 2026 ran a large promotion; 2025 ran none worth the
     name, so the September index cannot possibly carry it — which is the whole
     argument for it being a sale period. */
  const fdFits = F.fitSale(REAL, F.SALE_PERIODS.find(sp => sp.key === 'fathers'),
                           F.fitDow(REAL), season.yearLevel);
  const fd26 = fdFits.find(f => f.year === '2026'), fd25 = fdFits.find(f => f.year === '2025');
  ok('real: 2026 Father\'s Day measures a large lift', fd26 && fd26.lift > 0.3, fd26 && fd26.lift);
  ok('real: 2025 Father\'s Day measures no promotion', fd25 && fd25.lift < 0.1, fd25 && fd25.lift);
  ok('real: the 2026 run-up is a ramp, not a flat block',
     fd26 && (Math.max(...fd26.profile.map(o => o.lift)) - Math.min(...fd26.profile.map(o => o.lift))) > 0.3,
     fd26 && fd26.profile.map(o => +o.lift.toFixed(2)));
  ok('real: the payback window is derived from what was pulled forward',
     fd26 && fd26.paybackDays > 10 && fd26.paybackDays < 30, fd26 && [fd26.pulled, fd26.paybackDays]);

  const realMods = F.salePeriodModifiers(REAL, { years: ['2026', '2027'] });
  const bare = F.projectPnl({ rows: REAL, from: '2026-09-08', horizon: 114 });
  const corr = F.projectPnl({ rows: REAL, from: '2026-09-08', horizon: 114, modifiers: realMods });
  ok('real: the promotion inflates the level by ~17% if left in',
     bare.level > corr.level * 1.15, [bare.level, corr.level, bare.level / corr.level]);
  /* Declaring it does not merely tell a better story — it scores better. Small,
     because only the newest origins have a promotion inside their level window
     at all, but it moves the right way at every horizon. */
  const btPlain = F.backtest(REAL, { model: { scenario: 'realistic' } });
  const btSale  = F.backtest(REAL, { model: { scenario: 'realistic', modifiers: realMods } });
  ok('real: declaring the sale period does not make the backtest worse',
     [30, 60, 90].every(h => btSale[h].mape <= btPlain[h].mape + 0.005),
     [30, 60, 90].map(h => [btPlain[h].mape.toFixed(3), btSale[h].mape.toFixed(3)]));
  ok('real: and it reduces the 30-day error',
     btSale[30].mape < btPlain[30].mape, [btPlain[30].mape, btSale[30].mape]);
  /* The independent check that settles which of the two is right: August
     measured BEFORE the promotion ran x1.69 on last year, alongside May x1.77,
     June x1.72 and July x1.51. A forecast projecting the rest of the year at
     x2.0+ is reading a fortnight of discounting as trend. */
  const ly2 = { '2026-10': 356456, '2026-11': 710170, '2026-12': 283078 };
  const ratios = corr.months.filter(m => ly2[m.month]).map(m => m.revenue / ly2[m.month]);
  /* The bound is the best like-for-like month ever recorded, not a number
     picked by hand: with growth applied as a trend, December rides up to x1.94
     on a year whose months ran x1.15..x2.02, and that is inside the evidence. */
  ok('real: corrected, the rest of the year lands inside the measured growth range (x1.4..best month)',
     ratios.every(r => r > 1.4 && r <= growth.high + 0.01), ratios.map(r => +r.toFixed(2)).concat([+growth.high.toFixed(2)]));
  const bareRatios = bare.months.filter(m => ly2[m.month]).map(m => m.revenue / ly2[m.month]);
  ok('real: uncorrected, it runs above every year-on-year month ever recorded',
     bareRatios.some(r => r > growth.high), bareRatios.map(r => +r.toFixed(2)));

  const bt0 = F.backtest(REAL, { model: { scenario: 'realistic' } });

  /* A SPARSE SERIES. New Zealand sells on about a third of days, and a 0 there
     is a measurement, not an unfilled cell. Read the empty days as gaps and the
     28-day level becomes the mean of the selling days only, then gets applied
     to every day of the horizon — the forecast inflates by the reciprocal of
     the trading frequency. Both facts below are the reason the country lens
     declares itself sparse, and the reason its NZ tile shows measured error
     instead of a year-on-year arrow. */
  const sparseRows = REAL.map((r, i) => ({
    date: r.date,
    revenue: (i % 3 === 0) ? r.revenue * 3 : 0,      // same total, a third of the days
  }));
  const dense = F.project({ rows: sparseRows, from: '2026-09-08', horizon: 90, scenario: 'realistic' });
  const sprs  = F.project({ rows: sparseRows, from: '2026-09-08', horizon: 90, scenario: 'realistic', sparse: true });
  ok('sparse: reading empty days as gaps inflates the level ~3x',
     dense.level > sprs.level * 2.2, [dense.level, sprs.level, dense.level / sprs.level]);
  ok('sparse: and the total with it', dense.total > sprs.total * 2.2,
     [Math.round(dense.total), Math.round(sprs.total)]);
  const realTotal = F.project({ rows: REAL, from: '2026-09-08', horizon: 90, scenario: 'realistic' });
  ok('sparse: declared, it lands near the series it was built from (same money, fewer days)',
     Math.abs(sprs.total / realTotal.total - 1) < 0.2, [Math.round(sprs.total), Math.round(realTotal.total)]);
  ok('sparse: a dense series is untouched by the flag',
     Math.abs(F.project({ rows: REAL, from: '2026-09-08', horizon: 90, scenario: 'realistic', sparse: true }).total
              / realTotal.total - 1) < 1e-9);
  const btDense = F.backtest(sparseRows, { model: { scenario: 'realistic' } });
  const btSparse = F.backtest(sparseRows, { sparse: true, model: { scenario: 'realistic' } });
  ok('sparse: undeclared, no origin can score at all (every horizon looks incomplete)',
     btDense[30] === null, btDense[30] && btDense[30].n);
  ok('sparse: declared, it is measurable', btSparse[30] && btSparse[30].n > 10, btSparse[30] && btSparse[30].n);
  const btReal = F.backtest(REAL, { sparse: true, model: { scenario: 'realistic' } });
  ok('sparse: and the flag does not move a dense backtest',
     Math.abs(btReal[30].mape - bt0[30].mape) < 1e-9, [btReal[30].mape, bt0[30].mape]);

  /* Why the page cannot quote revenue's accuracy under another lens. The
     returning-customer count is a small difference between two larger numbers,
     so it is far noisier than revenue; showing revenue's ±13% beside it would
     understate the error on screen by more than double. Each lens measures its
     own series, and the cell names the worst one. */
  const btOrd = F.backtest(F.asMetric(REAL, 'orders'), { model: { scenario: 'realistic' } });
  const btNew = F.backtest(F.asMetric(REAL, 'newOrders'), { model: { scenario: 'realistic' } });
  const btRet = F.backtest(
    F.asMetric(REAL, r => Math.max(0, (r.orders || 0) - (r.newOrders || 0))),
    { model: { scenario: 'realistic' } });
  const bt = F.backtest(REAL, { model: { scenario: 'realistic' } });
  ok('real: a derived series is measurable at all', btOrd[30] && btRet[30] && btNew[30],
     [btOrd[30] && btOrd[30].n, btRet[30] && btRet[30].n]);
  ok('real: returning customers are materially harder to forecast than revenue',
     btRet[30].mape > bt[30].mape * 1.5,
     [bt[30].mape.toFixed(3), btRet[30].mape.toFixed(3)]);
  ok('real: and the gap widens at 90 days',
     btRet[90].mape > bt[90].mape * 1.5,
     [bt[90].mape.toFixed(3), btRet[90].mape.toFixed(3)]);
  ok('real: so the worst series of the customers lens is the returning one',
     btRet[30].mape > btNew[30].mape,
     [btNew[30].mape.toFixed(3), btRet[30].mape.toFixed(3)]);
  ok('real: 30-day error with a prior year stays under 20%', bt[30].mape < 0.2, bt[30].mape);
  ok('real: 90-day error with a prior year stays under 25%', bt[90].mape < 0.25, bt[90].mape);
  ok('real: a prior year roughly halves the error vs having none',
     bt[30].coldStart && bt[30].mape < bt[30].coldStart.mape * 0.75,
     [bt[30].mape, bt[30].coldStart && bt[30].coldStart.mape]);
}

console.log(`forecast: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
