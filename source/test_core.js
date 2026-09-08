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

console.log(`\ncore.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
