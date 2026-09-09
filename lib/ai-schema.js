/* =========================================================================
   Machine-readable data dictionary for the AI read subsystem.

   The raw routes return keys like `mer3`, `ncpa`, `vcr` and `rpv`, which are
   meaningless to a consumer that has not read the sheet. Names and definitions
   below are taken from the sheet's own column-B labels, so they match what the
   business calls these numbers.

   unit: aud | count | ratio | percent | date | text
   ========================================================================= */

const F = (name, unit, definition, extra) =>
  Object.assign({ name, unit, definition }, extra || {});

const PNL_FIELDS = {
  date:       F('Date', 'date', 'Calendar day, ISO-8601. One row per trading day.'),
  label:      F('Day label', 'text', 'The sheet column header for that day, e.g. "1 Jun".'),
  dow:        F('Day of week', 'text', 'Three-letter weekday from the sheet.'),

  revenue:    F('TOTAL Revenue', 'aud', 'Gross revenue for the day, GST inclusive, all countries consolidated.'),
  revExGst:   F('Revenue Ex GST', 'aud', 'Revenue with GST removed.', { sensitive: true }),
  gstPct:     F('GST %', 'percent', 'Effective GST rate for the day.', { sensitive: true }),

  orders:     F('Orders', 'count', 'Total orders placed.'),
  newOrders:  F('New Customer Orders', 'count', 'Orders from first-time customers.'),
  items:      F('Items Sold', 'count', 'Total units sold.'),
  sessions:   F('Store Sessions', 'count', 'Online store sessions.'),

  cvr:        F('Conversion Rate', 'percent', 'Orders divided by sessions.'),
  newPct:     F('New Customer %', 'percent', 'Share of orders from first-time customers.'),
  ipo:        F('Items Per Order', 'ratio', 'Average units per order.'),
  aov:        F('Average Order Value', 'aud', 'Revenue divided by orders.'),
  cpv:        F('Cost Per Visit', 'aud', 'Advertising spend divided by sessions.'),
  rpv:        F('Revenue Per Visit', 'aud', 'Revenue divided by sessions.'),
  cpp:        F('Cost Per Purchase', 'aud', 'Advertising spend divided by orders.'),
  ncpa:       F('New Customer CPA', 'aud', 'Advertising spend divided by new-customer orders.'),

  metaNew:    F('"New Audience" Spend', 'aud', 'Meta spend attributed to prospecting audiences. Optional line in the sheet.'),
  metaTotal:  F('Total Meta Ad Spend', 'aud', 'All Meta advertising spend.'),
  google:     F('Google Ad Spend', 'aud', 'All Google advertising spend.'),
  tiktok:     F('TikTok Ad Spend', 'aud', 'All TikTok advertising spend.'),
  totalAds:   F('Total Advertising', 'aud', 'Sum of all paid channels.'),
  mer:        F('MER', 'ratio', 'Marketing Efficiency Ratio: revenue divided by total advertising.'),
  mer3:       F('3-day Rolling MER', 'ratio', 'MER smoothed over a trailing three days.'),
  roas:       F('Sitewide ROAS', 'ratio', 'Return on ad spend across the whole store.'),

  prodCost:   F('Product Cost', 'aud', 'Cost of goods sold.', { sensitive: true }),
  shipCost:   F('Shipping Cost', 'aud', 'Outbound freight.', { sensitive: true }),
  pickPack:   F('Pick Pack (3PL)', 'aud', 'Third-party logistics pick and pack fees.', { sensitive: true }),
  packaging:  F('Packaging', 'aud', 'Packaging consumables.', { sensitive: true }),
  txnFees:    F('Transaction Fees', 'aud', 'Payment gateway fees.', { sensitive: true }),
  merchFees:  F('Merchant Fees', 'aud', 'Merchant account fees.', { sensitive: true }),
  totalVC:    F('Total Variable Costs', 'aud', 'Sum of variable cost and fulfilment lines.', { sensitive: true }),
  vcr:        F('VCR', 'percent', 'Variable Cost Ratio: variable costs as a share of revenue.', { sensitive: true }),

  salaries:   F('Salaries & Contractors', 'aud', 'Payroll and contractor cost.', { sensitive: true }),
  software:   F('Subscriptions & Software', 'aud', 'Software and subscription cost.', { sensitive: true }),
  office:     F('Office & Operating Exp', 'aud', 'Office and general operating expense.', { sensitive: true }),
  totalFC:    F('Total Fixed Costs', 'aud', 'Sum of fixed cost lines.', { sensitive: true }),
  fcr:        F('FCR', 'percent', 'Fixed Cost Ratio: fixed costs as a share of revenue.', { sensitive: true }),

  returns:    F('Returns', 'aud', 'Value of returns.', { sensitive: true }),
  returnsPct: F('Returns %', 'percent', 'Returns as a share of revenue.', { sensitive: true }),
  totalExp:   F('TOTAL EXPENSES', 'aud', 'All expenses: advertising, variable and fixed.', { sensitive: true }),
  profit:     F('PROFIT', 'aud', 'Revenue ex GST less total expenses.', { sensitive: true }),
  profitPct:  F('Profit %', 'percent', 'Profit as a share of revenue.', { sensitive: true }),

  fcRev:      F('Forecast Revenue', 'aud', 'Forecast revenue line. Often blank.', { sensitive: true }),
  projSpend:  F('Projected Spend', 'aud', 'Projected advertising spend. Often blank.', { sensitive: true }),
  fcProfit:   F('Forecast Profit', 'aud', 'Forecast profit line. Often blank.', { sensitive: true }),
};

const DATASETS = {
  'pnl.daily': {
    title: 'Daily profit & loss',
    grain: 'one row per calendar day',
    source: 'Google Sheet — DiggerLid Ecommerce Equation, consolidated TOTAL block',
    currency: 'AUD',
    scopes: ['pnl.full', 'pnl.topline'],
    params: { since: 'ISO date, inclusive', until: 'ISO date, inclusive' },
    fields: PNL_FIELDS,
    notes: [
      'Only days with a positive trading signal are returned; future days in a pre-built month tab are excluded.',
      'meta.latestDataDate is the newest day carrying real data, never a future date.',
    ],
  },
  'pnl.monthly': {
    title: 'Monthly profit & loss',
    grain: 'one row per calendar month',
    source: 'Google Sheet — 2026 Monthly Totals, consolidated TOTAL block',
    currency: 'AUD',
    scopes: ['pnl.full', 'pnl.topline'],
    fields: PNL_FIELDS,
  },
  products: {
    title: 'Product and category sales',
    grain: 'daily rows plus 3/7/30/90/12M trailing windows and monthly category mix',
    source: 'Shopify Admin API — ShopifyQL over `sales`',
    currency: 'AUD',
    scopes: ['products'],
    notes: ['Categories are assigned in api/shopify.js so live data matches the board exactly.'],
  },
  region: {
    title: 'Sales by country and region',
    grain: '12 trailing months by country, plus Australian state detail',
    source: 'Shopify Admin API — ShopifyQL over `sales`, grouped by shipping geography',
    currency: 'AUD',
    scopes: ['region'],
  },
  pulse: {
    title: 'Site signals',
    grain: 'daily, 62 complete days ending yesterday',
    source: 'PostHog Query API (HogQL)',
    scopes: ['pulse'],
    notes: ['Today is excluded; only whole days are reported.'],
  },
};

module.exports = { PNL_FIELDS, DATASETS };
