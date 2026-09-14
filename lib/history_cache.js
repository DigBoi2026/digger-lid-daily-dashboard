/* =========================================================================
   Committed history cache.

   The heavy Shopify routes (productsDaily, geo, region) each pull one or two
   YEARS of daily data. That history is immutable — a day three months ago does
   not change — so re-pulling it on every cache miss is pure waste, and it is
   what exhausts Shopify's rate-limit bucket.

   The fix, without any paid store: a daily job (source/build_history.js, run by
   .github/workflows/refresh-data.yml) pulls the full history once and commits
   it as data/history/<name>.json. The live route then SERVES that committed
   snapshot with zero Shopify queries whenever it is current, and only falls
   back to a live pull if the snapshot is missing or stale. No snapshot yet
   means the route behaves exactly as before — this can never make a route
   worse, only cheaper.

   Freshness is judged by the snapshot's own `meta.through` (the last complete
   day it covers), stamped by the build job. A snapshot within `maxStaleDays` of
   yesterday is served as-is.
   ========================================================================= */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'history');
const iso = d => d.toISOString().slice(0, 10);

function load(name) {
  try {
    const p = path.join(DIR, name + '.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch (e) { return null; }
}

function save(name, obj) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, name + '.json'), JSON.stringify(obj));
}

/* The snapshot's last complete day: its stamped meta.through, or the max date
   in a daily array as a fallback. */
function through(snap) {
  if (!snap) return null;
  if (snap.meta && snap.meta.through) return snap.meta.through;
  const rows = (snap.daily || []);
  let m = ''; rows.forEach(r => { if (r && r.date && r.date > m) m = r.date; });
  return m || null;
}

/* Is this snapshot recent enough to serve without a live top-up? "today" is a
   Date; a snapshot is fresh if it covers within maxStaleDays of yesterday. */
function isFresh(snap, today, maxStaleDays = 2) {
  const th = through(snap);
  if (!th) return false;
  const cutoff = new Date(today.getTime());
  cutoff.setUTCDate(cutoff.getUTCDate() - (maxStaleDays + 1));   // yesterday minus the allowance
  return th >= iso(cutoff);
}

/* What the route returns from a snapshot: the snapshot, marked cached so the
   response says where it came from. Never mutates the stored object. */
function served(snap) {
  return Object.assign({}, snap, { meta: Object.assign({}, snap.meta || {}, { cached: true }) });
}

/* Merge recent daily rows over a snapshot's daily array, newest wins, by date.
   Used by build_history when it advances a snapshot rather than rebuilding it. */
function mergeDaily(histRows, recentRows, dateField = 'date') {
  const by = new Map();
  (histRows || []).forEach(r => { if (r && r[dateField]) by.set(r[dateField], r); });
  (recentRows || []).forEach(r => { if (r && r[dateField]) by.set(r[dateField], r); });
  return [...by.values()].sort((a, b) => a[dateField] < b[dateField] ? -1 : 1);
}

module.exports = { load, save, through, isFresh, served, mergeDaily, DIR, _iso: iso };
