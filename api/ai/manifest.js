/* =========================================================================
   /api/ai/manifest  —  what this board is, and what this caller may read.

   The entry point for an AI consumer: hand it the board URL and a token, and
   this one call tells it every dataset it can reach, the parameters each takes,
   and where the field dictionary lives. Scoped to the caller, so the response
   never advertises data the token cannot fetch.
   ========================================================================= */
const A = require('../../lib/ai-access.js');
const { DATASETS } = require('../../lib/ai-schema.js');
const { guard, noStore } = require('./_guard.js');

module.exports = async (req, res) => {
  const caller = guard(req, res);
  if (!caller) return;

  const base = `https://${req.headers.host}`;
  const readable = Object.entries(DATASETS).filter(([, d]) =>
    d.scopes.some(s => caller.scopes.includes(s)));

  const pnl = A.pnlFilter(caller.scopes);

  noStore(res);
  res.status(200).json({
    name: 'DiggerLid Daily Operations Review',
    description: 'Daily ecommerce P&L, product and region sales, and site signals for DiggerLid (AU).',
    version: '1.0',
    timezone: 'Australia/Melbourne',
    currency: 'AUD',
    caller: { name: caller.name, scopes: caller.scopes },
    access: {
      scheme: 'bearer',
      header: 'Authorization: Bearer <token>',
      read_only: true,
      note: 'Every route is read-only. There is no write path in this application.',
    },
    conventions: {
      envelope: 'Each query returns { dataset, source, grain, row_count, rows, fields_withheld }.',
      nulls: 'A null means the sheet cell is empty, not zero.',
      dates: 'ISO-8601 (YYYY-MM-DD). Days are complete; today is never included.',
      withheld_fields: pnl.denied ? null
        : (pnl.drop.length ? 'This token receives P&L rows with cost, salary and profit fields removed.'
                           : 'This token receives all P&L fields.'),
    },
    endpoints: [
      { path: '/api/ai/manifest', method: 'GET', description: 'This document.' },
      { path: '/api/ai/schema',   method: 'GET', description: 'Field dictionary. Optional ?dataset=<name>.' },
      { path: '/api/ai/query',    method: 'GET', description: 'Read a dataset. ?dataset=<name>[&since=&until=]' },
      { path: '/api/ai/llms',     method: 'GET', description: 'The same orientation as plain text, for prompt context.' },
      { path: '/api/health',      method: 'GET', description: 'Integration health. No token required, returns no figures.' },
    ],
    datasets: readable.map(([key, d]) => ({
      dataset: key,
      title: d.title,
      grain: d.grain,
      source: d.source,
      params: d.params || {},
      query: `${base}/api/ai/query?dataset=${encodeURIComponent(key)}`,
      schema: `${base}/api/ai/schema?dataset=${encodeURIComponent(key)}`,
      notes: d.notes || [],
    })),
    datasets_withheld: Object.keys(DATASETS).filter(k => !readable.some(([rk]) => rk === k)),
  });
};
