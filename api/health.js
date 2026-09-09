/* =========================================================================
   /api/health  —  ungated diagnostic (see middleware matcher).
   Reports whether each live integration is CONFIGURED and REACHABLE.
   Returns status + error strings ONLY — never financial figures or secrets.
   Safe to remove once the integrations are verified.
   ========================================================================= */
const has = k => !!(process.env[k] && String(process.env[k]).trim());
const clip = s => String(s == null ? '' : (s.message || s)).slice(0, 240);

module.exports = async (req, res) => {
  const out = { ok: true, ts: new Date().toISOString(), checks: {} };

  out.checks.sitePassword = { configured: has('SITE_PASSWORD') };

  // ---- Shopify ----
  // Either credential shape counts as configured: a long-lived SHOPIFY_TOKEN, or
  // SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET for the client credentials grant.
  // Reporting only the first would call a correctly-configured CLI app unconfigured.
  const shopAuth = has('SHOPIFY_TOKEN') ? 'token'
    : (has('SHOPIFY_CLIENT_ID') && has('SHOPIFY_CLIENT_SECRET')) ? 'client_credentials' : null;
  const shop = { configured: has('SHOPIFY_STORE') && !!shopAuth, reachable: false };
  if (shopAuth) shop.auth = shopAuth;
  if (shop.configured) {
    try {
      const store = process.env.SHOPIFY_STORE.trim().replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '');
      shop.store = store;
      const ver = process.env.SHOPIFY_API_VERSION || '2026-07';

      let token = process.env.SHOPIFY_TOKEN;
      if (!token) {
        // Mint one so "reachable" tests the whole chain, grant included.
        const t = await fetch(`https://${store}.myshopify.com/admin/oauth/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: process.env.SHOPIFY_CLIENT_ID,
            client_secret: process.env.SHOPIFY_CLIENT_SECRET,
          }),
        });
        const tj = await t.json().catch(() => ({}));
        token = tj.access_token;
        if (!token) {
          shop.error = `token grant HTTP ${t.status}`
            + (tj.error ? ` — ${clip(tj.error)}` : '')
            + ' (client credentials need the app and store in the same Shopify organisation)';
        }
      }
      if (!token) throw new Error(shop.error || 'no token');

      const q = 'FROM sales SHOW net_sales SINCE 2026-01-01 UNTIL 2026-01-02';
      const r = await fetch(`https://${store}.myshopify.com/admin/api/${ver}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query: `{ shopifyqlQuery(query: ${JSON.stringify(q)}) { parseErrors tableData { rows } } }` }),
      });
      if (r.status === 401 || r.status === 403) shop.error = `HTTP ${r.status} — token rejected (check the token / scopes).`;
      else if (!r.ok) shop.error = `HTTP ${r.status}`;
      else {
        const j = await r.json();
        const q2 = j.data && j.data.shopifyqlQuery;
        if (j.errors) shop.error = 'GraphQL: ' + clip(JSON.stringify(j.errors));
        else if (q2 && q2.parseErrors && q2.parseErrors.length) shop.error = 'ShopifyQL: ' + q2.parseErrors.join('; ');
        else shop.reachable = true;   // a row (or empty rows) came back cleanly
      }
    } catch (e) { shop.error = shop.error || clip(e); }
    if (shop.error && /access|scope|report|permission/i.test(shop.error))
      shop.hint = 'The token is missing the read_reports scope (required for ShopifyQL).';
  }
  out.checks.shopify = shop;

  // ---- Google Sheet ----
  const sheets = { configured: has('GOOGLE_SERVICE_ACCOUNT_EMAIL') && has('GOOGLE_PRIVATE_KEY'), reachable: false };
  if (sheets.configured) {
    try {
      const { google } = require('googleapis');
      const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
      const jwt = new google.auth.JWT(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, null, key,
        ['https://www.googleapis.com/auth/spreadsheets.readonly']);
      const api = google.sheets({ version: 'v4', auth: jwt });
      const id = process.env.SHEET_ID || '1rAut5J3SoDvH0ObdVuTenqGjiO-u7M6cPpRNQ5Hqpnw';
      const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties.title' });
      sheets.reachable = true;

      // Reading the file is not the same as getting data out of it. This check
      // used to stop at spreadsheets.get, so it reported reachable:true for
      // months while /api/data extracted nothing at all. Parse the current
      // month and report the row count, so green means figures are arriving.
      const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const yr = process.env.SHEET_YEAR || '26';
      const y = new Date(); y.setDate(y.getDate() - 1);
      const tab = `${MONTH_ABBR[y.getMonth()]} '${yr}`;
      const titles = (meta.data.sheets || []).map(sh => sh.properties && sh.properties.title);
      if (!titles.includes(tab)) {
        sheets.rows = 0;
        sheets.error = `month tab "${tab}" not found`;
      } else {
        const vals = await api.spreadsheets.values.get({
          spreadsheetId: id,
          range: `'${tab.replace(/'/g, "''")}'!A1:AZ131`,
          valueRenderOption: 'FORMATTED_VALUE',
        });
        const rows = require('./data.js').parseDaily(vals.data.values, y.getMonth() + 1);
        sheets.tab = tab;
        sheets.rows = rows.length;
        if (!rows.length) {
          sheets.error = 'sheet readable but 0 rows parsed from ' + tab;
          sheets.hint = 'GET /api/data?diag=1 — the diag block reports where the metric block actually is.';
        }
      }
    } catch (e) {
      sheets.error = clip(e);
      if (/permission|not found|403|404/i.test(sheets.error))
        sheets.hint = 'Share the sheet (Viewer) with GOOGLE_SERVICE_ACCOUNT_EMAIL, and enable the Sheets API.';
    }
  }
  out.checks.sheets = sheets;

  // ---- PostHog (site signals) ----
  const ph = { configured: has('POSTHOG_API_KEY'), reachable: false };
  if (ph.configured) {
    try {
      const host = (process.env.POSTHOG_HOST || 'https://us.posthog.com').replace(/\/$/, '');
      const pid = process.env.POSTHOG_PROJECT_ID || '475333';
      const r = await fetch(`${host}/api/projects/${pid}/query/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.POSTHOG_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query: 'SELECT count() FROM events WHERE timestamp >= now() - INTERVAL 1 DAY' } }),
      });
      if (r.status === 401 || r.status === 403) { ph.error = `HTTP ${r.status} — key rejected`; ph.hint = 'The personal API key needs the read scope query:read (and the right project id).'; }
      else if (!r.ok) ph.error = `HTTP ${r.status}`;
      else { const j = await r.json(); if (j.error || j.detail) ph.error = clip(j.error || j.detail); else ph.reachable = true; }
    } catch (e) { ph.error = clip(e); }
  }
  out.checks.posthog = ph;

  out.ok = (shop.reachable || !shop.configured) && (sheets.reachable || !sheets.configured) && (ph.reachable || !ph.configured);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(out, null, 2));
};
