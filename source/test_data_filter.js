/* Unit tests for api/data.js — the real-data filter, latestDataDate, and the
   row-offset probe. Run: node source/test_data_filter.js  (exit 0 = all pass)

   No network and no credentials: parseDaily is fed synthetic grids shaped like
   the sheet (header row of " 1 Aug " labels, day-of-week row, then metric rows
   at the indices ROWS expects). */
const D = require('../api/data.js');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}

// Build a grid with `days` day-columns; `vals` maps a row index to per-day values.
function grid(days, vals, labels) {
  const g = [];
  g[0] = ['']; g[1] = [''];
  for (let d = 1; d <= days; d++) { g[0][d] = ` ${d} Aug `; g[1][d] = 'Mon'; }
  for (let i = 2; i < 130; i++) g[i] = [(labels && labels[i]) || ''];
  Object.entries(vals || {}).forEach(([row, arr]) => {
    const r = Number(row);
    g[r] = [(labels && labels[r]) || ''];
    arr.forEach((v, d) => { g[r][d + 1] = v; });
  });
  return g;
}
const REV = 62, SESS = 71, ORD = 68;

/* ---- the bug: a skeleton month tab must yield no rows ---- */
(() => {
  // Every day blank except a literal 0 in the sessions row — the live Sep '26 tab.
  const g = grid(30, { [SESS]: Array(30).fill('0') });
  const rows = D.parseDaily(g, 9);
  ok('skeleton tab (sessions all 0) → no rows', rows.length === 0, rows.length);
})();

(() => {
  // Genuine trading days survive.
  const g = grid(3, { [REV]: ['$1,000.00', '$2,000.00', '$3,000.00'], [SESS]: ['120', '130', '140'] });
  const rows = D.parseDaily(g, 8);
  ok('real revenue → 3 rows', rows.length === 3, rows.length);
  ok('revenue parsed', rows[0].revenue === 1000, rows[0].revenue);
  ok('date built from month', rows[0].date === '2026-08-01', rows[0].date);
})();

(() => {
  // A closed day: zero revenue but real sessions is still a trading day.
  const g = grid(1, { [REV]: ['$0.00'], [SESS]: ['45'] });
  ok('zero revenue + sessions → kept', D.parseDaily(g, 8).length === 1);
})();

(() => {
  // Orders alone is enough.
  const g = grid(1, { [ORD]: ['7'] });
  ok('orders only → kept', D.parseDaily(g, 8).length === 1);
})();

(() => {
  // sessions === 0 with nothing else is the skeleton signature.
  ok('sessions 0 alone → dropped', D.parseDaily(grid(1, { [SESS]: ['0'] }), 8).length === 0);
  ok('wholly blank → dropped', D.parseDaily(grid(1, {}), 8).length === 0);
})();

/* ---- latestDataDate must be the last row WITH data ---- */
(() => {
  const daily = [
    { date: '2026-09-01', revenue: 100, orders: 2, sessions: 50 },
    { date: '2026-09-02', revenue: 200, orders: 3, sessions: 60 },
    { date: '2026-09-03', revenue: null, orders: null, sessions: 0 },
    { date: '2026-09-30', revenue: null, orders: null, sessions: 0 },
  ];
  ok('latestDataDate skips trailing blanks', D.lastDataDate(daily) === '2026-09-02', D.lastDataDate(daily));
  ok('all-blank → null', D.lastDataDate([{ date: '2026-09-30', revenue: null, orders: null, sessions: 0 }]) === null);
  ok('empty → null', D.lastDataDate([]) === null);
})();

/* ---- hasData predicate ---- */
(() => {
  ok('hasData: revenue', D.hasData({ revenue: 1 }) === true);
  ok('hasData: zero revenue counts', D.hasData({ revenue: 0 }) === true);
  ok('hasData: sessions 0 only', D.hasData({ revenue: null, orders: null, sessions: 0 }) === false);
  ok('hasData: sessions positive', D.hasData({ revenue: null, orders: null, sessions: 1 }) === true);
  ok('hasData: nothing', D.hasData({}) === false);
})();

/* ---- probe locates the metric block, in any leading column ---- */
(() => {
  const labels = { [REV]: 'Revenue', [SESS]: 'Sessions', [ORD]: 'Orders' };
  const aligned = D.probe(grid(30, { [SESS]: Array(30).fill('0') }, labels));
  ok('probe: finds Revenue at the expected row', aligned.found.revenue.row === REV, aligned.found.revenue);
  ok('probe: reports the label column', aligned.found.revenue.col === 0, aligned.found.revenue);
  ok('probe: verdict blames the sheet', /no figures entered/.test(aligned.verdict), aligned.verdict);
  ok('probe: counts day columns', aligned.dayColumns === 30, aligned.dayColumns);
  ok('probe: dumps row labels', aligned.rowLabels[REV] === 'c0:Revenue', aligned.rowLabels[REV]);

  // Same tab with two rows inserted above the block.
  const shiftedLabels = { [REV + 2]: 'Revenue', [SESS + 2]: 'Sessions', [ORD + 2]: 'Orders' };
  const shifted = D.probe(grid(30, { [SESS + 2]: Array(30).fill('0') }, shiftedLabels));
  ok('probe: shift detected', shifted.found.revenue.row === REV + 2, shifted.found.revenue);
  ok('probe: names the offset', /SHIFTED by 2/.test(shifted.verdict), shifted.verdict);
  ok('probe: names the row and column', /grid row 64, column 0/.test(shifted.verdict), shifted.verdict);

  // Labels in column C rather than A — the case the first probe was blind to.
  const g = grid(30, {}, {});
  g[REV][2] = 'Revenue';
  const offCol = D.probe(g);
  ok('probe: finds labels outside column A', offCol.found.revenue.col === 2, offCol.found.revenue);
  ok('probe: aligned row in another column still reads as no figures',
    /no figures entered/.test(offCol.verdict), offCol.verdict);

  // Alternative metric naming is reported even when "Revenue" is absent.
  const g2 = grid(30, {}, {});
  g2[REV][0] = 'Net Sales';
  const alt = D.probe(g2);
  ok('probe: picks up Net Sales', alt.found.netSales.row === REV, alt.found.netSales);

  const noLabels = D.probe(grid(30, {}, {}));
  ok('probe: missing labels reported', /read rowLabels/.test(noLabels.verdict), noLabels.verdict);
  ok('probe: empty grid safe', D.probe([]).gridRows === 0);
})();

console.log(`\ndata.js filter: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
