/* =========================================================================
   /api/watchdog  —  the smoke alarm.

   WHY THIS EXISTS

   This board's failure mode is not an error. It is a confident wrong answer.
   Every page falls back to its embedded snapshot when the live pull fails, and
   keeps drawing, with a small "Snapshot" pill as the only tell. That is the
   right behaviour for a screen on a wall — and it means a broken data path is
   invisible to anyone who is not already suspicious.

   It has cost real time twice. The board once sat 69 days behind the sheet
   while every figure looked plausible. And /api/data spent a stretch returning
   {"error":"opts is not defined"} to every single caller — found not by any
   alarm but because somebody happened to curl the endpoint while checking
   something else.

   /api/health would have reported GREEN through that second one, and this is
   the part worth internalising: health calls parseDaily directly and never
   calls buildData(), so it exercises a PARALLEL code path rather than the one
   the board actually uses. A check that does not run the real thing is not a
   check. This route runs the real thing.

   WHAT IT ASSERTS

     1. buildData() — the actual function every page depends on — returns
        without throwing.  (The check that was missing.)
     2. It returns rows at all.
     3. The newest data is recent, not merely present. Nothing else in this
        codebase asserts this: latestDataDate appears seven times and every one
        of them CLAMPS a window to accept stale data gracefully. None complains.
     4. The trailing pending days are not piling up — a sheet nobody is filling
        in looks exactly like a sheet that is up to date, minus the ad spend.
     5. The forecast layer can still produce a number, so a broken model surfaces
        here rather than as an empty page.

   WHAT IT RETURNS

     200 + {ok:true}   healthy
     503 + {ok:false}  something above failed, with the reason

   A real status code, so the cheapest uptime monitor in the world works against
   it with no configuration at all.

   AUTH

   Exempt from the Basic-Auth gate, because a scheduler cannot type a password.
   So without a credential it returns STATUS ONLY — booleans, dates, counts,
   error strings — exactly the posture /api/health takes. Present a bearer token
   (CRON_SECRET, which Vercel Cron sends automatically, or any AI token) and it
   also returns the forecast log row, which contains figures.
   ========================================================================= */
const fs = require('fs');
const path = require('path');

const num = (v, dflt) => { const n = parseFloat(v); return isNaN(n) ? dflt : n; };
const MAX_AGE_DAYS = num(process.env.WATCHDOG_MAX_AGE_DAYS, 2);
const MAX_PENDING_DAYS = num(process.env.WATCHDOG_MAX_PENDING_DAYS, 2);
const clip = s => String(s == null ? '' : (s.message || s)).slice(0, 240);
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/* prior_year.js is a browser file (window.DL_PRIOR = {...}). Read it the same
   way the offline tests do rather than keeping a second copy of 2025 around for
   the sake of this route. */
function loadPriorYear() {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'prior_year.js'), 'utf8');
    const w = {};
    new Function('window', src)(w);
    return w.DL_PRIOR;
  } catch (e) { return null; }
}

function authorised(req) {
  const h = (req.headers && req.headers.authorization) || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return false;
  const token = m[1].trim();
  if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) return true;
  try {
    const A = require('../lib/ai-access.js');
    return !!A.identify(h, process.env.AI_TOKENS);
  } catch (e) { return false; }
}

/* Slack and Discord want a specific shape; everything else (Zapier, Make, n8n,
   a plain endpoint) takes the whole verdict. Detected by hostname so a URL can
   be pasted in without also having to pick a format. */
async function alert(url, verdict) {
  const lines = verdict.failures.map(f => '• ' + f);
  const text = (verdict.ok ? '✅ DiggerLid board healthy' : '🔴 DiggerLid board needs attention')
    + '\n' + lines.join('\n')
    + '\nData through ' + (verdict.checks.dataRoute.latestDataDate || 'unknown')
    + ' · ' + verdict.origin + '/api/watchdog';
  let body;
  if (/hooks\.slack\.com/.test(url)) body = { text };
  else if (/discord(app)?\.com/.test(url)) body = { content: text };
  else body = Object.assign({ text }, verdict);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { posted: r.ok, status: r.status };
}

