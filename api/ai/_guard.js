/* Shared bearer-token guard for the /api/ai/* routes. Underscore-prefixed so
   Vercel does not expose it as an endpoint. */
const A = require('../../lib/ai-access.js');

function guard(req, res) {
  const raw = process.env.AI_TOKENS;
  if (!raw || !A.parseTokens(raw).length) {
    res.status(503).json({
      error: 'ai_subsystem_not_configured',
      detail: 'AI_TOKENS is unset or holds no valid entries. See /api/ai/llms for the format.',
    });
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
