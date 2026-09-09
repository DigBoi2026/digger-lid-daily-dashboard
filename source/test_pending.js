/* Unit tests for PENDING vs ZERO — api/data.js markPending + core.js propagation.
   Run: node source/test_pending.js   (exit 0 = all pass)

   Why this file exists: on 2026-09-08 the P&L sheet had revenue, orders and
   sessions but no Meta ad spend yet — it is typed in a day later, and every
   formula beneath it evaluates to $0.00 rather than blank. The board treated
   that as a real zero and reported a 0.0% MER, a 4.24x ROAS, a "Scale" spend
   signal and an 18.3% profit margin (+416% vs the 3-day average) on a day that
   was closer to a 25% loss. It was advising more spend off an empty cell.

   These tests pin the rule: an input that has not been filled in yet is pending,
   never zero, and nothing downstream may average it, sum it, compare it to a
   baseline, or colour a traffic light with it. */
const D = require('../api/data.js');
const C = require('../core.js');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) pass++;
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
};

/* ---------------- markPending: what counts as pending ---------------- */
const day = (over = {}) => D.markPending(Object.assign({
  date: '2026-09-08', revenue: 10905, orders: 39, sessions: 5453,
  revExGst: 10014, totalVC: 5315, totalFC: 2707, totalExp: 8022, profit: 1992, profitPct: 18.27,
  metaTotal: 4600, metaNew: 3000, google: 0, tiktok: 0, totalAds: 4600,
  mer: 42.2, mer3: 30, roas: 2.37, cpv: 0.84, cpp: 118, ncpa: 100,
}, over));

ok('a fully entered trading day is not pending', day().pending === null, day().pending);

const zero = day({ metaTotal: 0, metaNew: 0, totalAds: 0, mer: 0, roas: 0, cpv: 0, cpp: 0, ncpa: 0 });
ok('$0 ad spend on a trading day is pending', Array.isArray(zero.pending) && zero.pending.includes('adSpend'), zero.pending);
ok('...and flags profit too, since it excludes that spend', zero.pending.includes('profit'), zero.pending);
ok('MER is blanked, not left at 0', zero.mer === null, zero.mer);
ok('ROAS is blanked, not left at 0', zero.roas === null, zero.roas);
ok('cost-per-visit is blanked', zero.cpv === null, zero.cpv);
ok('cost-per-purchase is blanked', zero.cpp === null, zero.cpp);
ok('new-customer CPA is blanked', zero.ncpa === null, zero.ncpa);
ok('ad spend itself is blanked, not 0', zero.totalAds === null && zero.metaTotal === null, [zero.totalAds, zero.metaTotal]);
ok('revenue is untouched — it was entered', zero.revenue === 10905, zero.revenue);
ok('sessions are untouched', zero.sessions === 5453, zero.sessions);
ok('PROFIT keeps the sheet figure (overstated, not absent)', zero.profit === 1992, zero.profit);

const nul = day({ metaTotal: null, totalAds: null, mer: null });
ok('a null spend cell is pending too', nul.pending && nul.pending.includes('adSpend'), nul.pending);

// A future or empty row is NOT pending — it is simply not a trading day. Calling
// it pending would flag every unstarted day in the month.
const future = D.markPending({ date: '2026-09-30', revenue: 0, orders: 0, sessions: 0, totalAds: 0 });
ok('a future/blank day is not pending', future.pending === null, future.pending);

// A genuine zero-spend day that still traded must be treated as pending too:
// nothing in the sheet distinguishes "spent nothing" from "not entered yet", and
// guessing wrong in the other direction is what caused the original fault.
const traffic = D.markPending({ date: '2026-09-08', revenue: 0, orders: 0, sessions: 800, totalAds: 0 });
ok('traffic with no spend counts as a trading day', traffic.pending && traffic.pending.includes('adSpend'), traffic.pending);

/* ---------------- propagation through a window ---------------- */
const clean = d => ({ date: d, revenue: 1000, revExGst: 920, orders: 5, sessions: 400,
  totalAds: 300, metaTotal: 300, totalVC: 400, totalFC: 200, profit: 20, mer: 30, pending: null });
const pend  = d => Object.assign(clean(d), { totalAds: null, metaTotal: null, mer: null, pending: ['adSpend','profit'] });

const w3  = C.aggregate([clean('2026-09-06'), clean('2026-09-07'), pend('2026-09-08')]);
const w30 = C.aggregate([...Array(29)].map((_, i) => clean('2026-08-' + String(i + 10).padStart(2, '0'))).concat([pend('2026-09-08')]));
const wOK = C.aggregate([clean('2026-09-06'), clean('2026-09-07')]);

ok('a clean window carries no pending flag', wOK.pending === null, wOK.pending);
ok('one pending day flags the whole window', w3.pending && w3.pending.days === 1, w3.pending);
ok('the window records its own length', w3.pending.of === 3 && w30.pending.of === 30, [w3.pending.of, w30.pending.of]);
ok('the pending date is named, for the UI to show', w3.pending.dates[0] === '2026-09-08', w3.pending.dates);
ok('isPending finds the group', C.isPending(w3, 'adSpend') === true);
ok('isPending is false for an unaffected group', C.isPending(w3, 'traffic') === false);

/* ---------------- proportionate presentation ---------------- */
// 1 day of 3 moved the real MER by 12 points, so the figure is not worth showing.
// 1 day of 30 moves it under a point; blanking that would hide a real signal to
// guard against a rounding error.
ok('1-of-3 pending suppresses the figure', C.pendingMode(w3, 'adSpend') === 'blank', C.pendingMode(w3, 'adSpend'));
ok('1-of-30 pending shows it, qualified', C.pendingMode(w30, 'adSpend') === 'qualify', C.pendingMode(w30, 'adSpend'));
ok('a clean window has no mode', C.pendingMode(wOK, 'adSpend') === null);
ok('the qualifier states the shortfall', C.pendingLabel(w30) === '1 of 30 days pending', C.pendingLabel(w30));

/* ---------------- the spend signal is never derived from a partial total ---------------- */
ok('breakeven() returns a signal on clean data', !!C.breakeven(wOK), C.breakeven(wOK));
ok('breakeven() is withheld while spend is pending — no false "Scale"',
   C.breakeven(w3) === null, C.breakeven(w3));
ok('...withheld even when only 1 day of 30 is missing (a directive, not a datum)',
   C.breakeven(w30) === null, C.breakeven(w30));

/* ---------------- the rolling-average lead-in ---------------- */
const arr = [10, 20, 30, 40, 50, 60, 70, 80, 90];
const noLead = C.rollingAvg(arr, 7);
const withLead = C.rollingAvg(arr, 7, 6);
ok('without a lead-in the first point is a 1-point mean', noLead[0] === 10, noLead[0]);
ok('the lead-in drops the short windows', withLead.length === arr.length - 6, withLead.length);
ok('the first plotted point is a true 7-point mean', Math.abs(withLead[0] - 40) < 1e-9, withLead[0]);

/* ---------------- gstPct matches the sheet's own definition ---------------- */
// The sheet states GST as a rate on the NET amount. Computed over gross this
// returned 8.17% where the sheet said 8.90% for the same day.
const g = C.aggregate([{ date: '2026-09-07', revenue: 100, revExGst: 91.83, orders: 1, sessions: 1 }]);
ok('gstPct is GST over ex-GST revenue', Math.abs(g.gstPct - 8.90) < 0.02, g.gstPct);
ok('mer3 is null over a window, not plain MER re-labelled', g.mer3 === null, g.mer3);

console.log(`\npending: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
