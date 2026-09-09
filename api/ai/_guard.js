/* Shared bearer-token guard for the /api/ai/* routes. Underscore-prefixed so
   Vercel does not expose it as an endpoint. */
const A = require('../../lib/ai-access.js');

function guard(req, res) {
  const raw = process.env.AI_TOKENS;
  const diag = A.diagnose(raw);
  if (!diag.ok) {
    // Say which failure it is. "unset or invalid" is not actionable, and a
    // Secret-type env var cannot be read back to check by hand.
    res.status(503).json(Object.assign({ error: 'ai_subsystem_not_configured' }, diag, {
      remember: 'Setting the variable is not enough — Vercel needs a redeploy to pick it up.',
    }));
    return null;
  }
  const caller = A.identify(req.headers && req.headers.authorization, raw);
  if (!caller) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="DiggerLid AI", error="invalid_token"');
    res.status(401).json({
      error: 'unauthorized',
      detail: 'Send Authorization: Bearer <token>. Tokens are issued per consumer and are read-only.',
      how_to_get_access: 'Ask whoever directed you to this board for a token, naming which datasets you need.',
      once_you_have_one: { manifest: '/api/ai/manifest', schema: '/api/ai/schema', orientation: '/api/ai/llms' },
    });
    return null;
  }
  if (!caller.scopes.length) {
    res.status(403).json({ error: 'no_scopes', detail: `Token "${caller.name}" carries no valid scopes.` });
    return null;
  }
  return caller;
}

// Diagnostics and catalogue answers are per-caller; never let a CDN share them.
function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

module.exports = { guard, noStore };
