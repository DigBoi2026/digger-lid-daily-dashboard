/* Route-level tests for /api/ai/*: the guard, the status codes, and what each
   response does and does not contain.
   Run: node source/test_ai_routes.js   (exit 0 = all pass)

   No network. Upstream data builders are never reached — every case here is
   settled by the guard or by scope checks before any fetch happens. */
let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}

const TOK_FULL = 'sk_dl_' + 'a'.repeat(48);
const TOK_TOP  = 'sk_dl_' + 'b'.repeat(48);
const RAW = JSON.stringify([
  { name: 'cfo-agent',   token: TOK_FULL, scopes: ['pnl.full', 'products', 'region', 'pulse'] },
  { name: 'media-buyer', token: TOK_TOP,  scopes: ['pnl.topline'] },
]);

function mockRes() {
  const r = { code: null, body: null, headers: {}, text: null };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.send = b => { r.text = b; return r; };
  return r;
}
const mockReq = (auth, query) => ({ headers: { authorization: auth, host: 'digboi-seven.vercel.app' }, query: query || {} });

const route = n => { delete require.cache[require.resolve('../api/ai/' + n)]; return require('../api/ai/' + n); };

(async () => {
  /* ---- guard: unconfigured ---------------------------------------------- */
  delete process.env.AI_TOKENS;
  for (const n of ['manifest.js', 'schema.js', 'query.js', 'llms.js']) {
    const res = mockRes();
    await route(n)(mockReq(`Bearer ${TOK_FULL}`), res);
    ok(`${n}: 503 when AI_TOKENS unset`, res.code === 503, res.code);
    ok(`${n}: names the missing config`, res.body && res.body.error === 'ai_subsystem_not_configured', res.body);
  }

  process.env.AI_TOKENS = RAW;

  /* ---- guard: bad credentials ------------------------------------------- */
  for (const n of ['manifest.js', 'schema.js', 'query.js', 'llms.js']) {
    let res = mockRes();
    await route(n)(mockReq(undefined), res);
    ok(`${n}: 401 with no header`, res.code === 401, res.code);
    ok(`${n}: sets WWW-Authenticate`, /Bearer/.test(res.headers['WWW-Authenticate'] || ''), res.headers);

    res = mockRes();
    await route(n)(mockReq('Bearer sk_dl_' + 'z'.repeat(48)), res);
    ok(`${n}: 401 with wrong token`, res.code === 401, res.code);

    res = mockRes();
    await route(n)(mockReq('Basic ZGlnZ2VybGlkOkRMMjAyNg=='), res);
    ok(`${n}: 401 for basic auth`, res.code === 401, res.code);
  }

  /* ---- manifest --------------------------------------------------------- */
  {
    let res = mockRes();
    await route('manifest.js')(mockReq(`Bearer ${TOK_FULL}`), res);
    ok('manifest: 200 for valid token', res.code === 200, res.code);
    ok('manifest: names the caller', res.body.caller.name === 'cfo-agent', res.body.caller);
    ok('manifest: read_only asserted', res.body.access.read_only === true);
    ok('manifest: all five datasets for full scope', res.body.datasets.length === 5, res.body.datasets.length);
    ok('manifest: nothing withheld for full', res.body.datasets_withheld.length === 0, res.body.datasets_withheld);
    ok('manifest: not cacheable', /no-store/.test(res.headers['Cache-Control'] || ''), res.headers);
    ok('manifest: never echoes a token',
      !JSON.stringify(res.body).includes(TOK_FULL) && !JSON.stringify(res.body).includes(TOK_TOP));

    res = mockRes();
    await route('manifest.js')(mockReq(`Bearer ${TOK_TOP}`), res);
    ok('manifest: topline sees only pnl datasets', res.body.datasets.length === 2, res.body.datasets.map(d => d.dataset));
    ok('manifest: withholds products/region/pulse',
      ['products', 'region', 'pulse'].every(d => res.body.datasets_withheld.includes(d)), res.body.datasets_withheld);
  }

  /* ---- schema ----------------------------------------------------------- */
  {
    let res = mockRes();
    await route('schema.js')(mockReq(`Bearer ${TOK_TOP}`, { dataset: 'pnl.daily' }), res);
    ok('schema: 200 in-scope', res.code === 200, res.code);
    ok('schema: salaries not described for topline', !('salaries' in res.body.fields), Object.keys(res.body.fields));
    ok('schema: revenue described', res.body.fields.revenue.unit === 'aud', res.body.fields.revenue);
    ok('schema: lists what it withheld', res.body.fields_withheld.includes('salaries'), res.body.fields_withheld);

    res = mockRes();
    await route('schema.js')(mockReq(`Bearer ${TOK_TOP}`, { dataset: 'products' }), res);
    ok('schema: 403 out of scope', res.code === 403, res.code);

    res = mockRes();
    await route('schema.js')(mockReq(`Bearer ${TOK_FULL}`, { dataset: 'nope' }), res);
    ok('schema: 404 unknown dataset', res.code === 404, res.code);

    res = mockRes();
    await route('schema.js')(mockReq(`Bearer ${TOK_FULL}`, { dataset: 'pnl.daily' }), res);
    ok('schema: full scope describes salaries', 'salaries' in res.body.fields);
    // The units legend belongs to the full listing, not a single-dataset answer.
    res = mockRes();
    await route('schema.js')(mockReq(`Bearer ${TOK_FULL}`, {}), res);
    ok('schema: full listing explains percent units',
      /percentage points/.test(res.body.units.percent), res.body.units);
    ok('schema: full listing covers all five datasets',
      Object.keys(res.body.datasets).length === 5, Object.keys(res.body.datasets));

    res = mockRes();
    await route('schema.js')(mockReq(`Bearer ${TOK_TOP}`, {}), res);
    ok('schema: full listing is scoped too',
      Object.keys(res.body.datasets).length === 2, Object.keys(res.body.datasets));
  }

  /* ---- query: validation before any upstream call ----------------------- */
  {
    let res = mockRes();
    await route('query.js')(mockReq(`Bearer ${TOK_FULL}`, {}), res);
    ok('query: 400 without dataset', res.code === 400, res.code);
    ok('query: lists known datasets', Array.isArray(res.body.known) && res.body.known.length === 5, res.body.known);

    res = mockRes();
    await route('query.js')(mockReq(`Bearer ${TOK_FULL}`, { dataset: 'nope' }), res);
    ok('query: 404 unknown dataset', res.code === 404, res.code);

    res = mockRes();
    await route('query.js')(mockReq(`Bearer ${TOK_TOP}`, { dataset: 'products' }), res);
    ok('query: 403 out of scope', res.code === 403, res.code);
    ok('query: 403 states what is needed', /products/.test(res.body.detail), res.body);

    res = mockRes();
    await route('query.js')(mockReq(`Bearer ${TOK_FULL}`, { dataset: 'pnl.daily', since: '08-2026' }), res);
    ok('query: 400 on malformed since', res.code === 400 && res.body.error === 'bad_date', res.body);

    res = mockRes();
    await route('query.js')(mockReq(`Bearer ${TOK_FULL}`, { dataset: 'pnl.daily', until: 'yesterday' }), res);
    ok('query: 400 on malformed until', res.code === 400, res.body);
  }

  /* ---- llms ------------------------------------------------------------- */
  {
    let res = mockRes();
    await route('llms.js')(mockReq(`Bearer ${TOK_TOP}`), res);
    ok('llms: 200', res.code === 200, res.code);
    ok('llms: plain text', /text\/plain/.test(res.headers['Content-Type'] || ''), res.headers);
    ok('llms: states the caller', /media-buyer/.test(res.text), res.text && res.text.slice(0, 200));
    ok('llms: lists withheld fields', /salaries/.test(res.text));
    ok('llms: instructs not to estimate them', /outside your access/.test(res.text));
    ok('llms: warns null is not zero', /does not mean zero/.test(res.text));
    ok('llms: never prints the token', !res.text.includes(TOK_TOP));
    ok('llms: names withheld datasets', /products/.test(res.text));
  }

  /* ---- discoverability: a 401 must teach, not dead-end ------------------ */
  {
    const res = mockRes();
    await route('manifest.js')(mockReq(undefined), res);
    const b = JSON.stringify(res.body);
    ok('401 explains how to get access', /Ask whoever directed you/.test(b), res.body);
    ok('401 names the manifest', /api\/ai\/manifest/.test(b), res.body);
    ok('401 names the schema', /api\/ai\/schema/.test(b));
    ok('401 states the auth scheme', /Bearer/.test(b));
    ok('401 leaks no token', !b.includes(TOK_FULL) && !b.includes(TOK_TOP));
  }

  /* ---- /api/health advertises the subsystem without a credential -------- */
  {
    const h = require('../api/health.js');
    const res = mockRes();
    // No integrations configured: the ai block must still be present.
    for (const k of ['SITE_PASSWORD','SHOPIFY_STORE','SHOPIFY_TOKEN','GOOGLE_SERVICE_ACCOUNT_EMAIL',
                     'GOOGLE_PRIVATE_KEY','POSTHOG_API_KEY']) delete process.env[k];
    await h({ headers: {}, query: {} }, res);
    // health.js replies with res.send(JSON.stringify(...)), not res.json().
    res.body = res.body || JSON.parse(res.text);
    ok('health: carries an ai pointer', !!(res.body && res.body.ai), Object.keys(res.body || {}));
    ok('health: names the manifest', res.body.ai.manifest === '/api/ai/manifest', res.body.ai);
    ok('health: states the auth scheme', /Bearer/.test(res.body.ai.auth), res.body.ai);
    ok('health: reports whether tokens are configured', res.body.ai.enabled === true, res.body.ai.enabled);
    ok('health: ai pointer contains no figures',
      !/\d{4,}/.test(JSON.stringify(res.body.ai)), res.body.ai);
  }

  console.log(`\nai routes: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
