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
  ok('real: corrected, the rest of the year lands on the underlying trend (x1.5-x1.9)',
     ratios.every(r => r > 1.5 && r < 1.9), ratios.map(r => +r.toFixed(2)));
  const bareRatios = bare.months.filter(m => ly2[m.month]).map(m => m.revenue / ly2[m.month]);
  ok('real: uncorrected, it runs above every year-on-year month ever recorded',
     bareRatios.some(r => r > growth.high), bareRatios.map(r => +r.toFixed(2)));

  const bt = F.backtest(REAL, { model: { scenario: 'realistic' } });
  ok('real: 30-day error with a prior year stays under 20%', bt[30].mape < 0.2, bt[30].mape);
  ok('real: 90-day error with a prior year stays under 25%', bt[90].mape < 0.25, bt[90].mape);
  ok('real: a prior year roughly halves the error vs having none',
     bt[30].coldStart && bt[30].mape < bt[30].coldStart.mape * 0.75,
     [bt[30].mape, bt[30].coldStart && bt[30].coldStart.mape]);
}

console.log(`forecast: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
