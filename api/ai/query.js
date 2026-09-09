/* =========================================================================
   /api/ai/query  —  the single read surface.

     GET /api/ai/query?dataset=pnl.daily&since=2026-08-01&until=2026-09-08
     GET /api/ai/query?dataset=products
     GET /api/ai/query?dataset=region
     GET /api/ai/query?dataset=pulse

   Reuses the exact builders the board's own routes use, so an agent and the
   dashboard can never disagree about a number. Scope decides which datasets
   answer at all, and which P&L fields come back inside them.
   ========================================================================= */
const A = require('../../lib/ai-access.js');
const { DATASETS } = require('../../lib/ai-schema.js');
const { guard, noStore } = require('./_guard.js');

const ISO = /^\d{4}-\d{2}-\d{2}$/;

module.exports = async (req, res) => {
  const caller = guard(req, res);
  if (!caller) return;

  const q = req.query || {};
  const dataset = q.dataset;
  if (!dataset) {
    return res.status(400).json({ error: 'dataset_required', known: Object.keys(DATASETS) });
  }
  const def = DATASETS[dataset];
  if (!def) {
    return res.status(404).json({ error: 'unknown_dataset', detail: dataset, known: Object.keys(DATASETS) });
  }
  if (!def.scopes.some(s => caller.scopes.includes(s))) {
    return res.status(403).json({
      error: 'forbidden',
      detail: `"${dataset}" needs one of: ${def.scopes.join(', ')}`,
      your_scopes: caller.scopes,
    });
  }
  for (const k of ['since', 'until']) {
    if (q[k] && !ISO.test(q[k])) {
      return res.status(400).json({ error: 'bad_date', detail: `${k} must be YYYY-MM-DD, got "${q[k]}"` });
    }
  }

  try {
    const envelope = {
      dataset, title: def.title, grain: def.grain, source: def.source,
      currency: def.currency || null,
      scopes_applied: caller.scopes.filter(s => def.scopes.includes(s)),
      schema: `https://${req.headers.host}/api/ai/schema?dataset=${encodeURIComponent(dataset)}`,
    };

    if (dataset === 'pnl.daily' || dataset === 'pnl.monthly') {
      const pnl = A.pnlFilter(caller.scopes);
      const built = await require('../data.js').buildData({});
      let rows = dataset === 'pnl.daily' ? built.daily : built.monthly;
      if (dataset === 'pnl.daily') {
        if (q.since) rows = rows.filter(r => r.date >= q.since);
        if (q.until) rows = rows.filter(r => r.date <= q.until);
      }
      rows = A.applyFilter(rows, pnl.drop);
      envelope.as_of = built.meta.latestDataDate;
      envelope.sheet_months_read = built.meta.monthsRead;
      envelope.fields_withheld = pnl.drop;
      envelope.row_count = rows.length;
      envelope.rows = rows;
      if (dataset === 'pnl.daily' && rows.length) {
        envelope.range = { first: rows[0].date, last: rows[rows.length - 1].date };
      }
    } else if (dataset === 'products' || dataset === 'region') {
      const sh = require('../shopify.js');
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const built = dataset === 'products' ? await sh.buildProducts(today) : await sh.buildRegion(today);
      envelope.as_of = built.meta && built.meta.asOf;
      envelope.fields_withheld = [];
      envelope.data = built;
    } else if (dataset === 'pulse') {
      const built = await require('../pulse.js').buildPulse();
      envelope.as_of = built.meta && built.meta.asOf;
      envelope.fields_withheld = [];
      envelope.data = built;
    }

    noStore(res);
    res.status(200).json(envelope);
  } catch (err) {
    // Surface the upstream reason: an agent that gets a bare 500 will retry
    // forever, whereas a named cause can be reported back to a human.
    res.status(502).json({
      error: 'upstream_failed',
      dataset,
      detail: String((err && err.message) || err),
      hint: 'GET /api/health shows which integrations are configured and reachable.',
    });
  }
};