module.exports = async (req, res) => {
  const q = (req.query || {});
  const full = authorised(req);
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const origin = proto + '://' + (req.headers['x-forwarded-host'] || req.headers.host || '');

  const checks = {};
  const failures = [];

  /* ---- 1-4. the real data path ------------------------------------------ */
  const dr = { ran: false, rows: 0, latestDataDate: null, ageDays: null, error: null };
  let built = null;
  try {
    built = await require('./data.js').buildData();
    dr.ran = true;
    dr.rows = (built.daily || []).length;
    dr.latestDataDate = (built.meta && built.meta.latestDataDate) || null;
    if (dr.latestDataDate) dr.ageDays = daysBetween(dr.latestDataDate, todayISO());
  } catch (e) {
    dr.error = clip(e);
    failures.push('/api/data is broken: ' + dr.error);
  }
  checks.dataRoute = dr;

  if (dr.ran && !dr.rows) failures.push('/api/data returned 0 daily rows');
  if (dr.ran && dr.rows && dr.ageDays == null) failures.push('/api/data returned rows but no latestDataDate');
  if (dr.ageDays != null && dr.ageDays > MAX_AGE_DAYS) {
    failures.push('data is ' + dr.ageDays + ' days old (limit ' + MAX_AGE_DAYS +
                  '); newest is ' + dr.latestDataDate);
  }

  /* A sheet nobody is filling in looks identical to one that is current, minus
     the ad spend — so the length of the pending tail is its own check. */
  const pt = { days: 0, dates: [], groups: [] };
  if (built && built.daily) {
    for (let i = built.daily.length - 1; i >= 0; i--) {
      const d = built.daily[i];
      if (!d || !(d.revenue > 0)) continue;
      if (!d.pending) break;
      pt.days++; pt.dates.unshift(d.date);
      d.pending.forEach(g => { if (pt.groups.indexOf(g) === -1) pt.groups.push(g); });
    }
  }
  checks.pendingTail = pt;
  if (pt.days > MAX_PENDING_DAYS) {
    failures.push(pt.days + ' trailing days still unfilled in the sheet (' +
                  pt.groups.join(', ') + ') from ' + pt.dates[0] + ' — limit ' + MAX_PENDING_DAYS);
  }

  /* ---- 5. the forecast layer -------------------------------------------- */
  const fc = { ran: false, from: null, horizonDays: null, error: null };
  let row = null;
  if (built && (built.daily || []).length) {
    try {
      const F = require('../forecast.js');
      const prior = loadPriorYear();
      const map = new Map();
      ((prior && prior.daily) || []).forEach(d => { if (d && d.date) map.set(d.date, d); });
      (built.daily || []).forEach(d => { if (d && d.date) map.set(d.date, d); });
      const rows = [...map.values()].filter(d => d.revenue > 0).sort((a, b) => a.date < b.date ? -1 : 1);
      /* The forecast starts from the last COMPLETE day, exactly as the page
         does — anchoring on a half-filled day would log the fiction. */
      let from = rows.length ? rows[rows.length - 1].date : null;
      for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].pending) { from = rows[i].date; break; }
      const to = from.slice(0, 4) + '-12-31';
      const horizon = Math.max(1, daysBetween(from, to));
      const years = new Set(rows.map(r => r.date.slice(0, 4)));
      years.add(String(+from.slice(0, 4) + 1));
      const sale = F.salePeriodModifiers(rows, { years: [...years].sort() });
      const out = {};
      ['pessimistic', 'realistic', 'optimistic'].forEach(sc => {
        out[sc] = F.projectPnl({ rows, from, horizon, scenario: sc, modifiers: sale });
      });
      if (!isFinite(out.realistic.total) || out.realistic.total <= 0) throw new Error('forecast produced no total');
      fc.ran = true; fc.from = from; fc.horizonDays = horizon;
      /* THE FORECAST LOG ROW.

         Nothing anywhere records what the forecast SAID, so it can only be
         checked in simulation — never against what actually happened. One row a
         day fixes that, and this is the row. Flat on purpose: it appends to a
         sheet, a CSV or a database without reshaping. */
      const nov = out.realistic.months.find(m => m.month.slice(5) === '11');
      row = {
        logged_on: todayISO(),
        forecast_from: from,
        data_through: dr.latestDataDate,
        horizon_days: horizon,
        revenue_pessimistic: Math.round(out.pessimistic.total),
        revenue_realistic: Math.round(out.realistic.total),
        revenue_optimistic: Math.round(out.optimistic.total),
        profit_realistic: Math.round(out.realistic.profit),
        ad_spend_realistic: Math.round(out.realistic.adSpend),
        november_revenue: nov ? Math.round(nov.revenue) : null,
        november_profit: nov ? Math.round(nov.profit) : null,
        level_per_day: Math.round(out.realistic.level),
        drift_per_28d: +out.realistic.drift.toFixed(4),
        yoy_growth: out.realistic.basis.growth.yoy != null ? +out.realistic.basis.growth.yoy.toFixed(4) : null,
        breakeven_per_day: Math.round(out.realistic.breakevenPerDay || 0),
        fixed_cost_per_day: Math.round(out.realistic.pnl.fcPerDay),
        sale_periods_applied: sale.map(m => m.key).join(' '),
      };
    } catch (e) {
      fc.error = clip(e);
      failures.push('the forecast layer failed: ' + fc.error);
    }
  }
  checks.forecast = fc;

  /* Integration reachability is /api/health's job and is not duplicated here.
     Named so a reader knows this route is not claiming to cover it. */
  checks.notCoveredHere = { integrationReachability: '/api/health' };

  const verdict = {
    ok: failures.length === 0,
    ts: new Date().toISOString(),
    origin,
    failures,
    checks,
    thresholds: { maxAgeDays: MAX_AGE_DAYS, maxPendingDays: MAX_PENDING_DAYS },
  };

  /* ---- outbound ---------------------------------------------------------- */
  /* The whole point of this route is that somebody is TOLD. So when no channel
     is configured it says so, loudly, in every response — the failure mode this
     exists to fix must not be reintroduced by the fix. */
  const hook = process.env.ALERT_WEBHOOK_URL;
  verdict.alerting = hook ? { channel: 'webhook' } : {
    channel: 'none',
    warning: 'No ALERT_WEBHOOK_URL is set, so nothing here reaches a human on its own. ' +
             'The scheduled GitHub Action fails the job on a non-200 from this route, which ' +
             'GitHub emails the repository owner about — that path needs no configuration. ' +
             'Set ALERT_WEBHOOK_URL to a Slack, Discord, Zapier or Make hook for a direct message.',
  };
  if (hook && (!verdict.ok || q.test)) {
    try { verdict.alerting.result = await alert(hook, verdict); }
    catch (e) { verdict.alerting.result = { posted: false, error: clip(e) }; }
  }

  if (full && row) verdict.forecastLog = row;
  else if (row) verdict.forecastLog = 'withheld — present a bearer token (CRON_SECRET or an AI token) for the figures';

  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  /* CSV so a sheet-append automation can consume the log row directly. */
  if (q.format === 'csv' && full && row) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    const keys = Object.keys(row);
    return res.status(verdict.ok ? 200 : 503).send(
      keys.join(',') + '\n' + keys.map(k => {
        const v = row[k];
        return v == null ? '' : (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
      }).join(',') + '\n');
  }

  res.status(verdict.ok ? 200 : 503).send(JSON.stringify(verdict, null, 2));
};
