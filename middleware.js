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

export default function middleware(req) {
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

  return new Response('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="DiggerLid Dashboard", charset="UTF-8"' },
  });
}
