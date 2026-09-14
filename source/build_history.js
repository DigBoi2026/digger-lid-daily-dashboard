#!/usr/bin/env node
/* Rebuild the committed history snapshots for the heavy Shopify datasets.

   Run daily by .github/workflows/refresh-data.yml. Pulls the FULL history once
   (opts.full bypasses the snapshot short-circuit in the builders), stamps the
   last complete day, and writes data/history/<name>.json. The live route then
   serves that file with zero Shopify queries until the next run.

   Usage:  node source/build_history.js [dataset]
           node source/build_history.js            # all datasets
           node source/build_history.js region     # just one
*/
const path = require('path');
const S = require(path.join(__dirname, '..', 'api', 'shopify.js'));
const HC = require(path.join(__dirname, '..', 'lib', 'history_cache.js'));
const iso = d => d.toISOString().slice(0, 10);

const DATASETS = { productsDaily: S.buildProductsDaily, geo: S.buildGeo, region: S.buildRegion };

(async () => {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const yest = new Date(today); yest.setUTCDate(yest.getUTCDate() - 1);
  const only = process.argv[2];
  const names = only ? [only] : Object.keys(DATASETS);
  let fail = 0;
  for (const name of names) {
    const fn = DATASETS[name];
    if (!fn) { console.error('unknown dataset:', name); fail++; continue; }
    try {
      const data = await fn(today, { full: true });
      data.meta = Object.assign({}, data.meta, { through: iso(yest), builtAt: new Date().toISOString(), snapshot: true });
      HC.save(name, data);
      console.log('saved', name, '· through', iso(yest));
    } catch (e) { console.error('FAILED', name, '·', String((e && e.message) || e)); fail++; }
  }
  process.exit(fail ? 1 : 0);
})();
