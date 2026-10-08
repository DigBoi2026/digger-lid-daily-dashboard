#!/usr/bin/env node
/* check_snapshots.js — does every committed fallback snapshot still tell the truth?

   The failure this exists to catch: region_data.js froze on 2026-07-02 and stayed
   frozen for eighty-one days. Its builder made no network call, its asOf was a
   string literal, no page showed its age and no check looked at it. The board
   kept serving July's geography with complete confidence.

   Every snapshot must be REGISTERED here with a budget, or this fails. Silence is
   the bug, so a new snapshot cannot be added without someone saying how fresh it
   is expected to be. `static: true` is the one exemption and needs a reason.

   Run: node source/check_snapshots.js          (exit 0 = everything within budget)
        node source/check_snapshots.js --auto   (exit 0 = everything a JOB refreshes is within budget)
        ... --no-annotate                        (print only; raise nothing on the CI summary)

   WHY --auto EXISTS. The nightly job can only fail on what it can fix. Two
   snapshots have no scheduled builder at all — someone pulls them by hand — and
   failing the nightly run on those every night for weeks is how a red badge
   becomes wallpaper. With --auto they are still printed, and in CI they are
   still raised as warnings; they just do not decide the exit code. A human
   running the command bare sees the whole truth, which is the default. */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DLcore = require(path.join(ROOT, 'core.js'));

/* `auto` says a SCHEDULED JOB refreshes this file. It is not decoration: it is
   what --auto gates on, so marking something auto without wiring it into
   .github/workflows/refresh-data.yml re-creates the original bug in a new
   place. `by` is the command, and for a manual snapshot it is the instruction
   a human needs when the warning fires. */
const MANIFEST = [
  { file: 'region_data.js',      global: 'DL_REGION',            budget: 7,  auto: true,
    by: 'node source/build_snapshots.js' },
  { file: 'pulse_data.js',       global: 'DL_PULSE',             budget: 7,  auto: true,
    by: 'node source/build_snapshots.js' },
  { file: 'data.js',             global: 'DL_DATA',              budget: 7,  auto: true,
    by: 'python3 source/build_data.py' },
  { file: 'products_history.js', global: 'DL_PRODUCTS_HISTORY',  budget: 21, auto: false,
    by: 'pull /api/shopify?dataset=productsHistory in halves, then node source/build_products_history.js <a.json> <b.json>',
    note: 'immutable history; the page tops up the last 45 days live' },
  { file: 'meta_snapshot.js',    global: 'DL_META_SNAPSHOT',     budget: 45, auto: false,
    by: 'a 90-day Meta Ads benchmark pull, by hand',
    note: '90-day benchmark pull, not a daily figure' },
  { file: 'prior_year.js',       global: 'DL_PRIOR',             static: true, note: '2025 is closed; static by design' },
  /* ORPHAN. No HTML loads it and no page reads DL_SHOPIFY — the Products page
     moved to products_history.js and left this behind. source/build_win3.js and
     the README still describe it as live, so it is reported rather than deleted:
     either rewire it or remove it (and the README section) deliberately. */
  { file: 'shopify_data.js',     global: 'DL_SHOPIFY',           orphan: true, note: 'no page loads it; README still documents it' },
];

function load(file, global) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return { missing: true };
  const w = {};
  try { new Function('window', fs.readFileSync(p, 'utf8'))(w); } catch (e) { return { broken: e.message }; }
  const obj = w[global];
  if (!obj || typeof obj !== 'object') return { broken: `${global} not defined` };
  return { meta: obj.meta || {} };
}

const AUTO_ONLY = process.argv.includes('--auto');
/* The workflow reports freshness twice: once before the rebuild and once after.
   Annotating both put every stale file on the run summary TWICE, and the
   before-run (which has no --auto) raised the two hand-pulled snapshots as
   errors, so the run showed eight errors for three problems. Only the gate
   annotates. */
const CI = !!process.env.GITHUB_ACTIONS && !process.argv.includes('--no-annotate');
/* A workflow annotation, so a stale snapshot is visible on the run's summary
   page rather than only to whoever opens the log. */
const annotate = (level, msg) => { if (CI) console.log(`::${level} title=snapshot freshness::${msg}`); };

const today = DLcore.todayAEST();
let fail = 0, warn = 0;
console.log(`snapshot freshness · ${today}${AUTO_ONLY ? '  (gating on automated snapshots only)' : ''}\n`);

for (const m of MANIFEST) {
  if (m.orphan) { console.log(`  ! ${m.file.padEnd(22)} ORPHAN — ${m.note}`); continue; }
  const r = load(m.file, m.global);
  if (r.missing) { console.log(`  ✗ ${m.file.padEnd(22)} FILE MISSING`); fail++; continue; }
  if (r.broken)  { console.log(`  ✗ ${m.file.padEnd(22)} UNREADABLE — ${r.broken}`); fail++; continue; }
  const a = DLcore.snapshotAge(m.static ? Object.assign({ static: true }, r.meta) : r.meta, today, m.budget);
  if (m.static) { console.log(`  · ${m.file.padEnd(22)} static — ${m.note}`); continue; }
  if (a.level === 'unknown') {
    console.log(`  ✗ ${m.file.padEnd(22)} DECLARES NO DATE — add asOf/builtOn to its meta`); fail++; continue;
  }
  const over = a.level === 'stale';
  /* Stale and nobody's job to fix on a schedule: still shouted about, but it
     cannot fail a run that was never able to refresh it. */
  const soft = over && AUTO_ONLY && !m.auto;
  const mark = !over ? '·' : soft ? '!' : '✗';
  const tail = over ? `  ← STALE${m.auto ? '' : ' (manual)'}: ${m.by}` : '';
  console.log(`  ${mark} ${m.file.padEnd(22)} ${String(a.days).padStart(3)}d old (budget ${m.budget}d) · asOf ${a.asOf}${tail}`);
  if (over) {
    annotate(soft ? 'warning' : 'error', `${m.file} is ${a.days}d old (budget ${m.budget}d). Refresh: ${m.by}`);
    if (soft) warn++; else fail++;
  }
}

/* A snapshot shipped but never registered is the same silence in a new file. */
const shipped = fs.readdirSync(ROOT).filter(f => /^(.*_data|.*_history|prior_year|data|.*_snapshot)\.js$/.test(f));
const known = new Set(MANIFEST.map(m => m.file));
const strays = shipped.filter(f => !known.has(f));
if (strays.length) {
  console.log(`\n  ✗ shipped but unregistered: ${strays.join(', ')}`);
  console.log('    Register it in MANIFEST with a budget, or delete it if nothing loads it.');
  fail += strays.length;
}

const parts = [];
if (fail) parts.push(`${fail} need attention`);
if (warn) parts.push(`${warn} stale but refreshed by hand`);
console.log(`\nsnapshots: ${parts.length ? parts.join(', ') : 'all within budget'}`);
process.exit(fail ? 1 : 0);
