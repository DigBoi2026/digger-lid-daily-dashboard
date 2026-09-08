/* =========================================================================
   /api/pulse  —  Vercel Serverless Function (Node).
   Live PostHog site signals via the Query API (HogQL). Returns the same
   window.DL_PULSE shape the Daily Pulse page uses, through YESTERDAY (full days
   only). Read-only.

   Required environment variables (Vercel → Settings → Environment Variables):
     POSTHOG_API_KEY     personal API key `phx_…` with read scopes (query:read)
     POSTHOG_PROJECT_ID  (optional) defaults to 475333
     POSTHOG_HOST        (optional) defaults to https://us.posthog.com
   Both HogQL queries below are validated against the live project.
   ========================================================================= */

const HOST = (process.env.POSTHOG_HOST || 'https://us.posthog.com').replace(/\/$/, '');
const PID  = process.env.POSTHOG_PROJECT_ID || '475333';

// 62 full days ending yesterday (exclude today's partial day).
const WINDOW = "timestamp >= toStartOfDay(now()) - INTERVAL 62 DAY AND timestamp < toStartOfDay(now())";
const Q_DAILY = `
SELECT toString(toDate(timestamp)) AS d,
  uniqIf($session_id, event = '$pageview')   AS sessions,
  countIf(event = '$pageview')               AS pageviews,
  countIf(event = 'Product Added')           AS atc,
  countIf(event = 'Checkout Started')        AS checkoutStarted,
  countIf(event = 'Order Completed')         AS orders,
  countIf(event = '$exception')              AS errors,
  countIf(event = '$rageclick')              AS rageclicks,
  countIf(event = '$dead_click')             AS deadclicks
FROM events WHERE ${WINDOW}
GROUP BY d ORDER BY d`;
const NAMED_CHANNELS = ['Organic Social', 'Direct', 'Paid Social', 'Organic Search', 'Referral', 'Email'];
// Filter to the named channels (keeps the row count well under the query API's cap so recent
// days aren't truncated) — "Other" is derived from total sessions in the handler.
const Q_CHAN = `
SELECT toString(toDate(timestamp)) AS d, session.$channel_type AS ch, uniq($session_id) AS s
FROM events WHERE event = '$pageview' AND ${WINDOW}
  AND session.$channel_type IN (${NAMED_CHANNELS.map(c => `'${c}'`).join(', ')})
GROUP BY d, ch ORDER BY d LIMIT 2000`;

async function hogql(query) {
  const key = process.env.POSTHOG_API_KEY;
  if (!key) throw new Error('Missing POSTHOG_API_KEY');
  const r = await fetch(`${HOST}/api/projects/${PID}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (r.status === 401 || r.status === 403) throw new Error(`HTTP ${r.status} — PostHog key rejected (needs query:read scope).`);
  if (!r.ok) throw new Error(`PostHog HTTP ${r.status}`);
  const j = await r.json();
  if (j.error || j.detail) throw new Error('PostHog: ' + String(j.error || j.detail).slice(0, 200));
  return j.results || [];
}

module.exports = async (req, res) => {
  try {
    const [daily, chan] = await Promise.all([hogql(Q_DAILY), hogql(Q_CHAN)]);
    const days = daily.map(r => r[0]);
    const idx = Object.fromEntries(days.map((d, i) => [d, i]));
    const col = (rows, k) => rows.map(r => +r[k] || 0);
    const series = {
      sessions: col(daily, 1), pageviews: col(daily, 2), atc: col(daily, 3),
      checkoutStarted: col(daily, 4), orders: col(daily, 5), errors: col(daily, 6),
      rageclicks: col(daily, 7), deadclicks: col(daily, 8),
    };
    // pivot named channels → { name: [per-day] }; derive "Other" from total sessions
    const channels = {}; NAMED_CHANNELS.forEach(c => channels[c] = Array(days.length).fill(0));
    chan.forEach(([d, ch, s]) => { const i = idx[d]; if (i != null && channels[ch]) channels[ch][i] += (+s || 0); });
    channels['Other'] = series.sessions.map((tot, i) =>
      Math.max(0, tot - NAMED_CHANNELS.reduce((a, c) => a + channels[c][i], 0)));
    if (channels['Other'].every(v => v === 0)) delete channels['Other'];

    const payload = {
      meta: { source: 'PostHog · web analytics', asOf: days[days.length - 1] || null,
        trackedFrom: days[0] || null, live: true,
        note: 'Live daily site signals through yesterday (full days).' },
      days, series, channels,
    };
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify(payload));
  } catch (err) {
    res.status(500).json({ error: String((err && err.message) || err) });
  }
};
