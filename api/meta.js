/* =========================================================================
   /api/meta  —  Vercel Serverless Function (Node).
   Daily Meta Ads insights by ad set for the last ~100 days, mapped to the
   framework's product line × audience tier by campaign/ad-set name. Feeds the
   Meta Ads page; the page falls back to the committed 90-day snapshot when
   this route says it is not configured.

   Required environment variables (Vercel → Settings → Environment Variables):
     META_ACCESS_TOKEN     system-user or long-lived token with ads_read
     META_AD_ACCOUNT_ID    the ad account, with or without the act_ prefix
     META_API_VERSION      (optional) defaults to v21.0

   Read-only. One paged call to /insights at level=adset, time_increment=1,
   so any window and any comparison is a sum over the rows on the client. */
const M = require('../lib/meta_bench.js');

const VERSION = process.env.META_API_VERSION || 'v21.0';
const DAYS = 100;
const iso = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; };

function configured() {
  return !!(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID);
}
function account() {
  const id = String(process.env.META_AD_ACCOUNT_ID || '').trim();
  return id.startsWith('act_') ? id : 'act_' + id;
}

/* The action types the page reads, and nothing else. Without this filter Meta
   returns every action type it tracks for every ad set for every day — page
   views, video plays, link clicks — and the response was large enough that
   100 days at ad-set level took the function past its 30-second limit. */
const ACTION_TYPES = ['landing_page_view', 'omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart',
                      'omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'];
const CHUNK_DAYS = 20;

async function fetchRange(since, until) {
  const fields = 'campaign_name,adset_name,spend,impressions,actions,action_values';
  const filtering = JSON.stringify([{ field: 'action_type', operator: 'IN', value: ACTION_TYPES }]);
  let url = `https://graph.facebook.com/${VERSION}/${account()}/insights?level=adset&time_increment=1&limit=500` +
            `&fields=${fields}&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
            `&filtering=${encodeURIComponent(filtering)}` +
            `&access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
  const out = [];
  for (let page = 0; url && page < 40; page++) {
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok || j.error) throw new Error('Meta: ' + ((j.error && j.error.message) || ('HTTP ' + r.status)));
    (j.data || []).forEach(row => out.push(row));
    url = j.paging && j.paging.next ? j.paging.next : null;
  }
  return out;
}

/* The window in 20-day slices fetched together. Meta pages one call
   sequentially, so a 100-day read was five round trips in a row; five slices
   in parallel is one. */
async function fetchInsights(since, until) {
  const slices = [];
  for (let a = new Date(since + 'T00:00:00Z'); iso(a) <= until; a = addDays(a, CHUNK_DAYS)) {
    const z = addDays(a, CHUNK_DAYS - 1);
    slices.push([iso(a), iso(z) > until ? until : iso(z)]);
  }
  const parts = await Promise.all(slices.map(([a, z]) => fetchRange(a, z)));
  return parts.flat();
}

/* Shared with the AI read subsystem, and unit-tested with a stubbed fetch. */
async function buildMeta(today) {
  today = today || new Date();
  const until = iso(addDays(today, -1));                // through yesterday: today is still spending
  const since = iso(addDays(today, -DAYS));
  if (!configured()) {
    return { configured: false, meta: { source: 'Meta Marketing API', note: 'META_ACCESS_TOKEN / META_AD_ACCOUNT_ID not set — the page shows the committed 90-day snapshot.' }, rows: [] };
  }
  const t0 = Date.now();
  const raw = await fetchInsights(since, until);
  const rows = raw.map(M.fromInsight);
  /* Ad sets whose names matched no product line are kept (as Multi/Broad) and
     listed, so a naming gap is visible on the page rather than silently
     folded into the blend. */
  const unmapped = [...new Set(rows.filter(r => !r.mapped).map(r => [r.campaign, r.adset].filter(Boolean).join(' · ')))].slice(0, 40);
  return {
    configured: true,
    meta: { source: 'Meta Marketing API · insights, level=adset, daily', account: account(), since, until, currency: 'AUD',
            rows: rows.length, unmapped: unmapped.length, ms: Date.now() - t0,
            note: 'Purchases and revenue are Meta-attributed (omni_purchase). Names are mapped to line × tier by keyword; unmapped ad sets are listed.' },
    rows, unmapped,
  };
}

/* When Meta refuses, say what the token CAN see. "(#200) Ad account owner has
   NOT grant ads_read" is one message for three different mistakes — the scope
   was not ticked, the system user was never assigned the account, or the
   account id is another number entirely — and the fix is different for each.
   Two cheap reads settle it. The token itself is never returned. */
async function diagnose() {
  const tok = encodeURIComponent(process.env.META_ACCESS_TOKEN);
  const get = async path => {
    try { const r = await fetch(`https://graph.facebook.com/${VERSION}/${path}&access_token=${tok}`); return await r.json(); }
    catch (e) { return { error: { message: String(e.message || e) } }; }
  };
  const perms = await get('me/permissions?limit=100');
  const accts = await get('me/adaccounts?fields=account_id,name&limit=50');
  const granted = (perms.data || []).filter(p => p.status === 'granted').map(p => p.permission);
  const visible = (accts.data || []).map(a => `${a.account_id} (${a.name})`);
  return {
    account: account(),
    tokenScopes: perms.error ? 'unreadable: ' + perms.error.message : granted,
    accountsTokenCanSee: accts.error ? 'unreadable: ' + accts.error.message : visible,
    hint: !granted.includes('ads_read') && !granted.includes('ads_management') && !perms.error
      ? 'The token has no ads_read scope: regenerate it with ads_read ticked.'
      : accts.data && !accts.data.some(a => 'act_' + a.account_id === account())
        ? 'The token cannot see ' + account() + ': assign that ad account to the system user (Business Settings → System users → Assign assets → Ad accounts), or check META_AD_ACCOUNT_ID.'
        : 'Scopes and account both look right — the app may need the Marketing API product added (App dashboard → Add product).',
  };
}

module.exports = async (req, res) => {
  try {
    const payload = await buildMeta(new Date());
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify(payload));
  } catch (err) {
    const body = { error: String((err && err.message) || err) };
    if (configured()) { try { body.diagnostic = await diagnose(); } catch (e) { /* the error above is the answer */ } }
    res.status(500).json(body);
  }
};
module.exports.buildMeta = buildMeta;
module.exports._configured = configured;
