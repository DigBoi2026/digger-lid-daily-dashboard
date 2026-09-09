/* =========================================================================
   /api/ai/schema  —  the field dictionary.

   The raw routes return keys like `mer3`, `ncpa`, `vcr` and `rpv`. Without this
   an agent is guessing at what it is summarising. Fields the caller's scope
   withholds are omitted rather than described, so the dictionary matches the
   rows the caller will actually receive.
   ========================================================================= */
const A = require('../../lib/ai-access.js');
const { DATASETS } = require('../../lib/ai-schema.js');
const { guard, noStore } = require('./_guard.js');

module.exports = async (req, res) => {
  const caller = guard(req, res);
  if (!caller) return;

  const want = req.query && req.query.dataset;
  const pnl = A.pnlFilter(caller.scopes);
  const dropped = new Set(pnl.denied ? [] : pnl.drop);

  const visible = (key, def) => {
    if (!def.scopes.some(s => caller.scopes.includes(s))) return null;
    const out = {
      dataset: key, title: def.title, grain: def.grain, source: def.source,
      currency: def.currency || null, notes: def.notes || [],
    };
    if (def.fields) {
      out.fields = {};
      for (const [k, f] of Object.entries(def.fields)) if (!dropped.has(k)) out.fields[k] = f;
      out.fields_withheld = Object.keys(def.fields).filter(k => dropped.has(k));
    }
    return out;
  };

  if (want) {
    const def = DATASETS[want];
    if (!def) return res.status(404).json({ error: 'unknown_dataset', detail: want, known: Object.keys(DATASETS) });
    const v = visible(want, def);
    if (!v) return res.status(403).json({ error: 'forbidden', detail: `"${want}" needs one of: ${def.scopes.join(', ')}` });
    noStore(res);
    return res.status(200).json(v);
  }

  const all = {};
  for (const [k, d] of Object.entries(DATASETS)) { const v = visible(k, d); if (v) all[k] = v; }
  noStore(res);
  res.status(200).json({
    units: {
      aud: 'Australian dollars', count: 'whole number', ratio: 'unitless multiple',
      percent: 'percentage points, so 2.7 means 2.7%', date: 'ISO-8601 date', text: 'free text',
    },
    datasets: all,
  });
};
