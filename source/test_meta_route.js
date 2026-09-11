/* Unit tests for api/meta.js — the Meta Marketing API route. Stubbed fetch. */
const path = require('path');
let pass = 0, fail = 0;
const ok = (n, c, g) => { if (c) pass++; else { fail++; console.log(`  ✗ ${n}` + (g !== undefined ? `  (got ${JSON.stringify(g)})` : '')); } };
(async () => {
  delete process.env.META_ACCESS_TOKEN; delete process.env.META_AD_ACCOUNT_ID;
  const R = require('../api/meta.js');
  const off = await R.buildMeta(new Date('2026-09-11T00:00:00Z'));
  ok('unconfigured: says so, no rows, no throw', off.configured === false && off.rows.length === 0 && /META_ACCESS_TOKEN/.test(off.meta.note), off);

  process.env.META_ACCESS_TOKEN = 'EAAtest'; process.env.META_AD_ACCOUNT_ID = '123456';
  const URLS = [];
  global.fetch = async (url) => {
    URLS.push(url);
    /* Only the slice that holds 9–10 Sep has rows; the earlier slices are empty. */
    const rng = JSON.parse(decodeURIComponent(url.match(/time_range=([^&]+)/)[1]));
    if (rng.until < '2026-09-09') return { ok: true, status: 200, json: async () => ({ data: [], paging: {} }) };
    const page2 = /after=abc/.test(url);
    const data = page2
      ? [{ date_start: '2026-09-10', date_stop: '2026-09-10', campaign_name: 'RT — Covers DPA', adset_name: 'viewed 14d', spend: '50', impressions: '4000', actions: [{ action_type: 'landing_page_view', value: '40' }, { action_type: 'omni_add_to_cart', value: '6' }, { action_type: 'omni_purchase', value: '2' }], action_values: [{ action_type: 'omni_purchase', value: '600' }] }]
      : [{ date_start: '2026-09-09', date_stop: '2026-09-09', campaign_name: 'Prospecting — Pro Mat', adset_name: 'Broad AU', spend: '300', impressions: '20000', actions: [{ action_type: 'landing_page_view', value: '200' }, { action_type: 'add_to_cart', value: '12' }, { action_type: 'purchase', value: '3' }], action_values: [{ action_type: 'purchase', value: '750' }] },
         { date_start: '2026-09-09', date_stop: '2026-09-09', campaign_name: 'Campaign 7', adset_name: 'test', spend: '10', impressions: '900', actions: [], action_values: [] }];
    return { ok: true, status: 200, json: async () => ({ data, paging: page2 ? {} : { next: url + '&after=abc' } }) };
  };
  const on = await R.buildMeta(new Date('2026-09-11T00:00:00Z'));
  ok('configured: account carries the act_ prefix', /act_123456\/insights/.test(URLS[0]), URLS[0]);
  ok('configured: level=adset, daily, with names, spend, actions and values', /level=adset/.test(URLS[0]) && /time_increment=1/.test(URLS[0]) && /campaign_name,adset_name,spend,impressions,actions,action_values/.test(URLS[0]));
  const ranges = URLS.filter(u => !/after=/.test(u)).map(u => JSON.parse(decodeURIComponent(u.match(/time_range=([^&]+)/)[1])));
  ok('configured: window is ~100 days through yesterday, in 20-day slices', ranges[0].since === '2026-06-03' && ranges[ranges.length - 1].until === '2026-09-10' && ranges.length === 5, ranges);
  ok('configured: slices are contiguous', ranges.every((r, i) => i === 0 || r.since > ranges[i - 1].until), ranges);
  ok('configured: asks only for the action types the page reads', /action_type/.test(decodeURIComponent(URLS[0])) && /omni_purchase/.test(decodeURIComponent(URLS[0])) && /landing_page_view/.test(decodeURIComponent(URLS[0])));
  ok('configured: follows paging within a slice', URLS.filter(u => /after=abc/.test(u)).length === 1 && on.rows.length === 3, [URLS.length, on.rows.length]);
  const pm = on.rows.find(r => r.line === 'Pro Mats');
  ok('rows are mapped to line × tier', pm && pm.tier === 'Prospecting' && pm.spend === 300 && pm.purchases === 3 && pm.revenue === 750 && pm.atc === 12, pm);
  ok('retargeting ad set mapped', on.rows.some(r => r.line === 'Excavator Covers' && r.tier === 'Retargeting'));
  ok('an unrecognised name is kept as Multi/Broad and listed', on.rows.some(r => r.line === 'Multi/Broad' && !r.mapped) && on.unmapped.includes('Campaign 7 · test'), on.unmapped);
  ok('meta states the through date and the mapping caveat', on.meta.until === '2026-09-10' && /unmapped/.test(on.meta.note));

  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) });
  let threw = null; try { await R.buildMeta(new Date()); } catch (e) { threw = e.message; }
  ok('an API error surfaces as an error, not an empty success', /Invalid OAuth/.test(threw || ''), threw);
  console.log(`meta route: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
