/* Unit tests for the AI read subsystem's access control and field policy.
   Run: node source/test_ai_access.js   (exit 0 = all pass)

   Pure functions only — no network, no credentials. The point of these tests is
   that a scope mistake here leaks salaries, so every deny path is asserted. */
const A = require('../lib/ai-access.js');
const { PNL_FIELDS, DATASETS } = require('../lib/ai-schema.js');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}

const TOK_FULL = 'sk_dl_' + 'a'.repeat(48);
const TOK_TOP  = 'sk_dl_' + 'b'.repeat(48);
const TOK_NONE = 'sk_dl_' + 'c'.repeat(48);
const RAW = JSON.stringify([
  { name: 'cfo-agent',   token: TOK_FULL, scopes: ['pnl.full', 'products', 'region', 'pulse'] },
  { name: 'media-buyer', token: TOK_TOP,  scopes: ['pnl.topline', 'pulse'] },
  { name: 'stale',       token: TOK_NONE, scopes: [] },
]);

/* ---- token parsing ------------------------------------------------------- */
(() => {
  ok('parse: three entries', A.parseTokens(RAW).length === 3);
  ok('parse: unset → none', A.parseTokens(undefined).length === 0);
  ok('parse: blank → none', A.parseTokens('   ').length === 0);
  ok('parse: malformed JSON → none, no throw', A.parseTokens('{nope').length === 0);
  ok('parse: non-array → none', A.parseTokens('{"token":"x"}').length === 0);
  ok('parse: short token rejected',
    A.parseTokens('[{"name":"n","token":"tiny","scopes":["pulse"]}]').length === 0);
  ok('parse: unknown scope dropped',
    A.parseTokens(`[{"name":"n","token":"${TOK_FULL}","scopes":["pulse","wat"]}]`)[0].scopes.join() === 'pulse');
})();

/* ---- identification ------------------------------------------------------ */
(() => {
  ok('identify: valid bearer', A.identify(`Bearer ${TOK_FULL}`, RAW).name === 'cfo-agent');
  ok('identify: case-insensitive scheme', A.identify(`bearer ${TOK_TOP}`, RAW).name === 'media-buyer');
  ok('identify: never returns the token',
    A.identify(`Bearer ${TOK_FULL}`, RAW).token === undefined);
  ok('identify: unknown token → null', A.identify('Bearer sk_dl_' + 'z'.repeat(48), RAW) === null);
  ok('identify: no header → null', A.identify(undefined, RAW) === null);
  ok('identify: basic auth rejected', A.identify('Basic ZGlnZ2VybGlkOnB3', RAW) === null);
  ok('identify: bare token without scheme rejected', A.identify(TOK_FULL, RAW) === null);
  ok('identify: empty AI_TOKENS → null', A.identify(`Bearer ${TOK_FULL}`, '') === null);
  ok('identify: prefix of a real token rejected',
    A.identify(`Bearer ${TOK_FULL.slice(0, -1)}`, RAW) === null);
  ok('sameToken: length mismatch false', A.sameToken('abc', 'abcd') === false);
  ok('sameToken: equal true', A.sameToken('abcd', 'abcd') === true);
  ok('sameToken: non-string false', A.sameToken(null, 'abcd') === false);
})();

/* ---- dataset gating ------------------------------------------------------ */
(() => {
  const full = A.identify(`Bearer ${TOK_FULL}`, RAW).scopes;
  const top  = A.identify(`Bearer ${TOK_TOP}`, RAW).scopes;

  ok('gate: full may read pnl', A.canRead(full, 'pnl') === true);
  ok('gate: full may read products', A.canRead(full, 'products') === true);
  ok('gate: topline may read pnl', A.canRead(top, 'pnl') === true);
  ok('gate: topline may NOT read products', A.canRead(top, 'products') === false);
  ok('gate: topline may NOT read region', A.canRead(top, 'region') === false);
  ok('gate: topline may read pulse', A.canRead(top, 'pulse') === true);
  ok('gate: no scopes reads nothing',
    ['pnl', 'products', 'region', 'pulse'].every(d => !A.canRead([], d)));
})();

