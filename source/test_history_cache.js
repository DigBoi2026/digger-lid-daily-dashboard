/* Unit tests for lib/history_cache.js and the snapshot short-circuit it gives
   the heavy Shopify builders.  Run: node source/test_history_cache.js  (exit 0 = all pass)

   Two things are pinned here, and the second is the whole point of the feature:

     1. The pure helpers — through / isFresh / served / mergeDaily — do the date
        and merge arithmetic the daily job and the live route both lean on.

     2. THE GUARANTEE.  When a fresh snapshot is committed, buildProductsDaily /
        buildGeo / buildRegion return it with ZERO Shopify queries; fetch is
        stubbed to throw, so any query at all would blow the test up. And when
        the snapshot is missing, stale, or explicitly bypassed (opts.full, the
        rebuild path), the builder falls through to the live pull exactly as it
        did before the cache existed. That fall-through is what makes the cache
        safe to ship with no snapshot in the tree: worst case is today's
        behaviour, never worse. */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}` + (got !== undefined ? `  (got ${JSON.stringify(got)})` : '')); }
}
const iso = d => d.toISOString().slice(0, 10);

process.env.SHOPIFY_STORE = 'test-store';
process.env.SHOPIFY_TOKEN = 'shpat_test';

const HC = require('../lib/history_cache.js');

/* ---- the anchor dates the freshness window is measured against ---- */
const today = new Date('2026-09-14T00:00:00Z');
const dayBefore = n => { const d = new Date(today.getTime()); d.setUTCDate(d.getUTCDate() - n); return iso(d); };

/* =============================== through =============================== */
ok('through reads the stamped meta.through', HC.through({ meta: { through: '2026-09-13' } }) === '2026-09-13');
ok('through falls back to the max daily date', HC.through({ daily: [{ date: '2026-01-02' }, { date: '2026-03-09' }, { date: '2026-02-01' }] }) === '2026-03-09');
ok('through of nothing is null', HC.through(null) === null);
ok('through of an empty snapshot is null', HC.through({ daily: [] }) === null);

/* =============================== isFresh =============================== */
ok('yesterday is fresh', HC.isFresh({ meta: { through: dayBefore(1) } }, today) === true);
ok('two days back is fresh (inside the default allowance)', HC.isFresh({ meta: { through: dayBefore(3) } }, today) === true);
ok('a week back is stale', HC.isFresh({ meta: { through: dayBefore(7) } }, today) === false);
ok('no through is never fresh', HC.isFresh({ meta: {} }, today) === false);
ok('a wider allowance keeps an older snapshot fresh', HC.isFresh({ meta: { through: dayBefore(9) } }, today, 9) === true);

/* =============================== served =============================== */
(() => {
  const snap = { daily: [{ date: '2026-09-13', x: 1 }], meta: { through: '2026-09-13' } };
  const out = HC.served(snap);
  ok('served marks the payload cached', out.meta.cached === true);
  ok('served keeps the rest of meta', out.meta.through === '2026-09-13');
  ok('served does not mutate the stored snapshot', snap.meta.cached === undefined);
  ok('served carries the data through', out.daily[0].x === 1);
})();

/* ============================== mergeDaily ============================== */
(() => {
  const hist = [{ date: '2026-09-01', v: 1 }, { date: '2026-09-02', v: 2 }];
  const recent = [{ date: '2026-09-02', v: 99 }, { date: '2026-09-03', v: 3 }];
  const m = HC.mergeDaily(hist, recent);
  ok('merge is sorted ascending by date', m.map(r => r.date).join(',') === '2026-09-01,2026-09-02,2026-09-03', m.map(r => r.date));
  ok('recent wins on a shared date', m.find(r => r.date === '2026-09-02').v === 99);
  ok('merge tolerates empty inputs', HC.mergeDaily(null, null).length === 0);
})();

/* ===================== the guarantee: zero-query serve ===================== */
/* Any live query would call fetch; stub it to throw so a single one fails loudly. */
let fetchCalls = 0;
global.fetch = async () => { fetchCalls++; throw new Error('FETCH_CALLED'); };

const S = require('../api/shopify.js');
S._setPace(0);

/* Write a snapshot to the real committed location, run the builder, then put the
   tree back exactly as it was — restoring any file that was already there. */
async function withSnapshot(name, snap, fn) {
  const p = path.join(HC.DIR, name + '.json');
  const had = fs.existsSync(p);
  const prev = had ? fs.readFileSync(p) : null;
  try {
    if (snap === null) { if (had) fs.unlinkSync(p); }
    else HC.save(name, snap);
    return await fn();
  } finally {
    if (prev !== null) fs.writeFileSync(p, prev);
    else if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

const fresh = { daily: [{ date: dayBefore(1), total: 10 }], totals: { total: 10 }, meta: { through: dayBefore(1) } };
const stale = { daily: [{ date: dayBefore(30), total: 10 }], totals: { total: 10 }, meta: { through: dayBefore(30) } };

(async () => {
  for (const name of ['productsDaily', 'geo', 'region']) {
    const fn = S[name === 'productsDaily' ? 'buildProductsDaily' : name === 'geo' ? 'buildGeo' : 'buildRegion'];

    /* Fresh snapshot → served verbatim, not one query fired. */
    fetchCalls = 0;
    const out = await withSnapshot(name, fresh, () => fn(today));
    ok(`${name}: a fresh snapshot serves with zero Shopify queries`, fetchCalls === 0, fetchCalls);
    ok(`${name}: and the payload is marked cached`, out && out.meta && out.meta.cached === true);

    /* opts.full ignores even a fresh snapshot — this is the rebuild path, and it
       MUST reach the live pull (our stub throws to prove it got there). */
    fetchCalls = 0;
    let hitLive = false;
    try { await withSnapshot(name, fresh, () => fn(today, { full: true })); }
    catch (e) { hitLive = /FETCH_CALLED/.test(e.message); }
    ok(`${name}: opts.full bypasses the snapshot and pulls live`, hitLive && fetchCalls > 0, fetchCalls);

    /* Stale snapshot → falls through to the live pull. */
    fetchCalls = 0; hitLive = false;
    try { await withSnapshot(name, stale, () => fn(today)); }
    catch (e) { hitLive = /FETCH_CALLED/.test(e.message); }
    ok(`${name}: a stale snapshot falls through to a live pull`, hitLive && fetchCalls > 0, fetchCalls);

    /* No snapshot → the pre-cache behaviour, a live pull. */
    fetchCalls = 0; hitLive = false;
    try { await withSnapshot(name, null, () => fn(today)); }
    catch (e) { hitLive = /FETCH_CALLED/.test(e.message); }
    ok(`${name}: no snapshot behaves exactly as before — a live pull`, hitLive && fetchCalls > 0, fetchCalls);
  }

  console.log(`history cache: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
