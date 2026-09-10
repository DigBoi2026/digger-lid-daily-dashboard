/* =========================================================================
   /api/shopify  —  Vercel Serverless Function (Node).
   Live Shopify data via the Admin GraphQL API (ShopifyQL `sales`). Assembles
   the SAME shapes the embedded snapshots use, so the pages upgrade transparently:
     /api/shopify?dataset=products  → window.DL_SHOPIFY shape (Products page)
     /api/shopify?dataset=region    → window.DL_REGION shape (Region page)
     /api/shopify?dataset=geo       → daily AU / NZ / other net sales (Forecast country lens)

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
/* The bucket holds 1000 points and refills ~50 a second, and a cold browse of
   Products then Region costs about 975 — so a drained bucket needs the better
   part of 20 seconds to come back, and the previous ceiling of 11.5s gave up
   short of that. Five consecutive calls proved it: two served, three threw
   THROTTLED. Budget ~30s instead; maxDuration is 60. */
const THROTTLE_BACKOFF_MS = [800, 1800, 3500, 7000, 15000];   // ~28s worst case

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
  /* Two at a time, not all five at once.

     The rate limit is a leaky bucket that refills ~50 points a second and each
     of these costs ~65, so five in one burst draws ~325 before any of it comes
     back. That was survivable until three more queries were added below; past
     that the route started throttling, and a throttle loses the whole dataset to
     the snapshot fallback. Pairs keep the peak draw where it was while barely
     costing wall-clock — the queries take far longer than the gap between them. */
  const WIN = { 3: win(3), 7: win(7), 30: win(30), 90: win(90), '12M': { since: M.since, until: M.until } };
  const windows = {};
  const winEntries = Object.entries(WIN);
  for (let i = 0; i < winEntries.length; i += 2) {
    await Promise.all(winEntries.slice(i, i + 2).map(async ([k, w]) => {
      const rows = await shopifyql(
        `FROM sales SHOW net_sales, orders, net_items_sold GROUP BY product_title SINCE ${w.since} UNTIL ${w.until} ORDER BY net_sales DESC`);
      windows[k] = rows.filter(r => n2(r.net_sales) > 0).map(r => ({
        t: r.product_title == null ? '(untitled)' : r.product_title, k: categorize(r.product_title),
        net: n2(r.net_sales), u: +r.net_items_sold || 0, o: +r.orders || 0 }));
    }));
  }

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

/* ---------------------------------- geo --------------------------------- */

/* Daily net sales split AU / NZ / everywhere else, for the Forecast page's
   country lens.

   THREE QUERIES, NOT ONE, and the reason matters. `GROUP BY shipping_country,
   day` returns only the country-days that had a sale, which is sparse and
   unbounded — fifteen countries over two years is thousands of rows and the
   shape changes with trade. Asking for the total, then Australia, then New
   Zealand gives three dense series of one row per day, and everywhere else
   falls out as total minus the two. That also sweeps up the orders Shopify
   records with no shipping country at all, which a country-grouped query would
   have silently dropped on the floor.

   Sequenced rather than parallel: a shopifyqlQuery costs about 65 of a
   1000-point bucket and firing them together is what used to trip the
   throttle.

   NOTE ON THE MEASURE. This is net_sales on shipping address, which is NOT the
   P&L's revenue — that includes GST and is recorded against the whole business,
   not a destination. The two will not tie, and the page says so. The workbook's
   own Country 2/3/4 blocks are the source that would tie, and they are empty on
   every day of every month; when they are filled this route stops being the
   place this comes from. */
