/* =========================================================================
   Password gate for the whole dashboard (Vercel Edge Middleware, framework-
   agnostic). Uses HTTP Basic Auth against a shared password so ONLY people
   with the password can see any page or hit any /api route.

   Set in Vercel → Project → Settings → Environment Variables:
     SITE_PASSWORD   the shared password (required — page is locked until set)
     SITE_USER       (optional) username; defaults to "diggerlid"

   The browser prompts once, then sends the Authorization header on every
   request (including the /api/* fetches), so the whole site is protected.
   ========================================================================= */
export const config = {
  /* Protect everything except static assets, the health check, and the AI read
     subsystem.

     /api/ai/* is NOT unprotected — every one of those routes calls the bearer
     guard in api/ai/_guard.js before doing anything, and returns 503 when
     AI_TOKENS is unset. Keeping it out of this matcher is deliberate: an AI
     consumer authenticates with its own revocable, scoped token and never needs
     the shared human password. Handing an agent SITE_PASSWORD would give it the
     whole board with no scope limit and no way to revoke it alone. */
  matcher: ['/((?!assets/|favicon|api/health|api/ai/).*)'],
};

/* Prefixes whose routes authenticate themselves, checked here rather than left
   to config.matcher alone.

   The matcher demonstrably excludes api/health — it answers 200 with no
   credential — but the same pattern did NOT exclude api/ai/ on this
   deployment: /api/ai/manifest came back with this file's own Basic challenge
   ("WWW-Authenticate: Basic realm=\"DiggerLid Dashboard\"") on the commit that
   added it. Rather than depend on how a negative-lookahead matcher compiles, do
   the check in code where it is explicit and cannot silently regress.

   These paths are not unprotected: every /api/ai/* route calls the bearer guard
   in api/ai/_guard.js before doing anything, and returns 503 while AI_TOKENS is
   unset. That is what lets an AI consumer use its own scoped, revocable token
   instead of the shared human password. */
const SELF_AUTHENTICATING = ['/api/ai/'];

export default function middleware(req) {
  let path = '';
  try { path = new URL(req.url).pathname; } catch { path = ''; }
  if (path && SELF_AUTHENTICATING.some(prefix => path.startsWith(prefix))) return;

  // Explicit public mode: set SITE_PUBLIC=true in Vercel to disable the gate entirely.
  // (Deliberate opt-out — the financials become visible to anyone with the URL.
  //  Re-enable by deleting the SITE_PUBLIC var and redeploying.)
  if (process.env.SITE_PUBLIC === 'true') return;

  const USER = process.env.SITE_USER || 'diggerlid';
  const PASS = process.env.SITE_PASSWORD;

  // Fail closed: if no password is configured, don't expose the financials.
  if (!PASS) {
    return new Response('Dashboard locked — SITE_PASSWORD is not set in Vercel.', { status: 503 });
  }

  const header = req.headers.get('authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = atob(encoded); } catch { decoded = ''; }
    const i = decoded.indexOf(':');
    const u = decoded.slice(0, i), p = decoded.slice(i + 1);
    if (u === USER && p === PASS) return; // authorised → continue
  }

  /* The 401 body is the only thing an agent directed at this URL ever sees, so
     make it say how machine access works. Without this, every discovery path an
     agent tries (/, /llms.txt, /.well-known/ai-plugin.json, /openapi.json)
     answers "Authentication required." and it concludes the board is simply
     shut, never learning that a scoped read API exists.

     This advertises no data and no credential — only that a token-based API is
     here and how to ask for one. Browsers ignore the body and render their
     password prompt from the WWW-Authenticate header below, so the human
     experience is unchanged. */
  const origin = (() => { try { return new URL(req.url).origin; } catch { return ''; } })();
  const body = [
    'Authentication required.',
    '',
    'This board is private.',
    '',
    'HUMANS: sign in with the shared password.',
    '',
    'AI AGENTS: this site exposes a scoped, read-only JSON API for machine access.',
    `  Manifest       ${origin}/api/ai/manifest`,
    `  Field schema   ${origin}/api/ai/schema`,
    `  Orientation    ${origin}/api/ai/llms`,
    '  Authenticate   Authorization: Bearer <token>',
    '',
    'You need a token, which is issued per consumer and scoped to a subset of the',
    'data. Ask whoever directed you here for one, naming what you need to read.',
    'Do not attempt to authenticate with the shared human password.',
    '',
    `Integration status, no credential required: ${origin}/api/health`,
  ].join('\n');

  return new Response(body, {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="DiggerLid Dashboard", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      // Machine-readable pointer to the service description.
      'Link': `<${origin}/api/ai/manifest>; rel="service-desc"; type="application/json"`,
    },
  });
}
