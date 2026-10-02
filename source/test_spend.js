/* Unit tests for lib/spend.js — the spend ↔ revenue link, unit economics and
   spend bands behind spend.html. */
const L = require('../lib/spend.js');
const core = require('../core.js');
let pass = 0, fail = 0;
const ok = (n, c, g) => { if (c) pass++; else { fail++; console.log(`  ✗ ${n}` + (g !== undefined ? `  (got ${JSON.stringify(g)})` : '')); } };
const near = (a, b, t = 1e-6) => a != null && Math.abs(a - b) <= t;

/* ---------------------------------------------------------------- ols ---- */
const line = L.ols([1, 2, 3, 4], [3, 5, 7, 9]);                       // y = 2x + 1
ok('ols: recovers slope and intercept of a clean line', near(line.slope, 2) && near(line.intercept, 1), line);
ok('ols: r is 1 on a perfect positive line', near(line.r, 1) && near(line.r2, 1), [line.r, line.r2]);
ok('ols: r is -1 on a perfect negative line', near(L.ols([1, 2, 3], [9, 6, 3]).r, -1));
ok('ols: under three points there is nothing to fit', L.ols([1, 2], [2, 4]) === null);
/* A column with no spread has no slope, and sxx = 0 would make one up as
   Infinity or NaN and paint it on the chart as a vertical trend line. */
ok('ols: a series with no variance returns null rather than a NaN fit', L.ols([5, 5, 5, 5], [1, 2, 3, 4]) === null);
ok('ols: non-numeric pairs are dropped, not coerced to zero',
   near(L.ols([1, 2, null, 3, 4], [3, 5, 9, 7, 9]).slope, 2), L.ols([1, 2, null, 3, 4], [3, 5, 9, 7, 9]));
ok('corr: is the r of the same fit', near(L.corr([1, 2, 3, 4], [3, 5, 7, 9]), 1));

/* ------------------------------------------------------- unit economics ---

   One day, chosen so every rate is exact: gross 1100 (GST 100), variable 400,
   fixed 200, ads 250, profit = 1000 - 400 - 250 - 200 = 150. */
const day = (date, o) => Object.assign({ date, revenue: 1100, revExGst: 1000, totalVC: 400, totalFC: 200,
  totalAds: 250, metaTotal: 250, profit: 150 }, o || {});
const e = L.economics([day('2026-09-01'), day('2026-09-02')]);
ok('economics: MER is revenue over ad spend', near(e.mer, 2200 / 500), e.mer);
/* The sheet's `mer` column holds the reciprocal of this, which is the single
   easiest way to put a wrong number on this page. */
ok('economics: adPct is the ad COST ratio, the reciprocal of MER',
   near(e.adPct, 500 / 2200 * 100) && near(e.mer * e.adPct / 100, 1), [e.mer, e.adPct]);
ok('economics: contribution is ex-GST revenue less variable costs', near(e.contribution, 2000 - 800), e.contribution);
/* Break-even is derived from the profit identity the book actually satisfies —
   revExGst − totalVC − totalAds − totalFC — so it can never disagree with the
   profit printed beside it. */
ok('economics: break-even ad spend takes profit to exactly zero',
   near(e.contribution - e.fc - (e.ads + e.profit), 0), [e.contribution, e.fc, e.ads, e.profit]);
ok('economics: break-even MER is revenue over that spend', near(e.beMer, 2200 / 800), e.beMer);
ok('economics: cash break-even ignores fixed costs and is the kinder of the two',
   near(e.beCashMer, 2200 / 1200) && e.beCashMer < e.beMer, [e.beCashMer, e.beMer]);
ok('economics: headroom is, identically, the period profit', near(e.headroom, e.profit), [e.headroom, e.profit]);
ok('economics: MER above break-even is the scale zone', e.mer > e.beMer && e.zone === 'g', [e.mer, e.beMer, e.zone]);
ok('economics: meta share of ad spend', near(e.metaShare, 100), e.metaShare);
ok('economics: rates sum back to the revenue dollar',
   near(e.gstPct + e.vcPct + e.fcPct + e.adPct + e.profitPct, 100, 1e-9),
   [e.gstPct, e.vcPct, e.fcPct, e.adPct, e.profitPct]);

const hold = L.economics([day('2026-09-01', { totalAds: 500, profit: -100 })]);
ok('economics: spend between the two break-evens is the hold zone', hold.zone === 'a', hold.zone);
const under = L.economics([day('2026-09-01', { totalAds: 700, profit: -300 })]);
ok('economics: spend past the cash break-even is pull-back', under.zone === 'b', under.zone);
/* With variable costs above ex-GST revenue no amount of advertising pays for
   itself. A break-even MER printed here would read as one that does. */
