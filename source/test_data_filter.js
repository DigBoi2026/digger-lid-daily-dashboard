/* Unit tests for api/data.js — block selection, the label-driven row map, the
   real-data filter, latestDataDate, and the layout probe.
   Run: node source/test_data_filter.js   (exit 0 = all pass)

   No network and no credentials. Fixtures are shaped like the actual sheet:
   block heading in column A, metric labels in column B, day columns from C. */
const D = require('../api/data.js');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}

/* ---------- fixture: the 59-row block, with the offsets observed live ------- */
const BLOCK = [
  [0,  'TOTAL Revenue'], [1, 'Subscription Revenue (Optional)'],
  [2,  'Non Subscription Revenue (Optional)'], [3, 'Revenue Ex GST'], [4, 'GST %'],
  [6,  'Sales Stats'], [7, 'Orders'], [8, 'New Customer Orders'], [9, 'Items Sold'],
  [10, 'Store Sessions'], [12, 'Store Performance'], [13, 'Conversion Rate'],
  [14, 'New Customer %'], [15, 'Items Per Order'], [16, 'Average Order Value'],
  [22, 'EXPENSES'], [24, 'Advertising'], [25, '"New Audience" Spend  (Optional)'],
  [26, 'Total Meta Ad Spend'], [27, 'Google Ad Spend'], [30, 'Total Advertising'],
  [51, 'TOTAL EXPENSES'], [53, 'PROFIT'], [54, 'Profit %'], [55, 'Sitewide ROAS'],
];
const OFF = Object.fromEntries(BLOCK.map(([o, l]) => [l, o]));

// blocks: [{start, heading, vals:{label:[perDay...]}}]; days = number of day columns
function sheet(days, blocks) {
  const g = [];
  const need = Math.max(...blocks.map(b => b.start)) + 60;
  for (let i = 0; i <= need; i++) g[i] = ['', ''];
  g[0] = ['', '']; g[1] = ['', ''];
  for (let d = 1; d <= days; d++) { g[0][d + 1] = ` ${d} Jun `; g[1][d + 1] = 'Mon'; }
  for (const b of blocks) {
    if (b.heading) g[b.start - 2][0] = b.heading + '\n↓ To expand, click + on left';
    for (const [off, label] of BLOCK) {
      const r = b.start + off;
      g[r] = ['', label];
      const vals = (b.vals || {})[label];
      if (vals) vals.forEach((v, d) => { g[r][d + 2] = v; });
    }
  }
  return g;
}
const day = (n, v) => Array(n).fill(v);

/* ---------- block selection ------------------------------------------------ */
(() => {
  const g = sheet(2, [
    { start: 4,   heading: 'Country 1', vals: { 'TOTAL Revenue': ['$16,701.63', '$12,000.00'] } },
    { start: 63,  heading: 'Country 2', vals: { 'TOTAL Revenue': ['$0.00', '$0.00'] } },
    { start: 240, heading: 'TOTAL',     vals: { 'TOTAL Revenue': ['$16,701.63', '$12,000.00'] } },
    { start: 344, heading: 'WHOLESALE', vals: { 'TOTAL Revenue': ['$0.00', '$0.00'] } },
  ]);
  const blocks = D.findBlocks(g);
  ok('findBlocks: all four found', blocks.length === 4, blocks.map(b => b.row));
  ok('findBlocks: heading is first line only', blocks[0].heading === 'Country 1', blocks[0].heading);
  ok('chooseBlock: prefers TOTAL', D.chooseBlock(blocks).row === 240, D.chooseBlock(blocks));

  const br = D.blockRows(g);
  ok('blockRows: maps revenue to the TOTAL block', br.rows.revenue === 240, br.rows.revenue);
  ok('blockRows: orders at label offset, not a fixed index',
    br.rows.orders === 240 + OFF['Orders'], br.rows.orders);
  ok('blockRows: absent metric is null', br.rows.returns === null, br.rows.returns);
  ok('blockRows: does not leak into the next block',
    br.rows.roas === 240 + OFF['Sitewide ROAS'], br.rows.roas);
})();

(() => {
  // A single-market sheet with no consolidated row: Country 1 IS the business.
  const g = sheet(1, [{ start: 4, heading: 'Country 1', vals: { 'TOTAL Revenue': ['$500.00'] } }]);
  ok('chooseBlock: falls back to the first block', D.chooseBlock(D.findBlocks(g)).row === 4);
  ok('parseDaily: fallback block still parses', D.parseDaily(g, 6)[0].revenue === 500);
})();

(() => {
  ok('blockRows: no blocks → null', D.blockRows([['', '']]) === null);
  ok('parseDaily: no blocks → no rows', D.parseDaily([['', '']], 6).length === 0);
})();

/* ---------- the drift that caused the outage ------------------------------- */
(() => {
  // Insert a row inside the block: a fixed row map breaks, a label map does not.
  const g = sheet(1, [{ start: 240, heading: 'TOTAL', vals: { 'TOTAL Revenue': ['$1,000.00'], 'Orders': ['7'] } }]);
  const before = D.parseDaily(g, 6);
  ok('drift: baseline parses', before.length === 1 && before[0].orders === 7, before[0]);

  const shifted = g.map(r => r.slice());
  shifted.splice(241, 0, ['', 'Newly Inserted Optional Row']);
  const after = D.parseDaily(shifted, 6);
  ok('drift: survives an inserted row', after.length === 1 && after[0].orders === 7, after[0]);
  ok('drift: revenue still correct after insertion', after[0].revenue === 1000, after[0].revenue);
})();

