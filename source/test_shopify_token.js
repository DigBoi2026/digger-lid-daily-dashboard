/* Unit tests for the Shopify token acquisition in api/shopify.js — the client
   credentials grant, its 24h cache, and the static-token fallback.
   Run: node source/test_shopify_token.js   (exit 0 = all pass)

   fetch is stubbed, so this never touches the network or needs credentials. */
const S = require('../api/shopify.js');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}
async function throws(name, fn, re) {
  try { await fn(); ok(name, false, 'no throw'); }
  catch (e) { ok(name, re.test(e.message), e.message); }
}

const ENV = ['SHOPIFY_STORE','SHOPIFY_TOKEN','SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET'];
function setEnv(vals) {
  ENV.forEach(k => { delete process.env[k]; });
  Object.entries(vals).forEach(([k, v]) => { process.env[k] = v; });
  S.resetTokenCache();
}

// Records every fetch and replies with whatever the test queued.
let calls = [];
function stubFetch(reply) {
  calls = [];
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return reply(); };
}
const jsonOk = body => () => ({ ok: true, status: 200, json: async () => body });

(async () => {
  /* ---- store domain parsing ---- */
  setEnv({ SHOPIFY_STORE: 'digger-lid' });
  ok('bare subdomain', S.storeDomain() === 'digger-lid.myshopify.com', S.storeDomain());
  setEnv({ SHOPIFY_STORE: 'https://digger-lid.myshopify.com' });
  ok('full URL stripped', S.storeDomain() === 'digger-lid.myshopify.com', S.storeDomain());
  setEnv({});
  throws('no store → throws', async () => S.storeDomain(), /Missing SHOPIFY_STORE/);

  /* ---- static token short-circuits ---- */
  setEnv({ SHOPIFY_STORE: 'shop', SHOPIFY_TOKEN: 'shpat_static' });
  stubFetch(jsonOk({}));
  ok('static token returned', await S.accessToken() === 'shpat_static');
  ok('static token makes no request', calls.length === 0, calls.length);

  /* ---- static token wins over client credentials ---- */
  setEnv({ SHOPIFY_STORE: 'shop', SHOPIFY_TOKEN: 'shpat_static',
           SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'sec' });
  stubFetch(jsonOk({ access_token: 'minted' }));
  ok('static preferred over grant', await S.accessToken() === 'shpat_static');

  /* ---- no credentials at all ---- */
  setEnv({ SHOPIFY_STORE: 'shop' });
  await throws('no credentials → throws', () => S.accessToken(),
    /Missing SHOPIFY_TOKEN, or SHOPIFY_CLIENT_ID \+ SHOPIFY_CLIENT_SECRET/);

  /* ---- client credentials grant ---- */
  setEnv({ SHOPIFY_STORE: 'shop', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'sec' });
  stubFetch(jsonOk({ access_token: 'minted_1', expires_in: 86399 }));
  ok('grant returns token', await S.accessToken() === 'minted_1');
  ok('grant hits the token endpoint',
    calls[0].url === 'https://shop.myshopify.com/admin/oauth/access_token', calls[0].url);
  ok('grant POSTs', calls[0].opts.method === 'POST', calls[0].opts.method);
  ok('grant is form-encoded',
    calls[0].opts.headers['Content-Type'] === 'application/x-www-form-urlencoded');
  {
    const body = calls[0].opts.body;
    ok('grant_type=client_credentials', body.get('grant_type') === 'client_credentials', body.get('grant_type'));
    ok('client_id sent', body.get('client_id') === 'id');
    ok('client_secret sent', body.get('client_secret') === 'sec');
  }

  /* ---- the cache: a warm function must not mint per request ---- */
  ok('second call reuses cached token', await S.accessToken() === 'minted_1');
  ok('second call made no request', calls.length === 1, calls.length);

  /* ---- near expiry re-mints (60s guard) ---- */
  setEnv({ SHOPIFY_STORE: 'shop', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'sec' });
  stubFetch(jsonOk({ access_token: 'short', expires_in: 30 }));  // inside the guard
  await S.accessToken();
  const before = calls.length;
  stubFetch(jsonOk({ access_token: 'fresh', expires_in: 86399 }));
  ok('token inside the 60s guard is re-minted', await S.accessToken() === 'fresh');
  ok('...which cost one more request', calls.length === 1, { before, after: calls.length });

  /* ---- failures name the likely cause ---- */
  setEnv({ SHOPIFY_STORE: 'shop', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'sec' });
  stubFetch(() => ({ ok: false, status: 400, json: async () => ({ error: 'shop_not_permitted' }) }));
  await throws('grant HTTP error explains the org requirement', () => S.accessToken(),
    /HTTP 400.*same Shopify organisation/);

  setEnv({ SHOPIFY_STORE: 'shop', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'sec' });
  stubFetch(jsonOk({ scope: 'read_reports' }));   // 200 but no token
  await throws('token-less 200 → throws', () => S.accessToken(), /no access_token/);

  console.log(`\nshopify token: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
