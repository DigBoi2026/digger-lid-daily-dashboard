/* Unit tests for api/watchdog.js and .github/scripts/verdict.py — the smoke alarm.
   Run: node source/test_watchdog.js   (exit 0 = all pass)

   No network and no credentials: googleapis is stubbed in the module loader and
   the sheet is a fixture, so every branch of the verdict can be driven.

   WHY THIS FILE MATTERS MORE THAN MOST. A watchdog that is itself broken is
   worse than none: it reports green and buys a false confidence nobody audits.
   /api/health is the cautionary example — it answers 200 with ok:true while
   exercising parseDaily directly and never calling buildData(), so it stayed
   green through the outage that took /api/data down completely. Every assertion
   below exists to stop this route drifting into the same shape. */
const Module = require('module');
const { execFileSync } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}

/* ------------------------------------------------------------- the fixture */

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const iso = d => d.toISOString().slice(0, 10);
const addDays = (base, n) => { const t = new Date(base + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return iso(t); };
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const tabName = (y, m) => MONTH_ABBR[m - 1] + " '" + String(y).slice(2);

let TABS = [];
let GRIDS = {};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'googleapis') {
    return { google: {
      auth: { JWT: function () {} },
      sheets: () => ({ spreadsheets: {
        get: async () => ({ data: { sheets: TABS.map(t => ({ properties: { title: t } })) } }),
        values: { batchGet: async ({ ranges }) => ({ data: { valueRanges: ranges.map(r => {
          const name = /^'(.*?)'!/.exec(r);
          const key = name ? name[1].replace(/''/g, "'") : r;
          return { values: GRIDS[key] || [[]] };
        }) } }) },
      } }),
    } };
  }
  return origLoad.apply(this, arguments);
};

process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'svc@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nstub\\n-----END PRIVATE KEY-----';
delete process.env.ALERT_WEBHOOK_URL;
delete process.env.CRON_SECRET;
delete process.env.AI_TOKENS;

/* One month tab, shaped like the real one: block heading in column A, metric
   labels in column B, one column per DAY OF THAT MONTH from C. A month tab
   never spans two months, and getting that wrong in the first draft of this
   fixture produced dates like 2026-09-31 and a negative data age — the fixture
   failing, dressed up as the route failing.

   `pending` days carry revenue but no ad spend, which is what the sheet looks
   like while somebody is still typing yesterday in. */
function monthGrid(year, month, upToDay, pendingFrom) {
  const rows = [];
  rows[0] = ['', '']; rows[1] = ['TOTAL', ''];
  const put = (r, label, vals) => { rows[r] = rows[r] || []; rows[r][1] = label;
    vals.forEach((v, i) => rows[r][2 + i] = v); };
  const days = [];
  for (let d = 1; d <= upToDay; d++) days.push({ d, pending: pendingFrom != null && d >= pendingFrom });
  days.forEach((o, i) => rows[0][2 + i] = ' ' + o.d + ' ' + MONTH_ABBR[month - 1] + ' ');
  const rev = o => 12000 + o.d * 7;
  put(2, 'TOTAL Revenue', days.map(o => '$' + rev(o)));
  put(3, 'Revenue Ex GST', days.map(o => '$' + (rev(o) * 0.918).toFixed(2)));
  put(4, 'Orders', days.map(() => 40));
  put(5, 'Store Sessions', days.map(() => 3000));
  put(6, 'Total Meta Ad Spend', days.map(o => o.pending ? '' : '$3400'));
  put(7, 'Total Advertising', days.map(o => o.pending ? '' : '$3400'));
  put(8, 'Total Variable Costs', days.map(o => '$' + (rev(o) * 0.45).toFixed(2)));
  put(9, 'Total Fixed Costs', days.map(() => '$2700'));
  put(10, 'PROFIT', days.map(() => '$100'));
  for (let r = 0; r < rows.length; r++) rows[r] = rows[r] || ['', ''];
  return rows;
}

/* Build a whole workbook whose NEWEST data lands exactly on `newestISO`.

   Expressed as a target date rather than as "fill N days", because the route's
   checks are about age and the suite must not start failing on the 1st of a
   month — a watchdog test that cries wolf on its own is the surest way to get
   the watchdog switched off. The route reads the current month plus three back,
   so any recent target works, and the current month tab is present but empty
   when the target is earlier, exactly as the real sheet looks early in a month. */
