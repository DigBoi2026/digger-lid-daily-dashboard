/* Unit tests for buildCustomers and buildProductsDaily in api/shopify.js — the
   Forecast page's customer and product lenses.
   Run: node source/test_shopify_customers.js   (exit 0 = all pass)

   No network: fetch is stubbed and answers each ShopifyQL query from a fixture,
   so the query SHAPE and the arithmetic can both be checked.

   WHY THE CUSTOMER SPLIT EXISTS AT ALL. Shopify's dimension is
   `new_or_returning_customer`; asking for `customer_type` returns "column not
   found", and that one wrong name is how the first cut concluded no revenue
   split existed and forecast order counts instead. These tests pin the real
   column name so it cannot regress to the wrong one. */
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
let ANSWER = () => [];

global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const m = /shopifyqlQuery\(query:\s*("(?:[^"\\]|\\.)*")\)/.exec(body.query);
  const ql = JSON.parse(m[1]);
  QUERIES.push(ql);
  const rows = ANSWER(ql);
  return {
    ok: true, status: 200,
    json: async () => ({ data: { shopifyqlQuery: { parseErrors: [], tableData: { columns: [], rows } } } }),
  };
};

const S = require('../api/shopify.js');
S._setPace(0);   // stubbed API: no need to pace
const TODAY = new Date('2026-09-10T00:00:00Z');
const day = (d, net, orders) => ({ day: d, net_sales: String(net), orders: String(orders) });

