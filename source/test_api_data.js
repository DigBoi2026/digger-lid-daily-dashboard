/* Integration tests for api/data.js's buildData() — the request path, not the
   parsers (source/test_data_filter.js covers those).
   Run: node source/test_api_data.js   (exit 0 = all pass)

   No network and no credentials: googleapis is stubbed in the module loader, so
   a fake sheets client stands in for the real one. That is enough, because the
   defect this exists to catch threw BEFORE any network call.

   THE DEFECT. buildData was declared `({ diag = false } = {})` while its body
   read `opts.probeTabs`. There is no `opts` in that scope, so every single
   request died on a ReferenceError and /api/data answered
   {"error":"opts is not defined"}. Nothing about that was loud: each page falls
   back to its embedded snapshot and keeps drawing, so the board went silently
   stale rather than visibly broken — the same failure mode that once left it
   sitting 69 days behind the sheet. A route that only ever runs against the
   real Google API is a route nothing tests; this file makes the request path
   run offline, on every `npm test`. */
const Module = require('module');

let TABS = ["Jun '26", "Jul '26", "Aug '26", "Sep '26", '2026 Monthly Totals', 'Sheet11', 'Drivers (Online Only)'];
let LAST_RANGES = null;

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'googleapis') {
    return { google: {
      auth: { JWT: function () {} },
      sheets: () => ({ spreadsheets: {
        get: async () => ({ data: { sheets: TABS.map(t => ({ properties: { title: t } })) } }),
        values: { batchGet: async ({ ranges }) => {
          LAST_RANGES = ranges;
          return { data: { valueRanges: ranges.map(() => ({ values: [[]] })) } };
        } },
      } }),
    } };
  }
  return origLoad.apply(this, arguments);
};

process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nstub\\n-----END PRIVATE KEY-----';
const D = require('../api/data.js');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}

(async () => {
  /* Every shape the route can call it with must complete. The bug reproduced on
     ALL of them, including the plain no-argument call — the default parameter
     said nothing about `opts`, so even `buildData()` threw. */
  for (const args of [undefined, {}, { diag: false }, { diag: true },
                      { diag: true, probeTabs: [] },
                      { diag: true, probeTabs: ['Sheet11'] }]) {
    let err = null;
    try { await D.buildData(args); } catch (e) { err = e; }
    ok('buildData(' + JSON.stringify(args) + ') does not throw',
       !err, err && err.constructor.name + ': ' + err.message);
    ok('buildData(' + JSON.stringify(args) + ') is not a scope error',
       !(err instanceof ReferenceError), err && err.message);
  }

  /* probeTabs must actually reach the batchGet, or the ?tabs= diagnostic is
     wired to nothing — which is how the bug got in. */
  await D.buildData({ diag: true, probeTabs: ['Sheet11'] });
  ok('probeTabs adds the named tab to the ranges read',
     LAST_RANGES.some(r => r.indexOf('Sheet11') !== -1), LAST_RANGES);

  await D.buildData({ diag: true });
  ok('without probeTabs no extra tab is read',
     !LAST_RANGES.some(r => r.indexOf('Sheet11') !== -1), LAST_RANGES);

  /* A tab that does not exist must be dropped, not passed through: batchGet
     rejects the WHOLE request if any range names a missing tab, so one typo in
     ?tabs= would 500 the route for everybody. */
  await D.buildData({ diag: true, probeTabs: ['No Such Tab', 'Sheet11'] });
  ok('a probe for a missing tab is dropped rather than sent',
     !LAST_RANGES.some(r => r.indexOf('No Such Tab') !== -1) &&
     LAST_RANGES.some(r => r.indexOf('Sheet11') !== -1), LAST_RANGES);

  /* Tab names carry an apostrophe ("Jun '26"); A1 notation needs it doubled. */
  ok('month tab names are A1-quoted with the apostrophe doubled',
     LAST_RANGES.some(r => /^'[A-Z][a-z]{2} ''26'!/.test(r)), LAST_RANGES.slice(0, 3));

  /* The route reports which tabs it could not find rather than failing, and
     under ?diag=1 lists everything the workbook holds. */
  const diag = await D.buildData({ diag: true });
  ok('diag lists every tab in the workbook',
     diag.diag && Array.isArray(diag.diag.allTabs) && diag.diag.allTabs.length === TABS.length,
     diag.diag && diag.diag.allTabs);

  /* And when not one month tab is present, it must say so plainly instead of
     returning an empty board that looks like a quiet trading week. */
  const saved = TABS;
  TABS = ['Drivers (Online Only)'];
  let msg = null;
  try { await D.buildData(); } catch (e) { msg = e.message; }
  TABS = saved;
  ok('no month tabs is a clear error, not an empty payload',
     msg && /no month tabs found/i.test(msg), msg);

  console.log(`api/data buildData: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