/* ---- field policy — the leak-sensitive part ------------------------------ */
(() => {
  const full = ['pnl.full'], top = ['pnl.topline'];

  ok('policy: full drops nothing', A.pnlFilter(full).drop.length === 0);
  ok('policy: topline drops the sensitive set', A.pnlFilter(top).drop.length === A.SENSITIVE_FIELDS.length);
  ok('policy: no pnl scope is denied', A.pnlFilter(['pulse']).denied === true);
  ok('policy: full wins when a token holds both',
    A.pnlFilter(['pnl.topline', 'pnl.full']).drop.length === 0);

  const row = {
    date: '2026-09-08', revenue: 10905.13, orders: 39, sessions: 5453,
    salaries: 4200, profit: 1800, profitPct: 16.5, prodCost: 3000, totalExp: 9000,
    metaTotal: 2500, mer: 4.4, roas: 4.1,
  };
  const [tl] = A.applyFilter([row], A.pnlFilter(top).drop);
  ok('filter: salaries removed', !('salaries' in tl), Object.keys(tl));
  ok('filter: profit removed', !('profit' in tl));
  ok('filter: profitPct removed', !('profitPct' in tl));
  ok('filter: prodCost removed', !('prodCost' in tl));
  ok('filter: totalExp removed', !('totalExp' in tl));
  ok('filter: revenue kept', tl.revenue === 10905.13);
  ok('filter: sessions kept', tl.sessions === 5453);
  ok('filter: ad spend kept', tl.metaTotal === 2500);
  ok('filter: MER kept', tl.mer === 4.4);
  ok('filter: original row untouched', row.salaries === 4200);

  const [fl] = A.applyFilter([row], A.pnlFilter(full).drop);
  ok('filter: full keeps salaries', fl.salaries === 4200);

  // Nothing marked sensitive in the dictionary may survive a topline filter.
  const dropped = new Set(A.pnlFilter(top).drop);
  const leaked = Object.entries(PNL_FIELDS)
    .filter(([k, f]) => f.sensitive && !dropped.has(k)).map(([k]) => k);
  ok('policy: every field marked sensitive is actually withheld', leaked.length === 0, leaked);
})();

/* ---- diagnose: every failure mode must be distinguishable --------------- */
(() => {
  const long = 'a'.repeat(40);
  const d = raw => A.diagnose(raw);

  ok('diagnose: unset', d(undefined).ok === false && /not set/.test(d(undefined).reason), d(undefined));
  ok('diagnose: blank is treated as unset', /not set/.test(d('   ').reason), d('   '));
  ok('diagnose: malformed JSON named', /not valid JSON/.test(d('[{nope').reason), d('[{nope'));
  ok('diagnose: malformed JSON carries a parse error', !!d('[{nope').parse_error);
  ok('diagnose: malformed JSON suggests the pipe', /vercel env add/.test(d('[{nope').hint || ''));
  ok('diagnose: non-array named', /not an array/.test(d('{"a":1}').reason), d('{"a":1}'));
  ok('diagnose: empty array named', /empty array/.test(d('[]').reason), d('[]'));

  const short = `[{"name":"x","token":"tiny","scopes":["pulse"]}]`;
  ok('diagnose: short token rejected and counted',
    d(short).ok === false && d(short).entries_rejected_for_short_or_missing_token === 1, d(short));
  ok('diagnose: lists the valid scopes when nothing is usable',
    Array.isArray(d(short).valid_scopes) && d(short).valid_scopes.includes('pnl.topline'), d(short));

  const badScope = `[{"name":"x","token":"${long}","scopes":["nope"]}]`;
  ok('diagnose: a valid token with no valid scope is ok:true (403 territory, not 503)',
    d(badScope).ok === true, d(badScope));
  ok('diagnose: names the scopeless consumer',
    d(badScope).entries_with_no_valid_scopes.join() === 'x', d(badScope));

  const good = `[{"name":"a","token":"${long}","scopes":["pulse"]},{"name":"b","token":"${'b'.repeat(40)}","scopes":["pnl.full"]}]`;
  ok('diagnose: healthy config', d(good).ok === true && d(good).entries === 2, d(good));
  ok('diagnose: healthy config has no complaints', d(good).entries_with_no_valid_scopes.length === 0);

  // A diagnostic that echoed the secret would be worse than the ambiguity it replaced.
  ok('diagnose: never echoes a token', !JSON.stringify(d(good)).includes(long), d(good));
  ok('diagnose: never echoes a token when rejecting', !JSON.stringify(d(short)).includes('tiny'), d(short));
})();

/* ---- schema/scope consistency ------------------------------------------- */
(() => {
  const known = Object.keys(A.SCOPES);
  const bad = Object.entries(DATASETS)
    .flatMap(([k, d]) => d.scopes.filter(s => !known.includes(s)).map(s => `${k}:${s}`));
  ok('schema: every dataset scope exists in SCOPES', bad.length === 0, bad);
  ok('schema: every scope maps to a dataset',
    known.every(s => A.SCOPES[s].dataset && A.SCOPES[s].label));
  ok('schema: pnl fields documented', Object.keys(PNL_FIELDS).length > 40);
})();

console.log(`\nai access: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
