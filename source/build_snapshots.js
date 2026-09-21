#!/usr/bin/env node
/* build_snapshots.js — refresh the committed fallback snapshots from the LIVE API.

   Why this exists. Each page ships an embedded snapshot it falls back to when the
   live route cannot be reached. Those snapshots were produced by scripts that made
   no network call at all: source/build_region.js is 149 lines of figures typed in
   as literals, down to `asOf:"2026-07-02"` as a string. Re-running it emitted the
   same July file forever, so region_data.js sat 81 days out of date while looking
   entirely current. This replaces that with an actual pull.

   It reads the deployed API rather than Shopify directly, so the only credential
   it needs is the site password the board already gates on — the same one
   source/build_data.py uses — and the server does the Shopify work (and now
   answers most of it from the committed history cache).

   Usage
     export DASHBOARD_PASSWORD='...'            # the SITE_PASSWORD gate
     node source/build_snapshots.js             # every target
     node source/build_snapshots.js region      # just one
     DASHBOARD_URL=http://localhost:3000 node source/build_snapshots.js

   Safety: a fetched payload must carry every top-level key the committed snapshot
   already has, or the target is skipped and the run fails. A snapshot replaced by
   a differently-shaped payload would break the page precisely when the live route
   is down — the one moment the fallback matters.
*/
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DLcore = require(path.join(ROOT, 'core.js'));

const BASE = process.env.DASHBOARD_URL || 'https://digboi-seven.vercel.app';
const USER = process.env.DASHBOARD_USER || 'diggerlid';
const PASS = process.env.DASHBOARD_PASSWORD || '';

/* target → where it comes from, what global it defines, and the banner to write. */
const TARGETS = {
  region: {
    file: 'region_data.js', global: 'DL_REGION', route: '/api/shopify?dataset=region',
    banner: [
      '// Shopify geographic snapshot — ShopifyQL sales by shipping_country / shipping_region.',
      '// Auto-generated. Do not hand-edit. Regenerate: node source/build_snapshots.js region',
    ],
  },
  pulse: {
    file: 'pulse_data.js', global: 'DL_PULSE', route: '/api/pulse',
    banner: [
      '// PostHog behavioural snapshot — daily site signals for the Daily Pulse page.',
      '// null = not yet tracked that day (NOT zero) — keeps baselines honest.',
      '// Auto-generated. Do not hand-edit. Regenerate: node source/build_snapshots.js pulse',
    ],
  },
};

function existingKeys(file, global) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return null;
  const sandbox = { window: {} };
  try {
    new Function('window', fs.readFileSync(p, 'utf8'))(sandbox.window);
    const obj = sandbox.window[global];
    return obj && typeof obj === 'object' ? Object.keys(obj) : null;
  } catch (e) { return null; }
}

async function pull(route) {
  const url = BASE + route + (route.includes('?') ? '&' : '?') + 't=' + Date.now();
  const headers = { Accept: 'application/json' };
  if (PASS) headers.Authorization = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  const r = await fetch(url, { headers });
  if (r.status === 401) throw new Error('HTTP 401 — set DASHBOARD_PASSWORD to the current SITE_PASSWORD');
  if (r.status === 503) throw new Error('HTTP 503 — the route is refusing (rate limit, or no SITE_PASSWORD deployed)');
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${route}`);
  const j = await r.json();
  if (!j || j.error) throw new Error('payload carried an error: ' + JSON.stringify(j && j.error).slice(0, 160));
  return j;
}

(async () => {
  const only = process.argv[2];
  const names = only ? [only] : Object.keys(TARGETS);
  const today = DLcore.todayAEST();
  let fail = 0;

  for (const name of names) {
    const t = TARGETS[name];
    if (!t) { console.error('unknown target:', name); fail++; continue; }
    try {
      const data = await pull(t.route);

      /* Shape gate — never replace a working fallback with something the page
         cannot read. */
      const want = existingKeys(t.file, t.global);
      if (want) {
        const missing = want.filter(k => !(k in data));
        if (missing.length) throw new Error(`payload is missing keys the page reads: ${missing.join(', ')}`);
      }

      /* A REAL age, generated now — the whole point. */
      data.meta = Object.assign({}, data.meta, { asOf: today, builtAt: new Date().toISOString(), snapshot: true });

      const body = t.banner.join('\n') + '\n' +
                   `window.${t.global} = ` + JSON.stringify(data, null, 0) + ';\n';
      fs.writeFileSync(path.join(ROOT, t.file), body);
      const size = (Buffer.byteLength(body) / 1024).toFixed(0);
      console.log(`saved ${t.file} · ${size} KB · asOf ${today}`);
    } catch (e) {
      console.error(`FAILED ${name} · ${String((e && e.message) || e)}`);
      fail++;
    }
  }
  process.exit(fail ? 1 : 0);
})();
