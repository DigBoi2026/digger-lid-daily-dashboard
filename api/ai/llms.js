/* =========================================================================
   /api/ai/llms  —  orientation as plain text, for dropping into a prompt.

   Mirrors the convention of a site-root llms.txt, but scoped to the caller and
   behind the same token, because nothing about this board is public.
   ========================================================================= */
const A = require('../../lib/ai-access.js');
const { DATASETS } = require('../../lib/ai-schema.js');
const { guard } = require('./_guard.js');

module.exports = async (req, res) => {
  const caller = guard(req, res);
  if (!caller) return;

  const base = `https://${req.headers.host}`;
  const pnl = A.pnlFilter(caller.scopes);
  const mine = Object.entries(DATASETS).filter(([, d]) => d.scopes.some(s => caller.scopes.includes(s)));

  const lines = [
    '# DiggerLid Daily Operations Review',
    '',
    'Daily ecommerce trading data for DiggerLid (Australia). Currency AUD.',
    'Timezone Australia/Melbourne. All data is read-only.',
    '',
    `You are authenticated as "${caller.name}" with scopes: ${caller.scopes.join(', ')}.`,
    'Send every request with: Authorization: Bearer <your token>',
    '',
    '## Start here',
    '',
    `- ${base}/api/ai/manifest — every dataset you can read, with parameters`,
    `- ${base}/api/ai/schema — what each field means and its unit`,
    `- ${base}/api/ai/query?dataset=<name> — the data itself`,
    '',
    '## Datasets available to you',
    '',
  ];
  for (const [key, d] of mine) {
    lines.push(`### ${key} — ${d.title}`);
    lines.push(`Grain: ${d.grain}`);
    lines.push(`Source: ${d.source}`);
    if (d.params) for (const [p, desc] of Object.entries(d.params)) lines.push(`Param ${p}: ${desc}`);
    (d.notes || []).forEach(n => lines.push(`Note: ${n}`));
    lines.push(`Fetch: ${base}/api/ai/query?dataset=${encodeURIComponent(key)}`);
    lines.push('');
  }

  const withheld = Object.keys(DATASETS).filter(k => !mine.some(([mk]) => mk === k));
  if (withheld.length) {
    lines.push('## Not available to your token', '', withheld.map(w => `- ${w}`).join('\n'), '');
  }
  if (!pnl.denied && pnl.drop.length) {
    lines.push(
      '## Fields withheld from your P&L rows', '',
      'Cost structure, salaries and profitability are removed for this token:',
      pnl.drop.join(', '), '',
      'Do not infer or estimate these. If asked, say they are outside your access.', '');
  }

  lines.push(
    '## Reading the numbers correctly', '',
    '- A null means the sheet cell was empty. It does not mean zero.',
    '- Only complete days are reported. Today is never included.',
    '- `as_of` is the newest day with real data, never a future date.',
    '- P&L figures are the consolidated TOTAL across countries, not one market.',
    '- percent fields are percentage points: 2.7 means 2.7%.',
    '');

  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(200).send(lines.join('\n'));
};
