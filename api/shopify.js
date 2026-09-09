/* =========================================================================
   /api/shopify  —  Vercel Serverless Function (Node).
   Live Shopify data via the Admin GraphQL API (ShopifyQL `sales`). Assembles
   the SAME shapes the embedded snapshots use, so the pages upgrade transparently:
     /api/shopify?dataset=products  → window.DL_SHOPIFY shape (Products page)
     /api/shopify?dataset=region    → window.DL_REGION shape (Region page)

   Required environment variables (Vercel → Settings → Environment Variables):
     SHOPIFY_STORE   your-store            (the *.myshopify.com subdomain, no suffix)
     SHOPIFY_API_VERSION  (optional)       defaults to 2026-07

   Plus ONE of these two credential shapes:
     SHOPIFY_TOKEN   shpat_...             A long-lived Admin API access token, as
                                           issued to admin-created custom apps.
                                           Shopify no longer lets you create those,
                                           but existing ones keep working.
     SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
                                           For an app made with the Shopify CLI or
                                           Dev Dashboard. Exchanged for a token via
                                           the client credentials grant, which only
                                           works when the app and the store are in
                                           the same Shopify organisation. Those
                                           tokens last 24h, so they are minted on
                                           demand and cached below.

   Only scope required is read_reports — every query here is ShopifyQL over
   `sales`, and nothing else is read. Read-only; never writes to Shopify.
   Categorisation (incl. PRO Mat + Hauler → Mobile Protection) is applied here so
   live data matches the dashboard exactly. Never writes to Shopify.
   ========================================================================= */

// 2025-01 is long retired. Shopify 'falls forward' to the oldest accessible
// version when you name a dead one, so a stale default silently moves target
// every quarter. Pin a live one; supported until 2027-07.
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const KEYS = {covers:'Machine Covers',grease:'Grease',screens:'DiggerShield Screens',drawbar:'Draw Bar Covers',
  shipping:'Shipping Protection',phone:'Phone Cradles',wipes:'Digger Wipes',mobile:'Mobile Protection',
  merch:'Merch & Apparel',other:'Other'};
const STATE_ABBR = {'New South Wales':'NSW','Queensland':'QLD','Victoria':'VIC','Western Australia':'WA',
  'South Australia':'SA','Tasmania':'TAS','Australian Capital Territory':'ACT','Northern Territory':'NT'};

// title → category key (mirrors source/build_cat_monthly.py + build_win3.js)
function categorize(title) {
  if (title == null) return 'other';
  const t = String(title).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || t === '(untitled)') return 'other';
  if (t.includes('gwp')) {
    if (t.includes('draw bar')) return 'drawbar';
    if (t.includes('mat') || t.includes('hauler')) return 'mobile';
    if (t.includes('engine') || t.includes('cover')) return 'covers';
    return 'other';
  }
  if (/grease|kajo|coupler/.test(t)) return 'grease';
  if (t.includes('draw bar')) return 'drawbar';
  if (t.includes('shield') || t.includes('screen')) return 'screens';
  if (t.includes('phone cradle')) return 'phone';
  if (t.includes('wipes')) return 'wipes';
  if (t.includes('mat') || t.includes('hauler') || t.includes('luggage')) return 'mobile';
  if (/beanie|hoodie|work tee|trucker|bottle opener/.test(t)) return 'merch';
  if (t.includes('package protection')) return 'shipping';
  if (/cover|enclosure|caddy|cap set|quicky|hydraulic/.test(t)) return 'covers';
  return 'other';
}