const upside = L.economics([day('2026-09-01', { totalVC: 1200 })]);
ok('economics: negative contribution has no break-even MER rather than a negative one',
   upside.beMer === null && upside.beCashMer === null && upside.zone === 'b', [upside.beMer, upside.beCashMer]);
ok('economics: an empty window is null, not a zero-filled record', L.economics([]) === null);

/* ------------------------------------------------------------ the link ---- */
/* Five whole weeks plus a 3-day stub, so weeklyBuckets produces five real
   weeks and one short one. */
const days = [];
for (let i = 0; i < 38; i++) {
  const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  /* Profit varies with the row: a fixture whose profit is the same every day has
     no variance for a profit fit to find, and ols correctly returns null for it. */
  const ads = 200 + i * 10;
  days.push(day(d, { totalAds: ads, metaTotal: ads, revenue: 900 + i * 45, profit: 400 - ads + i * 6 }));
}
const weeks = core.weeklyBuckets(days);
ok('wholeWeeks: the trailing stub is not a week', weeks.length === 6 && L.wholeWeeks(weeks).length === 5,
   weeks.map(w => w.days));
const lk = L.link(days, weeks);
/* Six buckets go in and five points come out: the stub carries half a week of
   spend and, as one point in a short fit, the leverage of a whole one. */
ok('link: the weekly fit uses whole weeks only', lk.weekly.n === 5, lk.weekly && lk.weekly.n);
ok('link: the daily fit uses every day', lk.daily.n === 38, lk.daily && lk.daily.n);
ok('link: elasticity is withheld under the minimum number of weeks',
   lk.elastic === null && lk.minElastic === L.MIN_ELASTIC, lk.elastic);
/* A four-week window has four weekly points and no weekly elasticity, which is
   exactly when the short windows need one. Measured on days instead. */
ok('link: a window too short for a weekly elasticity still has a daily one',
   lk.elasticDay !== null && lk.elasticDay.n === 38 && lk.minElasticDays === L.MIN_ELASTIC_DAYS,
   lk.elasticDay && lk.elasticDay.n);
ok('link: profit is fitted in both units', lk.profit !== null && lk.profitDay !== null && lk.profitDay.n === 38,
   lk.profitDay && lk.profitDay.n);

/* A day that sold on no recorded ad spend is the shape of a perfect
   correlation and has no logarithm. It must not reach any fit. */
const withZero = days.concat([day('2026-02-07', { totalAds: 0, metaTotal: 0, revenue: 11000 })]);
const lkz = L.link(withZero, core.weeklyBuckets(withZero));
ok('link: a zero-spend day is counted and excluded, not silently kept',
   lkz.days === 38 && lkz.noSpendDays === 1, [lkz.days, lkz.noSpendDays]);
ok('link: and it does not reach the daily fit',
   lkz.daily.n === 38 && Math.abs(lkz.daily.slope - lk.daily.slope) < 1e-9,
   [lkz.daily.n, lkz.daily.slope, lk.daily.slope]);
ok('link: economics still counts its revenue \u2014 the sale happened',
   L.economics(withZero).revenue === L.economics(days).revenue + 11000,
   [L.economics(withZero).revenue, L.economics(days).revenue]);

/* Enough weeks for an elasticity, built so revenue is exactly spend^0.5 — a
   textbook diminishing return the fit has to recover. */
const long = [];
for (let i = 0; i < 7 * 20; i++) {
  const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  const ads = 100 + (Math.floor(i / 7) * 40);
  long.push(day(d, { totalAds: ads, metaTotal: ads, revenue: Math.sqrt(ads) * 50 }));
}
const lk2 = L.link(long, core.weeklyBuckets(long));
ok('link: elasticity recovers a square-root response as ~0.5', near(lk2.elastic.slope, 0.5, 0.02), lk2.elastic.slope);
ok('link: twenty weeks is enough to report one', lk2.weeks === 20 && lk2.elastic.n === 20, [lk2.weeks, lk2.elastic.n]);

/* ---------------------------------------------------------------- lags ---- */
const lags = L.lagProfile(days, 3);
ok('lagProfile: one entry per lag, same day included', lags.length === 4 && lags[0].lag === 0, lags.map(x => x.lag));
ok('lagProfile: each lag drops that many pairs off the end',
   lags[0].n === 38 && lags[1].n === 37 && lags[3].n === 35, lags.map(x => x.n));