(async () => {
  /* ------------------------------------------------------------ customers */
  QUERIES = [];
  ANSWER = ql => {
    if (/= 'New'/.test(ql)) return [day('2026-09-01', 900, 9), day('2026-09-02', 1800, 18), day('2026-09-03', 500, 5)];
    if (/= 'Returning'/.test(ql)) return [day('2026-09-02', 200, 2)];   // no sale on the 1st or 3rd
    return [];
  };
  let c = await S.buildCustomers(TODAY);
  ok('customers: exactly two queries', QUERIES.length === 2, QUERIES.length);
  ok('customers: the dimension is new_or_returning_customer, not customer_type',
     QUERIES.every(q => /new_or_returning_customer = '(New|Returning)'/.test(q)) && QUERIES.every(q => !/customer_type/.test(q)), QUERIES);
  ok('customers: both are dense day series, not grouped by type',
     QUERIES.every(q => /GROUP BY day/.test(q) && !/GROUP BY new_or_returning_customer/.test(q)), QUERIES);
  ok('customers: two years of days', QUERIES.every(q => /SINCE 2024-09-1\d/.test(q)), QUERIES[0]);
  ok('customers: one row per day either type traded', c.daily.length === 3, c.daily.length);
  ok('customers: new comes straight through', near(c.daily[0].newNet, 900) && c.daily[0].newOrders === 9);
  ok('customers: a day returning did not trade reads 0, not missing',
     c.daily[0].retNet === 0 && c.daily[0].retOrders === 0 && c.daily[2].retNet === 0, c.daily[0]);
  ok('customers: total is the two added', near(c.daily[1].total, 2000) && c.daily[1].totalOrders === 20, c.daily[1]);
  ok('customers: totals summed per bucket',
     near(c.totals.newNet, 3200) && near(c.totals.retNet, 200) && c.totals.newOrders === 32 && c.totals.retOrders === 2, c.totals);
  ok('customers: declares revenue does not tie but orders do',
     c.meta.ties_to_pnl === false && c.meta.orders_tie_to_pnl === true, c.meta);
  ok('customers: names the measure and carries the caveat', c.meta.measure === 'net_sales' && /do(es)? not tie/i.test(c.meta.caveat));
  ok('customers: an empty store gives an empty series',
     (ANSWER = () => [], (await S.buildCustomers(TODAY)).daily.length === 0));

  /* ------------------------------------------------------- products daily */
  QUERIES = [];
  const CATALOGUE = [
    { product_title: 'Big Seller', net_sales: '5000', orders: '50' },
    { product_title: 'Second', net_sales: '3000', orders: '30' },
    { product_title: "O'Brien Cover", net_sales: '1000', orders: '10' },      // an apostrophe in a title
    { product_title: 'Third', net_sales: '900', orders: '9' },
    { product_title: 'Fourth', net_sales: '800', orders: '8' },
    { product_title: 'Fifth', net_sales: '700', orders: '7' },
    { product_title: 'Sixth', net_sales: '600', orders: '6' },
    { product_title: 'Drink Caddy GWP', net_sales: '0', orders: '400' },      // gift with purchase: $0
    { product_title: '', net_sales: '300', orders: '3' },                     // untitled
    { product_title: null, net_sales: '200', orders: '2' },
  ];
  ANSWER = ql => {
    if (/GROUP BY product_title/.test(ql)) return CATALOGUE;
    if (/WHERE product_title = /.test(ql)) {
      const t = /WHERE product_title = '((?:[^'\\]|\\.)*)'/.exec(ql)[1].replace(/\\'/g, "'");
      if (t === 'Big Seller') return [day('2026-09-01', 600, 6), day('2026-09-02', 700, 7)];
      if (t === "O'Brien Cover") return [day('2026-09-01', 100, 1)];
      return [];                                                              // the rest sold nothing these days
    }
    return [day('2026-09-01', 1000, 10), day('2026-09-02', 800, 8)];            // the total
  };
  const p = await S.buildProductsDaily(TODAY);
  const top = p.products.map(x => x.title);
  ok('products: one ranking, one total, then one per top product',
     QUERIES.length === 2 + p.products.length, QUERIES.length);
  ok('products: the ranking is over the trailing year', /SINCE 2025-09-1\d/.test(QUERIES[0]) && /GROUP BY product_title/.test(QUERIES[0]), QUERIES[0]);
  ok('products: the daily series are two years', QUERIES.slice(1).every(q => /SINCE 2024-09-1\d/.test(q)));
  ok('products: none of the daily queries groups by product — that is the sparse grid being avoided',
     QUERIES.slice(1).every(q => !/GROUP BY product_title/.test(q)));
  ok('products: the top list is capped', p.products.length === p.meta.top && p.products.length >= 4, p.products.length);
  ok('products: ranked by net sales, biggest first', top[0] === 'Big Seller' && top[1] === 'Second', top);
  ok('products: gifts with purchase are not products', !top.some(t => /GWP/.test(t)), top);
  ok('products: an untitled line is not a product', !top.includes('') && !top.includes('(untitled)'), top);
  ok("products: a title with an apostrophe is quoted for ShopifyQL",
     QUERIES.some(q => /product_title = 'O\\'Brien Cover'/.test(q)), QUERIES.filter(q => /Brien/.test(q)));
  ok('products: keys are stable p0..pN', p.products.every((x, i) => x.key === 'p' + i), p.products.map(x => x.key));
  ok('products: one row per day the business traded', p.daily.length === 2, p.daily.length);
  ok('products: the leader comes through by key', near(p.daily[0].p0, 600) && p.daily[0].p0Orders === 6, p.daily[0]);
  ok('products: a product that sold nothing that day reads 0', p.daily[0].p1 === 0 && p.daily[1].p1 === 0);
  ok('products: everything else is the residual', near(p.daily[0].other, 1000 - 600 - 100), p.daily[0].other);
  ok('products: the parts add back to the total',
     p.daily.every(d => near(p.products.reduce((a, x) => a + d[x.key], 0) + d.other, d.total)), p.daily);
  ok('products: totals per bucket', near(p.totals.total, 1800) && near(p.totals.p0, 1300) && near(p.totals.other, 400), p.totals);
  ok('products: declares that it does not tie to the P&L', p.meta.ties_to_pnl === false && /does not tie/i.test(p.meta.caveat));
  ok('products: the ranking carries last-year money for the page to show shares',
     p.products[0].net365 === 5000 && p.products[0].orders365 === 50, p.products[0]);

  /* A refund landing on a day with no matching sale */
  ANSWER = ql => /GROUP BY product_title/.test(ql) ? CATALOGUE
              : /WHERE product_title = 'Big Seller'/.test(ql) ? [day('2026-09-01', 150, 2)]
              : /WHERE/.test(ql) ? [] : [day('2026-09-01', 100, 1)];
  const r = await S.buildProductsDaily(TODAY);
  ok('products: a negative residual is clamped to 0', r.daily[0].other === 0, r.daily[0].other);

  /* --------------------------------------------------------------- recent */
  QUERIES = [];
  ANSWER = () => [
    { day: '2026-09-09', total_sales: '13734.31', net_sales: '12059.13', orders: '38' },
    { day: '2026-09-10', total_sales: '19499.28', net_sales: '17119.07', orders: '58' },
    { day: '2026-09-11', total_sales: '6061.67',  net_sales: '5216.99',  orders: '21' },
  ];
  const rc = await S.buildRecent(TODAY);
  ok('recent: one query', QUERIES.length === 1, QUERIES.length);
  ok('recent: asks for total_sales — the figure that matches the sheet', /total_sales, net_sales, orders/.test(QUERIES[0]), QUERIES[0]);
  ok('recent: three weeks, through today', /SINCE 2026-08-20/.test(QUERIES[0]) && /UNTIL 2026-09-12/.test(QUERIES[0]), QUERIES[0]);
  ok('recent: rows shaped for shopifyFill', rc.daily[0].date === '2026-09-09' && rc.daily[0].total === 13734.31 && rc.daily[0].orders === 38, rc.daily[0]);
  ok('recent: names the measure', rc.meta.measure === 'total_sales');

  console.log(`shopify customers+products: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
