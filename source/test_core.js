/* Unit tests for core.js — the shared period/aggregate/breakeven math.
   Run: node source/test_core.js   (exit 0 = all pass) */
const C = require('../core.js');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}
const near = (a, b, t = 0.01) => Math.abs(a - b) < t;

/* ---- periodSlices: the bug class (offset clamping + no negative-index slices) ---- */
// 181-day array 0..180 (like Jan1..Jun30), anchor = 180.
const daily = Array.from({ length: 181 }, (_, i) => ({ date: '2026-01-01', v: i }));
(() => {
  const s0 = C.periodSlices(daily, 180, 30, 0);
  ok('30D off0 → 30-day cur', s0.cur.length === 30, s0.cur.length);
  ok('30D off0 → 30-day prev', s0.prev.length === 30, s0.prev.length);

  const s1 = C.periodSlices(daily, 180, 30, 1);
  ok('30D off1 cur ends before off0', s1.cur[s1.cur.length-1].v === 150, s1.cur[s1.cur.length-1].v);

  // The exact bug: large off must clamp, never return a wrong-length or negative slice.
  const sBig = C.periodSlices(daily, 180, 30, 20);
  ok('30D off20 clamps off', sBig.off === 6, sBig.off);
  ok('30D off20 cur non-empty & ≤ P', sBig.cur.length >= 1 && sBig.cur.length <= 30, sBig.cur.length);
  ok('30D off20 cur NOT a giant slice', sBig.cur.length !== 152, sBig.cur.length);

  const s7 = C.periodSlices(daily, 180, 7, 999);
  ok('7D off999 clamps & valid', s7.cur.length >= 1 && s7.cur.length <= 7, s7.cur.length);

  const s90 = C.periodSlices(daily, 180, 90, 0);
  ok('90D off0 → 90 cur + 90 prev', s90.cur.length === 90 && s90.prev.length === 90, [s90.cur.length, s90.prev.length]);

  // At max offset the prior period may be empty — must be [] not a negative slice.
  const sMax = C.periodSlices(daily, 180, 30, 6);
  ok('30D max off prev is empty array', Array.isArray(sMax.prev) && sMax.prev.length === 0, sMax.prev.length);
})();

/* ---- aggregate: sums + recomputed rates, empty guard ---- */
(() => {
  ok('aggregate([]) → null', C.aggregate([]) === null);
  const rows = [
    { date: 'a', revenue: 100, revExGst: 90, orders: 4, newOrders: 3, items: 20, sessions: 200, metaNew: 10, metaTotal: 25, totalAds: 25, totalVC: 40, totalFC: 10, profit: 15 },
    { date: 'b', revenue: 300, revExGst: 270, orders: 6, newOrders: 3, items: 30, sessions: 300, metaNew: 20, metaTotal: 35, totalAds: 35, totalVC: 120, totalFC: 10, profit: 45 },
  ];
  const a = C.aggregate(rows);
  ok('sum revenue', a.revenue === 400, a.revenue);
  ok('sum orders', a.orders === 10, a.orders);
  ok('AOV = rev/orders', a.aov === 40, a.aov);
  ok('CVR = orders/sessions %', near(a.cvr, 10/500*100), a.cvr);
  ok('MER = ads/rev %', near(a.mer, 60/400*100), a.mer);
  ok('ROAS = rev/ads', near(a.roas, 400/60), a.roas);
  ok('date = last row', a.date === 'b', a.date);
})();

/* ---- breakeven: zone ⟺ profit sign; thresholds ---- */
(() => {
  // profitable day: MER below profit-breakeven → green
  const g = C.breakeven({ revenue: 16701.63, revExGst: 15370.54, totalVC: 8247.08, totalFC: 2374.37, mer: 26.28 });
  ok('breakeven full ~28.4%', near(g.full, 28.43, 0.1), g.full);
  ok('breakeven cash ~42.7%', near(g.contrib, 42.65, 0.1), g.contrib);
  ok('profitable → green', g.zone === 'g' && g.signal === 'Scale', g.zone);
  ok('headroom = full − mer', near(g.headroom, g.full - 26.28), g.headroom);

  // burning day: MER above cash breakeven → red
  const b = C.breakeven({ revenue: 9389, revExGst: 8560, totalVC: 4200, totalFC: 2374, mer: 64.7 });
  ok('burning → red / Pull back', b.zone === 'b' && b.signal === 'Pull back', b.zone);

  ok('breakeven zero-rev → null', C.breakeven({ revenue: 0 }) === null);
})();