/* Revenue built to follow spend two days later must peak at +2, or the lag test
   cannot detect the thing it exists to detect. The spend has to wander for the
   test to mean anything: against a steadily rising series every lag correlates
   at 1.00 and a delayed response is indistinguishable from an instant one. */
const noisy = [];
for (let i = 0; i < 60; i++) {
  const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
  const ads = 200 + ((i * 37) % 13) * 25;
  noisy.push(day(d, { totalAds: ads, metaTotal: ads }));
}
noisy.forEach((d, i) => { d.revenue = 500 + noisy[Math.max(0, i - 2)].totalAds * 4; });
const sl = L.lagProfile(noisy, 3);
ok('lagProfile: a two-day delayed response peaks at +2',
   sl[2].r > sl[0].r && sl[2].r > sl[1].r && sl[2].r > sl[3].r, sl.map(x => +x.r.toFixed(3)));

/* --------------------------------------------------------------- bands ---- */
ok('bands: fewer than the minimum weeks yields no bands at all', L.bands(core.weeklyBuckets(days)) === null);
/* The same window, counted in days, is exactly what the short periods are for:
   five weeks is five points and no bands, 38 days is four bands of nine. */
const bd = L.bands(days, 'day');
ok('bands: the same window cut by day where it could not be cut by week',
   bd && bd.unit === 'day' && bd.units === 38 && bd.q === 4, bd && [bd.unit, bd.units, bd.q]);
ok('bands: a day band reports per-day figures, not per-week ones',
   near(bd.bands[0].spendPer, bd.bands[0].ads / bd.bands[0].n) && bd.bands[0].unit === 'day',
   bd.bands[0]);
ok('bandCount: steps down with the window rather than splitting twelve units five ways',
   L.bandCount(52) === 5 && L.bandCount(26) === 4 && L.bandCount(12) === 3 && L.bandCount(8) === 0,
   [L.bandCount(52), L.bandCount(26), L.bandCount(12), L.bandCount(8)]);
ok('bandCount: the floor is the declared minimum', L.bandCount(L.MIN_BAND_UNITS) === 3 && L.bandCount(L.MIN_BAND_UNITS - 1) === 0);
const b = L.bands(core.weeklyBuckets(long));
ok('bands: twenty weeks cuts into four', b.q === 4 && b.bands.length === 4 && b.units === 20 && b.unit === 'week',
   b && [b.q, b.units]);
ok('bands: every week lands in exactly one band',
   b.bands.reduce((a, x) => a + x.n, 0) === 20, b.bands.map(x => x.n));
ok('bands: ordered by spend, lowest first',
   b.bands.every((x, i) => i === 0 || x.spendPer > b.bands[i - 1].spendPer), b.bands.map(x => Math.round(x.spendPer)));
/* Pooled, not an average of the weeks' own ratios: a quiet week and a peak week
   must not count equally towards a band's MER. */
const top = b.bands[b.bands.length - 1];
ok('bands: MER is pooled from the band\'s sums', near(top.mer, top.revenue / top.ads), [top.mer, top.revenue / top.ads]);
ok('bands: a square-root response makes the top band the least efficient',
   top.mer < b.bands[0].mer, b.bands.map(x => +x.mer.toFixed(3)));

/* ------------------------------------------------- the book's own naming ---

   The guard that keeps this page honest. The sheet ships a column called `mer`
   that holds the ad COST ratio and a column called `roas` that holds the real
   MER. Nothing on this page may read `mer` as MER, so the mislabel is asserted
   here: when the sheet is ever fixed, this test fails and says so. */
global.window = {};
require('../data.js');
const rows = (global.window.DL_DATA && global.window.DL_DATA.daily || [])
  .filter(d => d && d.revenue > 0 && d.totalAds > 0 && d.mer != null && d.roas != null);
ok('data.js: there are rows to check the naming against', rows.length > 50, rows.length);
const asCost = rows.filter(d => near(d.mer, d.totalAds / d.revenue * 100, 0.05)).length;
const roasIsMer = rows.filter(d => near(d.roas, d.revenue / d.totalAds, 0.01)).length;
ok('data.js: the `mer` column is ad spend over revenue — a COST ratio, not MER',
   asCost === rows.length, `${asCost} of ${rows.length}`);
ok('data.js: the `roas` column is the real MER', roasIsMer === rows.length, `${roasIsMer} of ${rows.length}`);
/* And the page's own numbers are built from the raw sums, so they agree with
   the columns regardless of what those columns are called. */
const real = L.economics(rows);
ok('economics: agrees with the book\'s own roas column on blended MER',
   near(real.mer, L.sum(rows, 'revenue') / L.sum(rows, 'totalAds'), 1e-9), real.mer);

console.log(`\ntest_spend: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
