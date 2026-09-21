#!/usr/bin/env node
/* check_snapshots.js — does every committed fallback snapshot still tell the truth?

   The failure this exists to catch: region_data.js froze on 2026-07-02 and stayed
   frozen for eighty-one days. Its builder made no network call, its asOf was a
   string literal, no page showed its age and no check looked at it. The board
   kept serving July's geography with complete confidence.

   Every snapshot must be REGISTERED here with a budget, or this fails. Silence is
   the bug, so a new snapshot cannot be added without someone saying how fresh it
   is expected to be. `static: true` is the one exemption and needs a reason.

   Run: node source/check_snapshots.js   (exit 0 = every snapshot within budget)
*/
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DLcore = require(path.join(ROOT, 'core.js'));

const MANIFEST = [
  { file: 'region_data.js',      global: 'DL_REGION',            budget: 7,  note: 'refreshed by build_snapshots.js' },
  { file: 'pulse_data.js',       global: 'DL_PULSE',             budget: 7,  note: 'refreshed by build_snapshots.js' },
  { file: 'data.js',             global: 'DL_DATA',              budget: 7,  note: 'refreshed by build_data.py' },
  { file: 'products_history.js', global: 'DL_PRODUCTS_HISTORY',  budget: 21, note: 'immutable history; the page tops up the last 45 days live' },
  { file: 'meta_snapshot.js',    global: 'DL_META_SNAPSHOT',     budget: 45, note: '90-day benchmark pull, not a daily figure' },
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

const today = DLcore.todayAEST();
let fail = 0;
console.log(`snapshot freshness · ${today}\n`);

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
  console.log(`  ${over ? '✗' : '·'} ${m.file.padEnd(22)} ${String(a.days).padStart(3)}d old (budget ${m.budget}d) · asOf ${a.asOf}${over ? '  ← STALE: ' + m.note : ''}`);
  if (over) fail++;
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

console.log(`\nsnapshots: ${fail ? fail + ' need attention' : 'all within budget'}`);
process.exit(fail ? 1 : 0);