function setSheet(opts) {
  opts = opts || {};
  const yest = new Date(); yest.setDate(yest.getDate() - 1);
  const newest = opts.newestISO || iso(yest);
  const pendingTail = opts.pendingTail || 0;
  const nY = +newest.slice(0, 4), nM = +newest.slice(5, 7), nD = +newest.slice(8, 10);

  TABS = []; GRIDS = {};
  const cur = new Date(); cur.setDate(cur.getDate() - 1);
  for (let back = 3; back >= 0; back--) {
    const t = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - back, 1));
    const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1;
    const name = tabName(y, m);
    TABS.push(name);
    let upTo = 0;
    if (opts.allEmpty) upTo = 0;                          // every tab present, nothing typed
    else if (y === nY && m === nM) upTo = opts.empty ? 0 : nD;
    else if (y < nY || (y === nY && m < nM)) upTo = daysInMonth(y, m);
    GRIDS[name] = monthGrid(y, m, upTo, upTo && pendingTail ? upTo - pendingTail + 1 : null);
  }
  const monthly = String(cur.getUTCFullYear()) + ' Monthly Totals';
  TABS.push(monthly); GRIDS[monthly] = [[]];
  return { newest };
}

const W = require('../api/watchdog.js');

function call(opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const res = { statusCode: null, headers: {}, body: null,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      send(b) { this.body = b; resolve(this); },
      json(o) { this.body = JSON.stringify(o); resolve(this); } };
    W({ query: opts.query || {}, headers: Object.assign({ host: 'example.test' }, opts.headers || {}) }, res);
  });
}
const parse = r => { try { return JSON.parse(r.body); } catch (e) { return null; } };

/* ------------------------------------------------------------ the happy path */