/* ---------- value parsing -------------------------------------------------- */
(() => {
  const g = sheet(3, [{ start: 240, heading: 'TOTAL', vals: {
    'TOTAL Revenue': ['$16,701.63', '$12,000.00', '$0.00'],
    'Store Sessions': ['1,204', '980', '0'],
    'Orders': ['31', '22', '0'],
    'GST %': ['9.09%', '9.09%', ''],
  } }]);
  const rows = D.parseDaily(g, 6);
  ok('parse: two trading days, the all-zero third dropped', rows.length === 2, rows.length);
  ok('parse: currency stripped', rows[0].revenue === 16701.63, rows[0].revenue);
  ok('parse: thousands separator stripped', rows[0].sessions === 1204, rows[0].sessions);
  ok('parse: percent stripped', rows[0].gstPct === 9.09, rows[0].gstPct);
  ok('parse: iso date from month number', rows[0].date === '2026-06-01', rows[0].date);
  ok('parse: dow carried', rows[0].dow === 'Mon', rows[0].dow);
  ok('parse: an all-zero future day is dropped', rows.length === 2 || rows[2] === undefined, rows.length);
})();

/* ---------- the skeleton-month bug ---------------------------------------- */
(() => {
  // The live Sep tab signature: pre-built month, no figures, a literal 0 in one row.
  const g = sheet(30, [{ start: 240, heading: 'TOTAL', vals: { 'New Customer Orders': day(30, '0') } }]);
  ok('skeleton month → no rows', D.parseDaily(g, 9).length === 0, D.parseDaily(g, 9).length);
})();

(() => {
  const g = sheet(1, [{ start: 240, heading: 'TOTAL', vals: { 'Store Sessions': ['0'] } }]);
  ok('sessions 0 alone → dropped', D.parseDaily(g, 9).length === 0);
  const g2 = sheet(1, [{ start: 240, heading: 'TOTAL', vals: { 'Store Sessions': ['45'] } }]);
  ok('sessions positive → kept', D.parseDaily(g2, 9).length === 1);
  const g3 = sheet(1, [{ start: 240, heading: 'TOTAL', vals: { 'Orders': ['3'] } }]);
  ok('orders alone → kept', D.parseDaily(g3, 9).length === 1);
  const g4 = sheet(2, [{ start: 240, heading: 'TOTAL', vals: {
    'TOTAL Revenue': ['$1,000.00', '$0.00'], 'Store Sessions': ['300', '0'], 'Orders': ['5', '0'] } }]);
  const r4 = D.parseDaily(g4, 9);
  ok('future all-zero day trimmed from the tail', r4.length === 1, r4.length);
  ok('latestDataDate lands on the real last day', D.lastDataDate(r4) === '2026-09-01', D.lastDataDate(r4));
})();

/* ---------- hasData / lastDataDate --------------------------------------- */
(() => {
  ok('hasData: revenue', D.hasData({ revenue: 1 }) === true);
  ok('hasData: all-zero future day rejected',
    D.hasData({ revenue: 0, orders: 0, sessions: 0 }) === false);
  ok('hasData: zero revenue but real sessions is a trading day',
    D.hasData({ revenue: 0, orders: 0, sessions: 412 }) === true);
  ok('hasData: zero revenue but real orders is a trading day',
    D.hasData({ revenue: 0, orders: 2, sessions: 0 }) === true);
  ok('hasData: sessions 0 only', D.hasData({ revenue: null, orders: null, sessions: 0 }) === false);
  ok('hasData: sessions positive', D.hasData({ revenue: null, orders: null, sessions: 1 }) === true);
  ok('hasData: nothing', D.hasData({}) === false);

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

/* ---------- monthly totals ------------------------------------------------ */
(() => {
  const g = sheet(0, [{ start: 240, heading: 'TOTAL', vals: {} }]);
  g[0][2] = 'Jan 26'; g[0][3] = 'Feb 26';
  g[240][2] = '$262,703.95'; g[240][3] = '$180,000.00';
  const m = D.parseMonthly(g);
  ok('monthly: two months', m.length === 2, m.length);
  ok('monthly: Jan anchor', m[0].month === 'Jan' && m[0].revenue === 262703.95, m[0]);
  ok('monthly: sorted by month number', m[0].monthNum === 1 && m[1].monthNum === 2, m.map(x => x.monthNum));
  ok('monthly: zero-revenue month dropped',
    D.parseMonthly((() => { const h = sheet(0, [{ start: 240, heading: 'TOTAL', vals: {} }]); h[0][2] = 'Jan 26'; h[240][2] = '$0.00'; return h; })()).length === 0);
})();

/* ---------- probe --------------------------------------------------------- */
(() => {
  const g = sheet(30, [
    { start: 4,   heading: 'Country 1', vals: { 'TOTAL Revenue': day(30, '$16,701.63') } },
    { start: 240, heading: 'TOTAL',     vals: { 'TOTAL Revenue': day(30, '$16,701.63') } },
  ]);
  const pr = D.probe(g);
  ok('probe: finds Revenue label in column B', pr.found.revenue.col === 1, pr.found.revenue);
  ok('probe: reports both blocks', pr.blocks.length === 2, pr.blocks.length);
  ok('probe: block heading', pr.blocks[1].heading.startsWith('TOTAL'), pr.blocks[1].heading);
  ok('probe: anchor value surfaced', pr.blocks[0].firstDayValue === '$16,701.63', pr.blocks[0]);
  ok('probe: counts day columns', pr.dayColumns === 30, pr.dayColumns);
  ok('probe: dumps row labels', /TOTAL Revenue/.test(pr.rowLabels[4] || ''), pr.rowLabels[4]);
  ok('probe: empty grid safe', D.probe([]).gridRows === 0);
  ok('probe: no blocks when no TOTAL Revenue', D.probe([['', 'Something']]).blocks.length === 0);
})();

console.log(`\ndata.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