async function buildGeo(today) {
  const since = iso(addDays(today, -730));
  const until = iso(addDays(today, 1));
  const one = q => shopifyql(q);

  const totRows = await one(
    `FROM sales SHOW net_sales, orders GROUP BY day SINCE ${since} UNTIL ${until} ORDER BY day`);
  const auRows = await one(
    `FROM sales SHOW net_sales, orders WHERE shipping_country = 'Australia' GROUP BY day SINCE ${since} UNTIL ${until} ORDER BY day`);
  const nzRows = await one(
    `FROM sales SHOW net_sales, orders WHERE shipping_country = 'New Zealand' GROUP BY day SINCE ${since} UNTIL ${until} ORDER BY day`);

  const bucket = rows => {
    const m = {};
    (rows || []).forEach(r => {
      const d = String(r.day || '').slice(0, 10);
      if (!d) return;
      m[d] = { net: n2(r.net_sales), orders: +r.orders || 0 };
    });
    return m;
  };
  const T = bucket(totRows), A = bucket(auRows), N = bucket(nzRows);

  const daily = Object.keys(T).sort().map(d => {
    const t = T[d], a = A[d] || { net: 0, orders: 0 }, z = N[d] || { net: 0, orders: 0 };
    /* Clamped at zero: a refund landing on a day with no matching sale can make
       the residual negative, which is an artefact of net_sales being net, not a
       negative country. */
    return {
      date: d,
      total: t.net, totalOrders: t.orders,
      au: a.net, auOrders: a.orders,
      nz: z.net, nzOrders: z.orders,
      other: n2(Math.max(0, t.net - a.net - z.net)),
      otherOrders: Math.max(0, t.orders - a.orders - z.orders),
    };
  });

  const sum = k => n2(daily.reduce((x, r) => x + (r[k] || 0), 0));
  return {
    meta: {
      source: 'Shopify · ShopifyQL (net sales by shipping country)',
      currency: 'AUD', asOf: iso(today), since, until, days: daily.length,
      measure: 'net_sales',
      caveat: 'Net sales on shipping address. NOT the P&L revenue — that includes GST and ' +
              'is not recorded by destination — so these totals do not tie to the rest of ' +
              'the board, and there is no cost data per country, so this supports revenue ' +
              'and orders only, never profit.',
      ties_to_pnl: false,
    },
    totals: { total: sum('total'), au: sum('au'), nz: sum('nz'), other: sum('other') },
    daily,
  };
}

/* ------------------------------ customers ------------------------------- */

/* Daily net sales and orders split new vs returning, for the Forecast page's
   customer lens.

   Shopify DOES carry a revenue split by customer type — the dimension is
   `new_or_returning_customer`, with values 'New' and 'Returning'. (It is not
   `customer_type`; asking for that returns "column not found", which is how the
   first cut concluded no split existed and fell back to order counts from the
   sheet.) The sheet's own New Customer Orders column matches Shopify's
   new_customers count day for day, so the counts tie to the board; the revenue
   is net_sales on the same basis as the country lens, so it does not.

   Two dense day-grouped queries rather than one grouped by type: a grouped
   query drops the (type, day) cells with no sale, and Returning has none on a
   handful of days. Zero on such a day is a measurement. */
async function buildCustomers(today) {
  const since = iso(addDays(today, -730));
  const until = iso(addDays(today, 1));
  const q = t => shopifyql(
    `FROM sales SHOW net_sales, orders WHERE new_or_returning_customer = '${t}' GROUP BY day SINCE ${since} UNTIL ${until} ORDER BY day`);
  const newRows = await q('New');
  const retRows = await q('Returning');

  const bucket = rows => {
    const m = {};
    (rows || []).forEach(r => {
      const d = String(r.day || '').slice(0, 10);
      if (d) m[d] = { net: n2(r.net_sales), orders: +r.orders || 0 };
    });
    return m;
  };
  const N = bucket(newRows), R = bucket(retRows);
  const days = [...new Set([...Object.keys(N), ...Object.keys(R)])].sort();
  const daily = days.map(d => {
    const a = N[d] || { net: 0, orders: 0 }, b = R[d] || { net: 0, orders: 0 };
    return { date: d,
      newNet: a.net, newOrders: a.orders,
      retNet: b.net, retOrders: b.orders,
      total: n2(a.net + b.net), totalOrders: a.orders + b.orders };
  });
  const sum = k => n2(daily.reduce((x, r) => x + (r[k] || 0), 0));
  return {
    meta: {
      source: 'Shopify · ShopifyQL (net sales by new_or_returning_customer)',
      currency: 'AUD', asOf: iso(today), since, until, days: daily.length,
      measure: 'net_sales',
      caveat: 'Net sales by customer type. Order counts tie to the sheet day for day; ' +
              'the revenue is Shopify net sales (ex GST, net of refunds) and does not ' +
              'tie to the P&L, and there is no cost data by customer type, so no profit.',
      ties_to_pnl: false, orders_tie_to_pnl: true,
    },
    totals: { newNet: sum('newNet'), retNet: sum('retNet'), newOrders: sum('newOrders'), retOrders: sum('retOrders') },
    daily,
  };
}

/* ------------------------------- products, daily ------------------------ */

/* Daily net sales for the top products, for the Forecast page's product lens.

   The catalogue is concentrated: the top six lines are ~85% of net sales and
   the tail is thirty items, gifts-with-purchase at $0, and an untitled bucket.
   So the lens forecasts the top N as their own series and everything else as
   one residual, which is dense by construction and sweeps up the $0 GWP lines
   and refunds that would otherwise fall through.

   One query for the ranking, one for the total, then one per product — WHERE
   product_title = X GROUP BY day is a dense series; GROUP BY product_title, day
   is the sparse unbounded grid the country lens already learnt to avoid.
   Sequenced for the rate limit. */