(async () => {
  setSheet();                                    // filled to yesterday
  let r = await call();
  let v = parse(r);
  ok('a healthy board answers 200', r.statusCode === 200, r.statusCode);
  ok('and says so', v && v.ok === true, v && v.failures);
  ok('no failures listed', v && v.failures.length === 0, v && v.failures);

  /* THE CHECK /api/health DOES NOT MAKE. */
  ok('it runs buildData, the function the pages actually use',
     v && v.checks.dataRoute.ran === true, v && v.checks.dataRoute);
  ok('it reports how many rows came back', v && v.checks.dataRoute.rows > 0, v && v.checks.dataRoute.rows);
  ok('it reports the age of the newest data', v && v.checks.dataRoute.ageDays != null,
     v && v.checks.dataRoute.ageDays);
  ok('it says what it does NOT cover, rather than implying it covers everything',
     v && v.checks.notCoveredHere && /health/.test(v.checks.notCoveredHere.integrationReachability),
     v && v.checks.notCoveredHere);
  ok('the forecast layer is exercised too', v && v.checks.forecast.ran === true, v && v.checks.forecast);
  /* prior_year.js is read with fs, which Vercel's bundler cannot trace, so its
     presence in the deployed function is a real thing that can silently break —
     and without 2025 the forecast keeps running with no seasonality and no
     year-on-year rate, which is a different model wearing the same name. */
  ok('it confirms the prior year actually reached the function',
     v && /rows$/.test(v.checks.forecast.priorYear || ''), v && v.checks.forecast.priorYear);
  ok('thresholds are stated, not hidden', v && v.thresholds.maxAgeDays > 0, v && v.thresholds);

  /* ------------------------------------------------------- 1. a broken route */
  /* The defect this exists for: buildData throwing. A workbook with no month
     tab makes it throw exactly as a real fault would. */
  TABS = ['Drivers (Online Only)'];
  r = await call(); v = parse(r);
  ok('a broken data path answers 503, not 200', r.statusCode === 503, r.statusCode);
  ok('and names it', v && v.failures.some(f => /\/api\/data is broken/.test(f)), v && v.failures);
  ok('the error string is carried, not swallowed',
     v && v.checks.dataRoute.error && v.checks.dataRoute.error.length > 0, v && v.checks.dataRoute);
  ok('a broken data path does not also claim a working forecast',
     v && v.checks.forecast.ran === false, v && v.checks.forecast);

  /* ------------------------------------------------------ 2. stale but valid */
  /* The 69-day failure. Rows, no error, everything parses — and the data is
     weeks old. Nothing else in this codebase objects to this. */
  setSheet({ newestISO: addDays(iso(new Date()), -9) });
  r = await call(); v = parse(r);
  ok('stale-but-valid data fails, which is the whole point', r.statusCode === 503, r.statusCode);
  ok('and the failure says how old it is',
     v && v.failures.some(f => /days old/.test(f)), v && v.failures);
  ok('the age is measured, not guessed', v && v.checks.dataRoute.ageDays >= 9,
     v && v.checks.dataRoute.ageDays);
  ok('a stale board still reports its rows as present, not as an error',
     v && v.checks.dataRoute.ran === true && v.checks.dataRoute.rows > 0, v && v.checks.dataRoute);

  /* Just inside the limit must pass, or the alarm cries wolf every morning
     before the sheet is filled in. */
  setSheet({ newestISO: addDays(iso(new Date()), -1) });
  r = await call();
  ok('yesterday is not stale', r.statusCode === 200, [r.statusCode, parse(r) && parse(r).failures]);

  /* --------------------------------------------------- 3. the pending tail */
  /* A sheet nobody is filling in looks exactly like a current one, minus the ad
     spend. Two days is ordinary; a week is somebody on holiday. */
  setSheet({ pendingTail: 1 });
  r = await call();
  ok('one pending day is normal and does not alarm', r.statusCode === 200,
     [r.statusCode, parse(r) && parse(r).failures]);
  ok('but it is still reported', parse(r) && parse(r).checks.pendingTail.days === 1,
     parse(r) && parse(r).checks.pendingTail);

  setSheet({ pendingTail: 6 });
  r = await call(); v = parse(r);
  ok('a pile-up of unfilled days fails', r.statusCode === 503, r.statusCode);
  ok('and says how many and from when',
     v && v.failures.some(f => /trailing days still unfilled/.test(f)), v && v.failures);
  ok('and which figures are missing',
     v && v.checks.pendingTail.groups.indexOf('adSpend') !== -1, v && v.checks.pendingTail);
  ok('and lists the dates', v && v.checks.pendingTail.dates.length === v.checks.pendingTail.days,
     v && v.checks.pendingTail);

  /* ---------------------------------------------------------- 4. no rows */
  /* A workbook whose tabs all exist and none of which has been typed into. The
     route must not read that as a very quiet trading month. */
  setSheet({ allEmpty: true });
  r = await call(); v = parse(r);
  ok('a workbook with nothing in it fails', r.statusCode === 503, r.statusCode);
  ok('and is described as empty, not merely stale',
     v && v.failures.some(f => /0 daily rows|is broken/.test(f)), v && v.failures);
  ok('and does not invent an age for data that is not there',
     v && v.checks.dataRoute.ageDays === null, v && v.checks.dataRoute);

  /* An empty CURRENT month with filled months behind it is a different thing —
     it is the 1st of the month, or a sheet nobody has started. Either way it is
     stale rather than empty, and must be reported as such. */
  setSheet({ empty: true, newestISO: iso(new Date()) });
  v = parse(await call());
  ok('an unstarted current month reads as stale, with the real newest date',
     v.failures.some(f => /days old/.test(f)) && v.checks.dataRoute.rows > 0,
     [v.failures, v.checks.dataRoute.rows]);

  /* --------------------------------------------------- figures are withheld */
  setSheet();
  r = await call(); v = parse(r);
  ok('without a token the forecast figures are withheld',
     typeof v.forecastLog === 'string' && /withheld/.test(v.forecastLog), v.forecastLog);
  ok('and the unauthenticated body carries no dollar figures at all',
     !/"revenue_realistic"|"profit_realistic"|"level_per_day"/.test(r.body));

  process.env.CRON_SECRET = 'sekret';
  r = await call({ headers: { authorization: 'Bearer sekret' } }); v = parse(r);
  ok('with the cron secret the log row is returned',
     v.forecastLog && typeof v.forecastLog === 'object', v.forecastLog);
  ok('a wrong token is refused the figures',
     typeof (parse(await call({ headers: { authorization: 'Bearer nope' } }))).forecastLog === 'string');

  /* ------------------------------------------------------- the log row */
  const row = v.forecastLog;
  ok('the log row records WHEN it was logged', !!row.logged_on, row.logged_on);
  ok('and what the data was at the time', !!row.data_through, row.data_through);
  ok('and the origin it forecast from', !!row.forecast_from, row.forecast_from);
  ok('all three scenarios', row.revenue_pessimistic > 0 && row.revenue_realistic > 0 &&
     row.revenue_optimistic > 0, row);
  ok('ordered pessimistic <= realistic <= optimistic',
     row.revenue_pessimistic <= row.revenue_realistic &&
     row.revenue_realistic <= row.revenue_optimistic,
     [row.revenue_pessimistic, row.revenue_realistic, row.revenue_optimistic]);
  ok('the model basis, so a past forecast can be explained later',
     row.level_per_day > 0 && row.drift_per_28d > 0, row);
  ok('the row is FLAT — it appends to a sheet without reshaping',
     Object.values(row).every(x => x === null || typeof x !== 'object'), row);
  /* Anchored on the last COMPLETE day, never a half-filled one: logging the
     fiction would poison the very record kept to check the model. */
  setSheet({ pendingTail: 2 });
  const pv = parse(await call({ headers: { authorization: 'Bearer sekret' } }));
  ok('the forecast origin skips pending days',
     pv.forecastLog.forecast_from < pv.checks.dataRoute.latestDataDate,
     [pv.forecastLog.forecast_from, pv.checks.dataRoute.latestDataDate]);

  /* CSV, so a sheet-append automation needs no glue code. */
  setSheet();
  const csv = await call({ query: { format: 'csv' }, headers: { authorization: 'Bearer sekret' } });
  ok('csv is offered for the log row', /^text\/csv/.test(csv.headers['content-type']),
     csv.headers['content-type']);
  const lines = csv.body.trim().split('\n');
  ok('csv is a header and exactly one row', lines.length === 2, lines.length);
  ok('csv columns match the row', lines[0].split(',').length === Object.keys(row).length,
     [lines[0].split(',').length, Object.keys(row).length]);

  /* ------------------------------------------------- alerting must be honest */
  /* The failure mode being fixed is silence. So a watchdog with no way to reach
     anybody must SAY so, in every response, rather than quietly doing nothing. */
  delete process.env.ALERT_WEBHOOK_URL;
  v = parse(await call());
  ok('with no channel configured it declares itself mute',
     v.alerting && v.alerting.channel === 'none', v.alerting);
  ok('and explains how a human still finds out',
     v.alerting.warning && /GitHub|webhook/i.test(v.alerting.warning), v.alerting.warning);

  /* An unreachable webhook must not take the verdict down with it: the check is
     the product, delivery is best-effort. */
  process.env.ALERT_WEBHOOK_URL = 'http://127.0.0.1:9/nope';
  TABS = ['Drivers (Online Only)'];
  r = await call(); v = parse(r);
  ok('a dead webhook does not break the verdict', r.statusCode === 503 && v.ok === false, r.statusCode);
  ok('and the delivery failure is reported',
     v.alerting.result && v.alerting.result.posted === false, v.alerting);
  delete process.env.ALERT_WEBHOOK_URL;

  /* Never cached. A cached verdict is stale confidence, which is the thing. */
  setSheet();
  r = await call();
  ok('the verdict is never cached', /no-store/.test(r.headers['cache-control'] || ''),
     r.headers['cache-control']);

  /* ------------------------------------------- the workflow's verdict parser */
  const VP = path.join(__dirname, '..', '.github', 'scripts', 'verdict.py');
  const run = (body, label, code) => {
    try { execFileSync('python3', [VP, label, String(code)], { input: body, encoding: 'utf8' }); return { code: 0 }; }
    catch (e) { return { code: e.status, out: String(e.stdout || '').trim() }; }
  };
  ok('verdict.py passes a healthy body', run('{"ok":true}', 'watchdog', 200).code === 0);
  ok('verdict.py fails a 503 and quotes the reason',
     run('{"ok":false,"failures":["data is 9 days old"]}', 'watchdog', 503).out.indexOf('9 days old') > -1);
  ok('verdict.py fails an unparseable body — a proxy error page must not read as green',
     run('<html>504 Gateway Timeout</html>', 'watchdog', 504).code === 1);
  /* /api/health always answers 200, so its BODY has to be read. A parser that
     trusted the status code would have stayed green through the outage. */
  ok('verdict.py reads health\'s body, not its always-200 status',
     run('{"ok":false,"sheets":{"error":"tab not found"}}', 'health', 200).code === 1);
  ok('and surfaces the per-check error',
     run('{"ok":false,"sheets":{"error":"tab not found"}}', 'health', 200).out.indexOf('tab not found') > -1);
  ok('verdict.py fails a body with no ok flag at all', run('{}', 'watchdog', 200).code === 1);

  console.log(`watchdog: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
