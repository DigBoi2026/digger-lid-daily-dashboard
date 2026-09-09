/* =========================================================================
   Access control and field policy for the AI read subsystem.

   Pure functions, no I/O and no Node built-ins, so the Edge middleware and the
   Node serverless routes can both use this file unchanged.

   Tokens live in the AI_TOKENS environment variable as a JSON array:

     [{"name":"media-buyer","token":"sk_dl_…","scopes":["pnl.topline","pulse"]},
      {"name":"cfo-agent",  "token":"sk_dl_…","scopes":["pnl.full","products","region"]}]

   One entry per consumer, so a single agent can be revoked without disturbing
   the others. Every scope is read-only; there is no write path in this app.
   ========================================================================= */

// Cost structure and profitability. Deliberately excluded from pnl.topline:
// an agent doing media buying has no business reading salaries.
const SENSITIVE_FIELDS = [
  'prodCost', 'shipCost', 'pickPack', 'packaging', 'txnFees', 'merchFees',
  'totalVC', 'vcr', 'salaries', 'software', 'office', 'totalFC', 'fcr',
  'returns', 'returnsPct', 'totalExp', 'profit', 'profitPct',
  'fcRev', 'projSpend', 'fcProfit', 'gstPct', 'revExGst',
];

const SCOPES = {
  'pnl.full':    { dataset: 'pnl',      label: 'Full P&L including cost structure, salaries and profit' },
  'pnl.topline': { dataset: 'pnl',      label: 'Trading and marketing metrics only — no costs, salaries or profit' },
  'products':    { dataset: 'products', label: 'Shopify product and category sales' },
  'region':      { dataset: 'region',   label: 'Shopify sales by country and region' },
  'pulse':       { dataset: 'pulse',    label: 'PostHog site signals' },
};

function parseTokens(raw) {
  if (!raw || !String(raw).trim()) return [];
  let list;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list
    .filter(e => e && typeof e.token === 'string' && e.token.length >= 16)
    .map(e => ({
      name: String(e.name || 'unnamed'),
      token: e.token,
      scopes: Array.isArray(e.scopes) ? e.scopes.filter(s => s in SCOPES) : [],
    }));
}

// Constant-time-ish compare, so a wrong token cannot be narrowed by timing.
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerFrom(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || '').trim());
  return m ? m[1] : null;
}

/* Identify the caller from an Authorization header. Returns the consumer entry
   (without its token) or null. */
function identify(header, rawTokens) {
  const presented = bearerFrom(header);
  if (!presented) return null;
  for (const entry of parseTokens(rawTokens)) {
    if (sameToken(entry.token, presented)) return { name: entry.name, scopes: entry.scopes };
  }
  return null;
}

const datasetsFor = scopes => [...new Set((scopes || []).map(s => SCOPES[s] && SCOPES[s].dataset).filter(Boolean))];
const canRead = (scopes, dataset) => datasetsFor(scopes).includes(dataset);

/* Which P&L fields may this caller see? pnl.full wins over pnl.topline when a
   token carries both. Returns null to mean "no restriction". */
function pnlFilter(scopes) {
  if (!scopes) return { denied: true };
  if (scopes.includes('pnl.full')) return { denied: false, drop: [] };
  if (scopes.includes('pnl.topline')) return { denied: false, drop: SENSITIVE_FIELDS.slice() };
  return { denied: true };
}

function applyFilter(rows, drop) {
  if (!drop || !drop.length) return rows;
  const dropSet = new Set(drop);
  return rows.map(r => {
    const out = {};
    for (const k in r) if (!dropSet.has(k)) out[k] = r[k];
    return out;
  });
}

/* Why is AI_TOKENS not usable? The guard previously answered "unset or holds no
   valid entries", which cannot be acted on: a missing variable, malformed JSON,
   a token below the length floor and an unrecognised scope all looked identical.
   Reports structure only — never the value. */
function diagnose(raw) {
  if (raw === undefined || raw === null || !String(raw).trim()) {
    return { ok: false, reason: 'AI_TOKENS is not set on this deployment.' };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    return {
      ok: false,
      reason: 'AI_TOKENS is set but is not valid JSON.',
      hint: 'Expected a JSON array. Build it in a file and pipe it in: '
          + "tr -d '\\n' < ai.json | vercel env add AI_TOKENS production",
      parse_error: String((e && e.message) || e).slice(0, 120),
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: `AI_TOKENS parsed as ${typeof parsed}, not an array.` };
  }
  if (!parsed.length) return { ok: false, reason: 'AI_TOKENS is an empty array.' };

  const shortTokens = parsed.filter(e => !e || typeof e.token !== 'string' || e.token.length < 16).length;
  const kept = parseTokens(raw);
  if (!kept.length) {
    return {
      ok: false,
      reason: `AI_TOKENS has ${parsed.length} entr${parsed.length === 1 ? 'y' : 'ies'}, none usable.`,
      entries_rejected_for_short_or_missing_token: shortTokens,
      hint: 'Each entry needs {"name","token","scopes"} with a token of at least 16 characters.',
      valid_scopes: Object.keys(SCOPES),
    };
  }
  const noScopes = kept.filter(e => !e.scopes.length).map(e => e.name);
  return {
    ok: true,
    entries: kept.length,
    entries_with_no_valid_scopes: noScopes,
    valid_scopes: Object.keys(SCOPES),
  };
}

module.exports = {
  SCOPES, SENSITIVE_FIELDS, diagnose,
  parseTokens, bearerFrom, identify, sameToken,
  datasetsFor, canRead, pnlFilter, applyFilter,
};