const n2 = v => Math.round((parseFloat(v) || 0) * 100) / 100;
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; };
const monthStart = (d, off = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + off, 1));
const mLabel = d => `${MONTH_ABBR[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;

// Accept either "digger-lid" or "digger-lid.myshopify.com" (or with https://) for SHOPIFY_STORE.
function storeDomain() {
  const store = (process.env.SHOPIFY_STORE || '').trim()
    .replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '');
  if (!store) throw new Error('Missing SHOPIFY_STORE');
  return `${store}.myshopify.com`;
}

/* Client-credentials tokens live 24h. Cache across invocations of a warm
   function so a burst of requests mints one token, not one each. */
let cachedToken = null, cachedTokenExpiry = 0;

async function accessToken() {
  // A static token wins if present, so an existing custom app needs no migration.
  if (process.env.SHOPIFY_TOKEN) return process.env.SHOPIFY_TOKEN;

  const id = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('Missing SHOPIFY_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
  }
  // Re-use while more than a minute remains, so a token can't expire mid-request.
  if (cachedToken && Date.now() < cachedTokenExpiry - 60_000) return cachedToken;

  const r = await fetch(`https://${storeDomain()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: id, client_secret: secret,
    }),
  });
  if (!r.ok) {
    // shop_not_permitted (400) means the app and the store are in different
    // Shopify organisations — the usual cause, and not a credential typo.
    throw new Error(`Shopify token HTTP ${r.status} — client credentials require the app `
      + `and store to be in the same Shopify organisation`);
  }
  const j = await r.json();
  if (!j.access_token) throw new Error('Shopify token response carried no access_token');
  cachedToken = j.access_token;
  cachedTokenExpiry = Date.now() + (Number(j.expires_in) || 86399) * 1000;
  return cachedToken;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Shopify's GraphQL rate limit is a leaky bucket: 1000 points, refilling ~50 a
   second, and a shopifyqlQuery costs around 65. This route fires enough queries
   to empty it during a burst, and a throttled reply is a hard error — the whole
   dataset comes back as {"error": "...THROTTLED..."} and every page silently
   falls back to its embedded snapshot. That is the correct fallback, but it
   should not be reached over a limit that clears itself in a second or two.

   Retry a throttle with a widening pause; anything else fails immediately,
   because a bad query or a dead token will not fix itself. */
const THROTTLE_BACKOFF_MS = [700, 1600, 3200];