const PRODUCT_LENS_TOP = 6;
async function buildProductsDaily(today) {
  const since = iso(addDays(today, -730));
  const until = iso(addDays(today, 1));
  const yrSince = iso(addDays(today, -365));

  const rank = await shopifyql(
    `FROM sales SHOW net_sales, orders GROUP BY product_title SINCE ${yrSince} UNTIL ${until} ORDER BY net_sales DESC`);
  const top = rank
    .filter(r => r.product_title && String(r.product_title).trim() && n2(r.net_sales) > 0)
    .filter(r => !/GWP$/i.test(r.product_title))
    .slice(0, PRODUCT_LENS_TOP)
    .map((r, i) => ({ key: 'p' + i, title: String(r.product_title), net365: n2(r.net_sales), orders365: +r.orders || 0 }));

  const bucket = rows => {
    const m = {};
    (rows || []).forEach(r => {
      const d = String(r.day || '').slice(0, 10);
      if (d) m[d] = { net: n2(r.net_sales), orders: +r.orders || 0 };
    });
    return m;
  };
  const T = bucket(await shopifyql(
    `FROM sales SHOW net_sales, orders GROUP BY day SINCE ${since} UNTIL ${until} ORDER BY day`));
  const per = {};
  for (const p of top) {
    const lit = p.title.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    per[p.key] = bucket(await shopifyql(
      `FROM sales SHOW net_sales, orders WHERE product_title = '${lit}' GROUP BY day SINCE ${since} UNTIL ${until} ORDER BY day`));
  }

  const daily = Object.keys(T).sort().map(d => {
    const row = { date: d, total: T[d].net, totalOrders: T[d].orders };
    let acc = 0;
    top.forEach(p => { const v = per[p.key][d] || { net: 0, orders: 0 }; row[p.key] = v.net; row[p.key + 'Orders'] = v.orders; acc += v.net; });
    row.other = n2(Math.max(0, T[d].net - acc));        // clamped: a refund can push it under
    return row;
  });
  const sum = k => n2(daily.reduce((x, r) => x + (r[k] || 0), 0));
  const totals = { total: sum('total'), other: sum('other') };
  top.forEach(p => totals[p.key] = sum(p.key));
  return {
    meta: {
      source: 'Shopify · ShopifyQL (net sales by product_title)',
      currency: 'AUD', asOf: iso(today), since, until, days: daily.length,
      measure: 'net_sales', top: PRODUCT_LENS_TOP,
      caveat: 'Net sales by product, ex GST and net of refunds — not the P&L revenue, ' +
              'so it does not tie to the board. "Everything else" is the residual: the ' +
              'long tail, gifts with purchase at $0, and any refund that outran its sale.',
      ties_to_pnl: false,
    },
    products: top, totals, daily,
  };
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
    const payload = dataset === 'region' ? await buildRegion(today)
                  : dataset === 'geo' ? await buildGeo(today)
                  : dataset === 'customers' ? await buildCustomers(today)
                  : dataset === 'productsDaily' ? await buildProductsDaily(today)
                  : await buildProducts(today);
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify(payload));
  } catch (err) {
    const msg = String((err && err.message) || err);
    /* A rate limit is temporary and self-healing, so answer 503 + Retry-After
       rather than 500. A 500 is a hard failure the CDN will not paper over; a
       503 lets stale-while-revalidate keep serving the last good copy while the
       bucket refills, instead of dropping every page to its embedded snapshot.
       Everything else — a bad query, a dead token — stays a 500, because those
       do not fix themselves and should be loud. */
    if (/THROTTLED|Rate limited|HTTP 429/i.test(msg)) {
      res.setHeader('Retry-After', '30');
      res.setHeader('Cache-Control', 's-maxage=0, stale-while-revalidate=1800');
      res.status(503).json({ error: msg, retry_after_seconds: 30,
        detail: 'Shopify rate limit. Transient — the previous response stays servable while it clears.' });
      return;
    }
    res.status(500).json({ error: msg });
  }
};

module.exports.buildProducts = buildProducts;     // shared with the AI read subsystem
module.exports.buildRegion = buildRegion;         // shared with the AI read subsystem
module.exports.buildGeo = buildGeo;               // the Forecast page's country lens
module.exports.buildCustomers = buildCustomers;   // the Forecast page's customer lens
module.exports.buildProductsDaily = buildProductsDaily;   // the Forecast page's product lens
module.exports.categorize = categorize;   // for offline unit testing
module.exports.accessToken = accessToken;         // for offline unit testing
module.exports.storeDomain = storeDomain;         // for offline unit testing
module.exports.resetTokenCache = () => { cachedToken = null; cachedTokenExpiry = 0; };
