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

async function fetchInsights(since, until) {
  const fields = 'campaign_name,adset_name,spend,impressions,actions,action_values';
  let url = `https://graph.facebook.com/${VERSION}/${account()}/insights?level=adset&time_increment=1&limit=500` +
            `&fields=${fields}&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}` +
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

/* Shared with the AI read subsystem, and unit-tested with a stubbed fetch. */
async function buildMeta(today) {
  today = today || new Date();
  const until = iso(addDays(today, -1));                // through yesterday: today is still spending
  const since = iso(addDays(today, -DAYS));
  if (!configured()) {
    return { configured: false, meta: { source: 'Meta Marketing API', note: 'META_ACCESS_TOKEN / META_AD_ACCOUNT_ID not set — the page shows the committed 90-day snapshot.' }, rows: [] };
  }
  const raw = await fetchInsights(since, until);
  const rows = raw.map(M.fromInsight);
  /* Ad sets whose names matched no product line are kept (as Multi/Broad) and
     listed, so a naming gap is visible on the page rather than silently
     folded into the blend. */
  const unmapped = [...new Set(rows.filter(r => !r.mapped).map(r => [r.campaign, r.adset].filter(Boolean).join(' · ')))].slice(0, 40);
  return {
    configured: true,
    meta: { source: 'Meta Marketing API · insights, level=adset, daily', account: account(), since, until, currency: 'AUD',
            rows: rows.length, unmapped: unmapped.length,
            note: 'Purchases and revenue are Meta-attributed (omni_purchase). Names are mapped to line × tier by keyword; unmapped ad sets are listed.' },
    rows, unmapped,
  };
}

module.exports = async (req, res) => {
  try {
    const payload = await buildMeta(new Date());
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify(payload));
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
module.exports.buildMeta = buildMeta;
module.exports._configured = configured;