async function shopifyql(query, attempt = 0) {
  const token = await accessToken();
  const url = `https://${storeDomain()}/admin/api/${API_VERSION}/graphql.json`;
  const body = { query: `{ shopifyqlQuery(query: ${JSON.stringify(query)}) { parseErrors tableData { columns { name } rows } } }` };
  const r = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify(body) });
  if (r.status === 429 && attempt < THROTTLE_BACKOFF_MS.length) {
    await sleep(THROTTLE_BACKOFF_MS[attempt]);
    return shopifyql(query, attempt + 1);
  }
  if (!r.ok) throw new Error(`Shopify HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors) {
    const throttled = JSON.stringify(j.errors).includes('THROTTLED');
    if (throttled && attempt < THROTTLE_BACKOFF_MS.length) {
      await sleep(THROTTLE_BACKOFF_MS[attempt]);
      return shopifyql(query, attempt + 1);
    }
    throw new Error('GraphQL: ' + JSON.stringify(j.errors));
  }
  const q = j.data && j.data.shopifyqlQuery;
  if (q && q.parseErrors && q.parseErrors.length) throw new Error('ShopifyQL: ' + q.parseErrors.join('; '));
  return (q && q.tableData && q.tableData.rows) || [];
}

// The 12 whole months ending with the last complete month before today.
function twelveMonths(today) {
  const since = monthStart(today, -12), until = monthStart(today, 0);
  const months = Array.from({ length: 12 }, (_, i) => monthStart(today, -12 + i));
  return { since: iso(since), until: iso(until), labels: months.map(mLabel), isos: months.map(iso) };
}

/* ------------------------------- products ------------------------------- */
async function buildProducts(today) {
  const yest = addDays(today, -1);
  const win = n => ({ since: iso(addDays(yest, -(n - 1))), until: iso(addDays(yest, 1)) });   // trailing n days ending yesterday
  const M = twelveMonths(today);

  // daily aggregate (last 62 days incl. today partial)
  const dailyRows = await shopifyql(
    `FROM sales SHOW net_sales, orders, net_items_sold GROUP BY day SINCE ${iso(addDays(today, -61))} UNTIL ${iso(addDays(today, 1))} ORDER BY day`);
  const daily = dailyRows.map(r => ({ date: r.day, net: n2(r.net_sales), orders: +r.orders || 0, items: +r.net_items_sold || 0 }));

  // per-window product rows
  const WIN = { 3: win(3), 7: win(7), 30: win(30), 90: win(90), '12M': { since: M.since, until: M.until } };
  const windows = {};
  await Promise.all(Object.entries(WIN).map(async ([k, w]) => {
    const rows = await shopifyql(
      `FROM sales SHOW net_sales, orders, net_items_sold GROUP BY product_title SINCE ${w.since} UNTIL ${w.until} ORDER BY net_sales DESC`);
    windows[k] = rows.filter(r => n2(r.net_sales) > 0).map(r => ({
      t: r.product_title == null ? '(untitled)' : r.product_title, k: categorize(r.product_title),
      net: n2(r.net_sales), u: +r.net_items_sold || 0, o: +r.orders || 0 }));
  }));

  /* True totals for the long windows.

     The 90-day and 12-month views could not previously state an order count for
     their own period. Per-product rows carry `orders`, but that is "orders
     containing this product", so summing them double-counts any multi-product
     order — the 30-day rows add up to 3,956 against a real 1,766. `daily` only
     reaches back 62 days, so products.js fell back to whole calendar months:
     "LAST 90 DAYS" took net sales from a true trailing 90 days and its orders
     and units from Jun+Jul+Aug, ending 31 August. AOV was a ratio of two
     different periods, and the order count stopped eight days before its label.

     One ungrouped query per long window fixes it at the source. The short
     windows keep coming from `daily`, which already covers them exactly and
     matches the sheet to the order. */
  const LONG = { 90: win(90), '12M': { since: M.since, until: M.until } };
  const PREV = { 90: { since: iso(addDays(yest, -179)), until: iso(addDays(yest, -89)) } };
  const totalsFor = async w => {
    const r = (await shopifyql(
      `FROM sales SHOW net_sales, orders, net_items_sold SINCE ${w.since} UNTIL ${w.until}`))[0] || {};
    return { net: n2(r.net_sales), orders: +r.orders || 0, units: +r.net_items_sold || 0 };
  };
  /* Sequential, not Promise.all. These three run straight after the five
     concurrent per-window queries above, and firing all eight at once is what
     tipped this route past the rate limit — a throttle there loses the entire
     dataset to the snapshot fallback. Sequencing lets the bucket refill between
     them; three extra round trips are cheap against a maxDuration of 60s. */
  const winTotals = {}, winPrevTotals = {};
  for (const [k, w] of Object.entries(LONG)) winTotals[k] = await totalsFor(w);
  for (const [k, w] of Object.entries(PREV)) winPrevTotals[k] = await totalsFor(w);

  // monthly totals + product×month → catMonthly
  const monRows = await shopifyql(
    `FROM sales SHOW net_sales, orders, net_items_sold GROUP BY month SINCE ${M.since} UNTIL ${M.until} ORDER BY month`);
  const monBy = Object.fromEntries(monRows.map(r => [r.month, r]));
  const monthly = M.isos.map((mi, i) => ({ m: M.labels[i], net: n2((monBy[mi] || {}).net_sales),
    orders: +((monBy[mi] || {}).orders) || 0, units: +((monBy[mi] || {}).net_items_sold) || 0 }));

  const pmRows = await shopifyql(
    `FROM sales SHOW net_sales GROUP BY product_title, month SINCE ${M.since} UNTIL ${M.until}`);
  const catMonthly = M.isos.map((mi, i) => ({ m: M.labels[i], cats: {} }));
  const mIdx = Object.fromEntries(M.isos.map((mi, i) => [mi, i]));
  pmRows.forEach(r => { const i = mIdx[r.month]; if (i == null) return;
    const c = categorize(r.product_title); catMonthly[i].cats[c] = n2((catMonthly[i].cats[c] || 0) + n2(r.net_sales)); });

  return { meta: { source: 'Shopify · ShopifyQL sales', currency: 'AUD', asOf: iso(today), live: true },
    keys: KEYS, daily, windows, winTotals, winPrevTotals, monthly, catMonthly };
}

/* -------------------------------- region -------------------------------- */
async function buildRegion(today) {
  const M = twelveMonths(today);
  const yrSince = iso(addDays(today, -365)), yrUntil = iso(addDays(today, 1));

  const [countryTot, stateTot, ctyMonth, stMonth] = await Promise.all([
    shopifyql(`FROM sales SHOW net_sales GROUP BY shipping_country SINCE ${yrSince} UNTIL ${yrUntil} ORDER BY net_sales DESC`),
    shopifyql(`FROM sales SHOW net_sales, orders, net_items_sold GROUP BY shipping_region WHERE shipping_country = 'Australia' SINCE ${yrSince} UNTIL ${yrUntil} ORDER BY net_sales DESC`),
    shopifyql(`FROM sales SHOW net_sales, orders GROUP BY shipping_country, month SINCE ${M.since} UNTIL ${M.until}`),
    shopifyql(`FROM sales SHOW net_sales GROUP BY shipping_region, month WHERE shipping_country = 'Australia' SINCE ${M.since} UNTIL ${M.until}`),
  ]);
  const mIdx = Object.fromEntries(M.isos.map((mi, i) => [mi, i]));

  const countries = countryTot.filter(r => r.shipping_country && n2(r.net_sales) > 0)
    .map(r => ({ c: r.shipping_country, net: n2(r.net_sales) }));

  // AU states
  const states = stateTot.filter(r => r.shipping_region).map(r => ({
    name: r.shipping_region, abbr: STATE_ABBR[r.shipping_region] || r.shipping_region,
    net: n2(r.net_sales), orders: +r.orders || 0, items: +r.net_items_sold || 0 }));
  const stateMonthly = {};
  states.forEach(s => stateMonthly[s.abbr] = Array(12).fill(0));
  stMonth.forEach(r => { const i = mIdx[r.month], ab = STATE_ABBR[r.shipping_region] || r.shipping_region;
    if (i != null && stateMonthly[ab]) stateMonthly[ab][i] = n2(stateMonthly[ab][i] + n2(r.net_sales)); });
  // reconcile state net to month sums (drops the UNTIL sliver — matches build_region.js)
  states.forEach(s => { if (stateMonthly[s.abbr]) s.net = n2(stateMonthly[s.abbr].reduce((a, b) => a + b, 0)); });

  // country monthly (named + Other) and totals
  const named = ['Australia', 'United States', 'New Zealand', 'United Kingdom', 'Canada'];
  const cm = {}; named.forEach(c => cm[c] = Array(12).fill(0));
  const totalMonthly = Array(12).fill(0);
  const auMonthly = M.isos.map(() => ({ net: 0, orders: 0 })), nzMonthly = M.isos.map(() => ({ net: 0, orders: 0 }));
  ctyMonth.forEach(r => { const i = mIdx[r.month]; if (i == null) return; const net = n2(r.net_sales);
    totalMonthly[i] = n2(totalMonthly[i] + net);
    if (named.includes(r.shipping_country)) cm[r.shipping_country][i] = n2(cm[r.shipping_country][i] + net);
    if (r.shipping_country === 'Australia') { auMonthly[i] = { net: n2(net), orders: +r.orders || 0 }; }
    if (r.shipping_country === 'New Zealand') { nzMonthly[i] = { net: n2(net), orders: +r.orders || 0 }; }
  });
  cm['Other'] = totalMonthly.map((t, i) => Math.max(0, n2(t - named.reduce((a, c) => a + cm[c][i], 0))));

  return { meta: { source: 'Shopify · ShopifyQL (shipping geo)', currency: 'AUD', asOf: iso(today), window: '12 months', live: true },
    months: M.labels, totalMonthly, countries,
    au: { states, monthly: auMonthly, stateMonthly }, nz: { monthly: nzMonthly }, countryMonthly: cm };
}

module.exports = async (req, res) => {
  try {
    const dataset = (req.query && req.query.dataset) || 'products';
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const payload = dataset === 'region' ? await buildRegion(today) : await buildProducts(today);
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify(payload));
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};

module.exports.buildProducts = buildProducts;     // shared with the AI read subsystem
module.exports.buildRegion = buildRegion;         // shared with the AI read subsystem
module.exports.categorize = categorize;   // for offline unit testing
module.exports.accessToken = accessToken;         // for offline unit testing
module.exports.storeDomain = storeDomain;         // for offline unit testing
module.exports.resetTokenCache = () => { cachedToken = null; cachedTokenExpiry = 0; };