/* ---- windowBaselines: the Pulse page's day-vs-history, over a window ---- */
(() => {
  const vals = Array.from({ length: 40 }, (_, i) => i);
  const flow = { vals };
  const one = C.windowBaselines(flow, 39, 1);
  ok('win1: y is the day itself', one.y === 39, one.y);
  ok('win1: b3 is the three days before', near(one.b3, 37), one.b3);
  ok('win1: b30 is the thirty before', near(one.b30, (9 + 38) / 2), one.b30);
  ok('win1: weekday baseline averages the same weekday in the prior 4 weeks', near(one.bwk, (32 + 25 + 18 + 11) / 4), one.bwk);
  const three = C.windowBaselines(flow, 39, 3);
  ok('win3: y is the mean of the window', near(three.y, 38), three.y);
  ok('win3: b3 sits before the window, not inside it', near(three.b3, 35), three.b3);
  ok('win3: weekday baseline is the same 3-day window in each prior week', near(three.bwk, (31 + 24 + 17 + 10) / 4), three.bwk);
  ok('win3: start index is reported', three.start === 37, three.start);
  const pooled = C.windowBaselines({ vals: [10, 20], dens: [100, 300] }, 1, 2);
  ok('rates pool by denominator, not as equals', near(pooled.y, 17.5), pooled.y);
  ok('and report the pooled denominator', pooled.den === 400, pooled.den);
  ok('a null day inside the window is skipped, not zero', near(C.windowBaselines({ vals: [10, null, 30] }, 2, 3).y, 20));
  ok('a window that runs off the start is null', C.windowBaselines(flow, 1, 3) === null);
  ok('too little history means no 30-day baseline', C.windowBaselines(flow, 5, 1).b30 === null);
})();

/* ---- the shop's day: AEST, no daylight saving ---- */
(() => {
  const t = new Date('2026-09-10T23:30:00Z');                       // 09:30 on the 11th in Brisbane
  ok('today in AEST rolls over before UTC does', C.todayAEST(t) === '2026-09-11', C.todayAEST(t));
  ok('previous day AEST is the shop\'s yesterday', C.previousDayAEST(t) === '2026-09-10', C.previousDayAEST(t));
  ok('...and does not roll early', C.previousDayAEST(new Date('2026-09-10T13:00:00Z')) === '2026-09-09');
  ok('January behaves like July — no daylight saving',
     C.todayAEST(new Date('2026-01-10T14:30:00Z')) === '2026-01-11' && C.todayAEST(new Date('2026-07-10T14:30:00Z')) === '2026-07-11');
})();

/* ---- shopifyFill: days the sheet has not been given yet ---- */
(() => {
  const sheet = [{ date: '2026-09-07', revenue: 11957.87 }, { date: '2026-09-08', revenue: 10905.13 }];
  const recent = [
    { date: '2026-09-07', total: 11957.87, net: 10394.06, orders: 50 },
    { date: '2026-09-08', total: 10905.13, net: 9617.52, orders: 39 },
    { date: '2026-09-09', total: 13734.31, net: 12059.13, orders: 38 },
    { date: '2026-09-10', total: 19499.28, net: 17119.07, orders: 58 },
    { date: '2026-09-11', total: 6061.67, net: 5216.99, orders: 21 },     // today, still trading
  ];
  const fill = C.shopifyFill(sheet, recent, '2026-09-11');
  ok('only full days after the sheet\'s last entry are filled', fill.map(r => r.date).join() === '2026-09-09,2026-09-10', fill.map(r => r.date));
  ok('today\'s partial day is never a day', !fill.some(r => r.date === '2026-09-11'));
  ok('revenue is Shopify total_sales — the figure the sheet itself carries', fill[0].revenue === 13734.31, fill[0].revenue);
  ok('orders come through', fill[1].orders === 58);
  ok('AOV is derived', near(fill[1].aov, 19499.28 / 58, 0.01), fill[1].aov);
  ok('the row is flagged provisional', fill[0].provisional === 'shopify');
  ok('and pending ad spend and profit, like any half-entered day', fill[0].pending.join() === 'adSpend,profit');
  ok('nothing the sheet adds is invented', fill[0].sessions == null && fill[0].totalAds == null && fill[0].profit == null);
  ok('a day the sheet already has is never overwritten', !fill.some(r => r.date === '2026-09-08'));
  ok('an empty Shopify answer fills nothing', C.shopifyFill(sheet, [], '2026-09-11').length === 0);
  ok('a day with no sales is not a day', C.shopifyFill(sheet, [{ date: '2026-09-09', total: 0, orders: 0 }], '2026-09-11').length === 0);
})();

console.log(`\ncore.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
