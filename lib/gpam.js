/* =========================================================================
   DiggerLid — GPAM: Gross Profit After Marketing.

   The bonus base. Everything the trading and marketing team can move sits
   ABOVE the line and is inside GPAM; everything they cannot — people, vehicles,
   software, the office — sits BELOW it and is excluded. Modelled on the
   Wipertech workbook (net revenue → COGS → gross profit → advertising →
   contribution margin → marketing overhead → GPAM), read against this
   business's own P&L rows.

     Gross sales (inc GST)
       − GST                                   → Revenue ex GST
       − Returns                               → NET REVENUE
       − COGS layer: product, shipping, 3PL, packaging, transaction + merchant fees
                                               → GROSS PROFIT
       − Advertising: Meta, Google, TikTok      → CONTRIBUTION MARGIN
       − Marketing overhead: consultants, content & creative
                                               → GPAM
       − Below the line: salaries, software, office & operating (incl. vehicles)
                                               → PROFIT (ties to the sheet)

   Pure functions over daily P&L rows, so the page and the tests share one
   implementation. No DOM, no fetch.
   ========================================================================= */
const DLgpam = (() => {
  const S = (rows, k) => rows.reduce((a, r) => a + (+r[k] || 0), 0);
  const has = (rows, k) => rows.some(r => r[k] != null && r[k] !== '');
  const pct = (n, d) => d ? n / d * 100 : null;

  /* The lines, by layer, with the sheet field each reads. */
  const COGS = [
    ['prodCost',  'Product cost'],
    ['shipCost',  'Shipping'],
    ['pickPack',  'Pick & pack (3PL)'],
    ['packaging', 'Packaging'],
    ['txnFees',   'Transaction fees'],
    ['merchFees', 'Merchant fees'],
  ];
  const ADS = [
    ['metaTotal', 'Meta'],
    ['google',    'Google'],
    ['tiktok',    'TikTok'],
  ];
  const OVERHEAD = [
    ['mktConsult', 'Marketing consultants'],
    ['creative',   'Content & creative'],
  ];
  const BTL = [
    ['salaries', 'Salaries & contractors'],
    ['software', 'Subscriptions & software'],
    ['office',   'Office & operating (incl. vehicles)'],
  ];

  /* A layer's lines summed, with the sheet's own total preferred when it has
     one: the sheet may carry a line the dashboard has no field for, and the
     difference is shown as "other" rather than lost. */
  function layer(rows, lines, totalKey) {
    const items = lines.map(([k, label]) => ({ key: k, label, value: S(rows, k), present: has(rows, k) }));
    const partSum = items.reduce((a, i) => a + i.value, 0);
    const total = totalKey && has(rows, totalKey) ? S(rows, totalKey) : partSum;
    const other = Math.abs(total - partSum) > 1 ? total - partSum : 0;
    return { items, total, other, partSum };
  }

  /* Every layer for a set of rows. `opts.overheadPerDay` is a declared daily
     marketing-overhead figure for a book whose sheet has no such line yet. */
  function layers(rows, opts) {
    opts = opts || {};
    rows = (rows || []).filter(r => r && r.revenue > 0);
    const days = rows.length;
    const grossSales = S(rows, 'revenue');
    const revExGst = has(rows, 'revExGst') ? S(rows, 'revExGst') : grossSales / 1.1;
    const gst = grossSales - revExGst;
    const returns = S(rows, 'returns');
    const netRevenue = revExGst - returns;
    const cogs = layer(rows, COGS, 'totalVC');
    const grossProfit = netRevenue - cogs.total;
    const ads = layer(rows, ADS, 'totalAds');
    const cm = grossProfit - ads.total;
    const oh = layer(rows, OVERHEAD, null);
    const declared = (opts.overheadPerDay || 0) * days;
    const overhead = { items: oh.items, sheet: oh.total, declared, total: oh.total + declared,
                       inSheet: oh.items.some(i => i.present) };
    const gpam = cm - overhead.total;
    const btl = layer(rows, BTL, 'totalFC');
    const profit = gpam - btl.total;
    const sheetProfit = has(rows, 'profit') ? S(rows, 'profit') : null;
    return {
      days, grossSales, gst, revExGst, returns, netRevenue,
      cogs, grossProfit, gmPct: pct(grossProfit, netRevenue),
      ads, adsPct: pct(ads.total, netRevenue), mer: ads.total ? grossSales / ads.total : null,
      cm, cmPct: pct(cm, netRevenue),
      overhead, ohPct: pct(overhead.total, netRevenue),
      gpam, gpamPct: pct(gpam, netRevenue),
      btl, btlPct: pct(btl.total, netRevenue),
      profit, profitPct: pct(profit, netRevenue),
      sheetProfit,
      /* The sheet's PROFIT is revenue ex GST less every expense and ignores the
         returns line; ours subtracts returns and any declared overhead, so the
         two differ by exactly those. Stated so nobody hunts for the gap. */
      profitGap: sheetProfit == null ? null : profit - sheetProfit,
    };
  }

  /* Waterfall steps with running totals: kind 'total' bars sit on zero,
     'minus' bars float between the running total before and after. The ghost
     steps after GPAM show where profit lands, so the bonus base and the sheet's
     bottom line are one picture. */
  function waterfall(L) {
    const steps = [];
    let run = 0;
    const total = (key, label, v) => { run = v; steps.push({ key, label, kind: 'total', from: 0, to: v, value: v }); };
    const minus = (key, label, v, ghost) => { const from = run; run = run - v; steps.push({ key, label, kind: ghost ? 'ghost' : 'minus', from: Math.min(from, run), to: Math.max(from, run), value: -v }); };
    total('grossSales', 'Gross sales', L.grossSales);
    minus('gst', 'GST', L.gst);
    if (L.returns) minus('returns', 'Returns', L.returns);
    total('netRevenue', 'Net revenue', L.netRevenue);
    minus('cogs', 'COGS', L.cogs.total);
    total('grossProfit', 'Gross profit', L.grossProfit);
    minus('ads', 'Advertising', L.ads.total);
    total('cm', 'Contribution', L.cm);
    minus('overhead', 'Mkt overhead', L.overhead.total);
    total('gpam', 'GPAM', L.gpam);
    minus('btl', 'Below the line', L.btl.total, true);
    steps.push({ key: 'profit', label: 'Profit', kind: 'ghost-total', from: Math.min(0, L.profit), to: Math.max(0, L.profit), value: L.profit });
    return steps;
  }

  /* Why GPAM moved. Exact decomposition of ΔGPAM into four effects:
       volume        (NR_now − NR_then) × GPAM%_then
       gross margin  (GM%_now − GM%_then) × NR_now
       advertising  −(Ads%_now − Ads%_then) × NR_now
       overhead     −(OH%_now − OH%_then) × NR_now
     which sum to NR_now·GPAM%_now − NR_then·GPAM%_then to the cent. */
  function bridge(now, then) {
    if (!now || !then || !then.netRevenue) return null;
    const r = k => (now[k] || 0) / 100, p = k => (then[k] || 0) / 100;
    const volume = (now.netRevenue - then.netRevenue) * p('gpamPct');
    const margin = (r('gmPct') - p('gmPct')) * now.netRevenue;
    const ads = -(r('adsPct') - p('adsPct')) * now.netRevenue;
    const overhead = -(r('ohPct') - p('ohPct')) * now.netRevenue;
    const delta = now.gpam - then.gpam;
    return {
      delta, items: [
        { key: 'volume',   label: 'Net revenue volume',    value: volume,   note: `${fmtPct(then.gpamPct)} GPAM on ${sign(now.netRevenue - then.netRevenue)} revenue` },
        { key: 'margin',   label: 'Gross margin rate',     value: margin,   note: `${fmtPct(then.gmPct)} → ${fmtPct(now.gmPct)}` },
        { key: 'ads',      label: 'Advertising rate',      value: ads,      note: `${fmtPct(then.adsPct)} → ${fmtPct(now.adsPct)} of net revenue` },
        { key: 'overhead', label: 'Marketing overhead',    value: overhead, note: `${fmtPct(then.ohPct)} → ${fmtPct(now.ohPct)}` },
      ],
      residual: delta - (volume + margin + ads + overhead),
    };
  }
  const fmtPct = v => v == null ? '—' : v.toFixed(1) + '%';
  const sign = v => (v >= 0 ? '+' : '−') + '$' + Math.round(Math.abs(v)).toLocaleString('en-AU');

  /* ---------------------------------------------------------- periods */
  const addDays = (iso, n) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const yearBack = iso => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCFullYear(t.getUTCFullYear() - 1); return t.toISOString().slice(0, 10); };
  const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const FY_START = 7;   // 1 July

  /* Windows end on `anchor` (the last complete day). Comparison is always the
     same dates a year earlier — a bonus base is judged against last year. */
  function period(win, anchor) {
    const y = +anchor.slice(0, 4), m = +anchor.slice(5, 7);
    const fyStartYear = m >= FY_START ? y : y - 1;
    let start, end = anchor, label;
    if (win === 'MTD') { start = anchor.slice(0, 7) + '-01'; label = 'Month to date'; }
    else if (win === 'LM') {
      const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
      start = `${py}-${String(pm).padStart(2, '0')}-01`; end = `${py}-${String(pm).padStart(2, '0')}-${dim(py, pm)}`; label = 'Last month';
    }
    else if (win === 'QTD') {
      const qStartMonth = FY_START + Math.floor(((m - FY_START + 12) % 12) / 3) * 3;
      const qm = ((qStartMonth - 1) % 12) + 1, qy = qm > m ? y - 1 : y;
      start = `${qy}-${String(qm).padStart(2, '0')}-01`; label = 'Quarter to date';
    }
    else if (win === 'FYTD') { start = `${fyStartYear}-07-01`; label = `FY${String(fyStartYear + 1).slice(2)} to date`; }
    else if (win === '12M') { start = addDays(anchor, -364); label = 'Last 12 months'; }
    else if (/^\d{4}-\d{2}$/.test(win)) { const yy = +win.slice(0, 4), mm = +win.slice(5, 7); start = win + '-01'; end = `${win}-${dim(yy, mm)}`; if (end > anchor) end = anchor; label = win; }
    else { start = anchor.slice(0, 7) + '-01'; label = 'Month to date'; }
    return { win, start, end, label, prev: { start: yearBack(start), end: yearBack(end) }, fyStartYear };
  }
  const inRange = (r, rg) => r.date >= rg.start && r.date <= rg.end;
  const expectedDays = rg => Math.round((Date.parse(rg.end + 'T00:00:00Z') - Date.parse(rg.start + 'T00:00:00Z')) / 86400000) + 1;
  /* A comparison is offered only when the prior window is at least 90%
     populated; a stub of last year is not last year. */
  function coverage(rows, rg) { const n = rows.filter(r => inRange(r, rg) && r.revenue > 0).length; return { n, expected: expectedDays(rg), ok: n >= Math.ceil(expectedDays(rg) * 0.9) }; }

  /* FY months for the table: every month from 1 July to the anchor's month. */
  function fyMonths(anchor) {
    const y = +anchor.slice(0, 4), m = +anchor.slice(5, 7);
    const fyStartYear = m >= FY_START ? y : y - 1;
    const out = [];
    for (let i = 0; i < 12; i++) {
      const mm = ((FY_START - 1 + i) % 12) + 1, yy = fyStartYear + (FY_START - 1 + i >= 12 ? 1 : 0);
      const ym = `${yy}-${String(mm).padStart(2, '0')}`;
      if (ym > anchor.slice(0, 7)) break;
      out.push(ym);
    }
    return out;
  }

  return { COGS, ADS, OVERHEAD, BTL, FY_START, layers, waterfall, bridge, period, coverage, fyMonths, inRange, addDays, yearBack, expectedDays };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DLgpam;
if (typeof window !== 'undefined') window.DLgpam = DLgpam;
