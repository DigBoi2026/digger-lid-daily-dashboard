/* Unit tests for middleware.js — the password gate over the whole board.
   Run: node source/test_middleware.mjs   (exit 0 = all pass)

   No network and no credentials: SITE_PASSWORD is set per-case in-process.
   This file exists because the gate is the only thing between the open internet
   and the company P&L, and because it was migrated off Vercel's deprecated
   'edge' runtime — where `atob` is a global — onto the Node runtime, where the
   base64 decode goes through Buffer. A gate that throws while decoding fails
   closed, which is safe but locks out the owner too, so both paths are covered. */
import mw, { config } from '../middleware.js';

const req = (path, auth) => ({
  url: 'https://digboi-seven.vercel.app' + path,
  headers: { get: k => (k.toLowerCase() === 'authorization' && auth) ? auth : null },
});
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) pass++;
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
};

const PW = 'test-password';
const env = { ...process.env };
const reset = () => {
  delete process.env.SITE_PUBLIC; delete process.env.SITE_USER;
  process.env.SITE_PASSWORD = PW;
};
reset();

/* ---- runtime configuration ---- */
ok('runs on the Node runtime, not deprecated edge', config.runtime === 'nodejs', config.runtime);
ok('matcher is configured', Array.isArray(config.matcher) && config.matcher.length > 0);
ok('matcher exempts the credential-free health check', config.matcher.some(m => m.includes('api/health')));

/* ---- the gate ---- */
ok('no Authorization header → 401', mw(req('/')).status === 401);
ok('correct credentials → passes through', mw(req('/', 'Basic ' + b64(`diggerlid:${PW}`))) === undefined);
ok('wrong password → 401', mw(req('/', 'Basic ' + b64('diggerlid:wrong'))).status === 401);
ok('wrong username → 401', mw(req('/', 'Basic ' + b64(`bob:${PW}`))).status === 401);
ok('empty password → 401', mw(req('/', 'Basic ' + b64('diggerlid:'))).status === 401);
ok('Bearer scheme → 401 (tokens are for /api/ai/ only)', mw(req('/', 'Bearer sk_dl_x')).status === 401);
ok('malformed base64 → 401, not a crash', mw(req('/', 'Basic !!!not-base64!!!')).status === 401);

/* A password may contain ':' — the decoded pair must split on the FIRST colon
   only, or such a password can never be entered. */
process.env.SITE_PASSWORD = 'a:b:c';
ok('password containing colons still authenticates', mw(req('/', 'Basic ' + b64('diggerlid:a:b:c'))) === undefined);
reset();

/* SITE_USER override */
process.env.SITE_USER = 'ops';
ok('SITE_USER overrides the default username', mw(req('/', 'Basic ' + b64(`ops:${PW}`))) === undefined);
ok('default username rejected once SITE_USER is set', mw(req('/', 'Basic ' + b64(`diggerlid:${PW}`))).status === 401);
reset();

/* ---- self-authenticating paths ---- */
ok('/api/ai/* bypasses the shared password', mw(req('/api/ai/manifest')) === undefined);
ok('/api/ai/ bypass is anchored to the path start',
   mw(req('/sneaky/api/ai/manifest')).status === 401);
ok('a lookalike prefix does not bypass', mw(req('/api/aixx')).status === 401);

/* ---- the 401 is machine-readable ---- */
const r401 = mw(req('/'));
ok('401 sends a Basic challenge so browsers prompt',
   /^Basic realm=/.test(r401.headers.get('WWW-Authenticate')));
ok('401 points agents at the manifest via Link',
   /api\/ai\/manifest/.test(r401.headers.get('Link') || ''));

/* ---- fail closed ---- */
delete process.env.SITE_PASSWORD;
ok('unset SITE_PASSWORD fails CLOSED with 503, never open', mw(req('/')).status === 503);
reset();

/* ---- the deliberate escape hatch ---- */
process.env.SITE_PUBLIC = 'true';
ok('SITE_PUBLIC=true opens the board (documented opt-out)', mw(req('/')) === undefined);
process.env.SITE_PUBLIC = 'TRUE';
ok('SITE_PUBLIC is exact-match, so "TRUE" does NOT open it', mw(req('/')).status === 401);
process.env.SITE_PUBLIC = '1';
ok('SITE_PUBLIC="1" does NOT open it either', mw(req('/')).status === 401);
reset();

process.env = env;
console.log(`\nmiddleware: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
