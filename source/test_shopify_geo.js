/* Unit tests for buildGeo in api/shopify.js — the Forecast page's country lens.
   Run: node source/test_shopify_geo.js   (exit 0 = all pass)

   No network: fetch is stubbed and answers each ShopifyQL query from a fixture,
   so the query SHAPE and the arithmetic can both be checked.

   WHY THIS IS THREE QUERIES AND NOT ONE. `GROUP BY shipping_country, day`
   returns only the country-days that had a sale — sparse, unbounded, and the
   shape changes with trade. Worse, it silently drops the orders Shopify records
   with no shipping country at all. Asking for the total, then Australia, then
   New Zealand gives three dense series and lets everywhere else fall out as the
   residual, which sweeps those up by construction. These tests pin that down,
   because a future "simplification" to one query would look tidier and quietly
   lose money off the bottom of the page. */
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}
const near = (a, b, t = 0.01) => a != null && Math.abs(a - b) < t;

process.env.SHOPIFY_STORE = 'test-store';
process.env.SHOPIFY_TOKEN = 'shpat_test';

let QUERIES = [];
let FIXTURE = {};

/* Stub the Admin GraphQL endpoint: return whichever fixture matches the
   ShopifyQL inside the request. */
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  /* Pull just the JSON-quoted ShopifyQL out of the GraphQL document. The first
     attempt used a greedy .* and swallowed the "query:" label with it. */
  const m = /shopifyqlQuery\(query:\s*("(?:[^"\\]|\\.)*")\)/.exec(body.query);
  const ql = JSON.parse(m[1]);
  QUERIES.push(ql);
  let key = 'total';
  if (/Australia/.test(ql)) key = 'au';
  else if (/New Zealand/.test(ql)) key = 'nz';
  /* tableData.rows come back as OBJECTS keyed by column name — buildRegion has
     always read r.shipping_country and r.net_sales, and it works in production.
     The MCP console returns arrays, which is a wrapper's shape, not this API's;
     the first fixture copied that and produced an empty series. */
  const rows = (FIXTURE[key] || []).map(r => ({ day: r[0], net_sales: r[1], orders: r[2] }));
  const columns = [{ name: 'day' }, { name: 'net_sales' }, { name: 'orders' }];
  return {
    ok: true, status: 200,
    json: async () => ({ data: { shopifyqlQuery: { parseErrors: [], tableData: { columns, rows } } } }),
  };
};

const S = require('../api/shopify.js');

function run(fixture) {
  QUERIES = []; FIXTURE = fixture;
  const today = new Date('2026-09-10T00:00:00Z');
  return S.buildGeo(today);
}

(async () => {
  /* Australia every day, New Zealand on one of them, and a total that exceeds
     the two — the residual is the rest of the world plus the country-less
     orders. */
  let g = await run({
    total: [['2026-09-01', '1000.00', '10'], ['2026-09-02', '2000.00', '20'], ['2026-09-03', '500.00', '5']],
    au:    [['2026-09-01', '900.00', '9'],  ['2026-09-02', '1800.00', '18'], ['2026-09-03', '500.00', '5']],
    nz:    [['2026-09-02', '100.00', '1']],
  });

  ok('exactly three queries, not one per country', QUERIES.length === 3, QUERIES.length);
  ok('the first asks for the total by day', /GROUP BY day/.test(QUERIES[0]) && !/shipping_country/.test(QUERIES[0]), QUERIES[0]);
  ok('the second filters to Australia', /shipping_country = 'Australia'/.test(QUERIES[1]));
  ok('the third filters to New Zealand', /shipping_country = 'New Zealand'/.test(QUERIES[2]));
  ok('none of them groups BY country — that is the sparse shape being avoided',
     QUERIES.every(q => !/GROUP BY shipping_country/.test(q)), QUERIES);
  ok('each asks for two years of days',
     QUERIES.every(q => /SINCE 2024-09-1\d/.test(q)), QUERIES[0]);
  ok('and for orders as well as money', QUERIES.every(q => /net_sales, orders/.test(q)));

  ok('one row per day the business traded', g.daily.length === 3, g.daily.length);
  ok('Australia comes straight through', near(g.daily[0].au, 900));
  ok('a day New Zealand did not trade reads 0, not missing',
     g.daily[0].nz === 0 && g.daily[2].nz === 0, [g.daily[0].nz, g.daily[2].nz]);
  ok('the rest of the world is the residual', near(g.daily[0].other, 100), g.daily[0].other);
  ok('and the residual is 0 when the named two are everything',
     near(g.daily[2].other, 0), g.daily[2].other);
  ok('orders are split the same way',
     g.daily[1].auOrders === 18 && g.daily[1].nzOrders === 1 && g.daily[1].otherOrders === 1,
     g.daily[1]);
  ok('the parts add back to the total',
     g.daily.every(d => near(d.au + d.nz + d.other, d.total)), g.daily);
  ok('totals are summed for each bucket',
     near(g.totals.total, 3500) && near(g.totals.au, 3200) && near(g.totals.nz, 100) &&
     near(g.totals.other, 200), g.totals);

  /* The measure is NOT the P&L's, and the payload has to say so — this is the
     one fact a reader of the country lens most needs and would otherwise
     assume away. */
  ok('the payload declares that it does not tie to the P&L', g.meta.ties_to_pnl === false);
  ok('and names the measure', g.meta.measure === 'net_sales');
  ok('and carries the caveat in words', /does not tie|do not tie/i.test(g.meta.caveat), g.meta.caveat);
  ok('and says there is no profit in it', /never profit|no cost data/i.test(g.meta.caveat));

  /* A refund can land on a day with no matching sale, which makes the residual
     negative — an artefact of net_sales being net, not a negative country. */
  g = await run({
    total: [['2026-09-01', '100.00', '1']],
    au:    [['2026-09-01', '150.00', '2']],
    nz:    [],
  });
  ok('a negative residual is clamped to 0, not shown as a negative country',
     g.daily[0].other === 0, g.daily[0].other);
  ok('and negative residual orders too', g.daily[0].otherOrders === 0, g.daily[0].otherOrders);

  /* A day Australia traded and the total query missed cannot invent a day. */
  g = await run({
    total: [['2026-09-01', '100.00', '1']],
    au:    [['2026-09-01', '90.00', '1'], ['2026-09-02', '80.00', '1']],
    nz:    [],
  });
  ok('the day list comes from the total, so a stray country day cannot add one',
     g.daily.length === 1 && g.daily[0].date === '2026-09-01', g.daily.map(d => d.date));

  ok('an empty store gives an empty series rather than throwing',
     (await run({ total: [], au: [], nz: [] })).daily.length === 0);

  console.log(`shopify geo: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
