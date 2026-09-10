/* Unit tests for api/pulse.js — the PostHog site-signals route.
   Run: node source/test_pulse.js   (exit 0 = all pass)

   No network: fetch is stubbed. The point under test is WHOSE DAY the signals
   are cut on. PostHog stores UTC; the sheet and Shopify close their day on
   Australian Eastern time, and bucketing the site by UTC put its "yesterday"
   ten hours behind theirs. */
process.env.POSTHOG_API_KEY = 'phx_test';
let pass = 0, fail = 0;
const ok = (name, cond, got) => { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); } };

let SENT = [];
global.fetch = async (url, opts) => {
  const q = JSON.parse(opts.body).query.query; SENT.push(q);
  const results = /channel_type/.test(q)
    ? [['2026-09-09', 'Direct', 40], ['2026-09-10', 'Direct', 50], ['2026-09-10', 'Email', 5]]
    : [['2026-09-09', 100, 300, 20, 10, 5, 2, 1, 1], ['2026-09-10', 120, 360, 24, 12, 6, 3, 1, 2]];
  return { ok: true, status: 200, json: async () => ({ results }) };
};
const P = require('../api/pulse.js');

(async () => {
  const { Q_DAILY, Q_CHAN, TZ } = P._queries;
  ok('days are cut on Melbourne time by default', TZ === 'Australia/Melbourne', TZ);
  ok('the daily query buckets by the local day, not UTC', /toDate\(toTimeZone\(timestamp, 'Australia\/Melbourne'\)\)/.test(Q_DAILY), Q_DAILY.slice(0, 120));
  ok('the channel query buckets the same way', /toDate\(toTimeZone\(timestamp, 'Australia\/Melbourne'\)\)/.test(Q_CHAN));
  ok('the window ends at the start of the local today, so today\'s partial day is excluded',
     /timestamp < toStartOfDay\(toTimeZone\(now\(\), 'Australia\/Melbourne'\)\)/.test(Q_DAILY), Q_DAILY);
  ok('and opens 62 local days earlier', /toStartOfDay\(toTimeZone\(now\(\), 'Australia\/Melbourne'\)\) - INTERVAL 62 DAY/.test(Q_DAILY));
  ok('no query still buckets by bare UTC timestamp', !/toDate\(timestamp\)/.test(Q_DAILY + Q_CHAN) && !/toStartOfDay\(now\(\)\)/.test(Q_DAILY + Q_CHAN));

  const out = await P.buildPulse();
  ok('two queries went out', SENT.length === 2, SENT.length);
  ok('days come back in order', out.days.join() === '2026-09-09,2026-09-10', out.days);
  ok('series are numeric per day', out.series.sessions.join() === '100,120' && out.series.orders.join() === '5,6', out.series);
  ok('channels pivot per day with Other derived from total sessions',
     out.channels.Direct.join() === '40,50' && out.channels.Email.join() === '0,5' && out.channels.Other.join() === '60,65', out.channels);
  ok('the payload names its timezone', out.meta.timezone === 'Australia/Melbourne' && /Melbourne/.test(out.meta.note), out.meta);

  console.log(`pulse: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
