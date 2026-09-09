/* =========================================================================
   DiggerLid dashboard — shared core (period math, aggregation, breakeven,
   sparkline). Single source of truth used by all three pages + unit-tested by
   source/test_core.js. Loaded before the page scripts; each page destructures
   what it needs:  const {aggregate, breakeven, periodSlices, ...} = DLcore;
   ========================================================================= */
var DLcore = (function () {
  const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const isoToNice = iso => { const [, m, d] = iso.split('-').map(Number); return d + ' ' + MONTH_ABBR[m-1]; };
  function fmtRange(aISO, bISO) {
    const a = aISO.split('-').map(Number), b = bISO.split('-').map(Number);
    const am = MONTH_ABBR[a[1]-1], bm = MONTH_ABBR[b[1]-1];
    return am === bm ? `${a[2]}–${b[2]} ${bm}` : `${a[2]} ${am} – ${b[2]} ${bm}`;
  }
  /* Rolling mean over the last n points.

     `lead` is the number of values at the START of arr that exist only to feed
     the window and are dropped from the result. Without it the first plotted
     point is a 1-point "average" — on the 30-day revenue view that made the
     first point of the "7-day avg" line 73% too high, and the next five too
     short — because the window has nothing to its left to average. Callers that
     have earlier data should pass it in and say how much was lead-in. */
  const rollingAvg = (arr, n, lead = 0) => {
    const out = arr.map((_, i) => {
      const s = arr.slice(Math.max(0, i-n+1), i+1).filter(v => v != null);
      return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
    });
    return lead > 0 ? out.slice(lead) : out;
  };

  // Trailing period slices over a daily array. latest = index of the anchor day
  // (yesterday). off = how many whole periods back. CLAMPED so it can never
  // slice before the start of the data (this is what the bug fix centralises).
  function periodSlices(daily, latest, P, off) {
    const maxOff = Math.max(0, Math.floor(latest / P));
    const o = Math.min(Math.max(0, off || 0), maxOff);
    const end = latest - o * P;
    const cur = daily.slice(Math.max(0, end - P + 1), end + 1);
    const pe = end - P + 1;                                   // prior-period end (exclusive)
    const prev = pe > 0 ? daily.slice(Math.max(0, end - 2*P + 1), pe) : [];
    return { cur, prev, off: o, end, maxOff };
  }

  /* Which metric groups this run of days is still waiting on, and how many days
     are affected. api/data.js flags a day as pending when an input it needs has
     not been typed into the sheet yet (see PENDING vs ZERO there). A window that
     contains such a day cannot report those metrics as final, so the flag has to
     survive aggregation rather than being averaged away. */
  function pendingOf(list) {
    const groups = new Set(); const dates = [];
    (list || []).forEach(d => {
      if (!d || !d.pending || !d.pending.length) return;
      d.pending.forEach(g => groups.add(g));
      dates.push(d.date);
    });
    if (!dates.length) return null;
    const of = (list || []).length;
    return { groups: [...groups], dates, days: dates.length, of, share: of ? dates.length / of : 1 };
  }
  const isPending = (rec, group) =>
    !!(rec && rec.pending && rec.pending.groups && rec.pending.groups.indexOf(group) >= 0);

  /* How much of a window is missing decides how to present it, because hiding a
     number and showing a wrong one are both failures.

     One unfilled day in three is a third of the window — the 3-day MER read
     23.6% when it was really ~35.4%, so the figure is not worth showing. One in
     thirty moves the 30-day MER by under a point: suppressing that throws away a
     usable number to guard against a rounding error. So above a third, blank it;
     below, show it and say how much is outstanding.

     Returns 'blank' | 'qualify' | null. */
  const SUPPRESS_ABOVE = 1/3;
  function pendingMode(rec, group) {
    if (!isPending(rec, group)) return null;
    const p = rec.pending;
    if (p.of <= 1 || p.share >= SUPPRESS_ABOVE) return 'blank';
    return 'qualify';
  }
  // "1 of 30 days pending" — the qualifier that travels with a shown value.
  function pendingLabel(rec) {
    const p = rec && rec.pending;
    if (!p) return '';
    return p.of > 1 ? `${p.days} of ${p.of} days pending` : 'not yet entered';
  }

  // Aggregate a run of records (daily or monthly) into one windowed record:
  // sums for flows, re-computed ratios for rates. Returns null for an empty list.
  function aggregate(list) {
    if (!list || !list.length) return null;
    const S_ = k => list.reduce((a, d) => a + (d[k] || 0), 0);
    const pending = pendingOf(list);
    const revenue=S_('revenue'), revExGst=S_('revExGst'), orders=S_('orders'), newOrders=S_('newOrders'),
      items=S_('items'), sessions=S_('sessions'), metaNew=S_('metaNew'), metaTotal=S_('metaTotal'),
      google=S_('google'), tiktok=S_('tiktok'), totalAds=S_('totalAds'), prodCost=S_('prodCost'),
      totalVC=S_('totalVC'), totalFC=S_('totalFC'), returns=S_('returns'), totalExp=S_('totalExp'),
      profit=S_('profit'), fcRev=S_('fcRev'), projSpend=S_('projSpend'), fcProfit=S_('fcProfit');
    const d = (n, den) => den ? n / den : null;
    return {
      date: list[list.length-1].date, dow: '', label: '', pending,
      revenue, revExGst, orders, newOrders, items, sessions, metaNew, metaTotal, google, tiktok,
      totalAds, prodCost, totalVC, totalFC, returns, totalExp, profit, fcRev, projSpend, fcProfit,
      aov: d(revenue, orders), cvr: d(orders, sessions) * 100, newPct: d(newOrders, orders) * 100,
      ipo: d(items, orders), cpv: d(totalAds, sessions), rpv: d(revenue, sessions), cpp: d(totalAds, orders),
      ncpa: d(metaNew, newOrders), mer: d(totalAds, revenue) * 100,
      /* mer3 is the sheet's 3-day rolling MER. Over an aggregated window that
         has no meaning, and returning plain MER under the name mer3 invited a
         future caller to plot "3-day rolling" and get something else. Null is
         the honest answer; nothing currently displays it. */
      mer3: null,
      roas: d(revenue, totalAds), profitPct: d(profit, revenue) * 100, vcr: d(totalVC, revenue) * 100,
      fcr: d(totalFC, revenue) * 100,
      /* GST as a rate on the net amount, matching the sheet's own GST % row.
         Over gross this returned 8.17% where the sheet said 8.90% for the same
         day — the same tax expressed against a different base. */
      gstPct: d(revenue - revExGst, revExGst) * 100,
      returnsPct: d(returns, revenue) * 100
    };
  }

  // Breakeven MER: profit b/e = (RevExGST − Var − Fixed)/Rev; cash b/e = (RevExGST − Var)/Rev.
  // Zone g (scale) if MER ≤ profit b/e, a (hold) if ≤ cash b/e, else b (pull back).
  function breakeven(rec) {
    // Never derive a Scale / Hold / Pull-back signal from ad spend that has not
    // been entered. With the missing day counted as zero this returned "Scale"
    // — spend more — on a window whose real MER was 12 points into "Hold".
    if (isPending(rec, 'adSpend')) return null;
    const rev = rec.revenue, exg = (rec.revExGst != null ? rec.revExGst : rev),
      vc = rec.totalVC || 0, fc = rec.totalFC || 0,
      mer = (rec.mer != null ? rec.mer : (rev ? rec.totalAds / rev * 100 : null));
    if (!rev || mer == null) return null;
    const full = (exg - vc - fc) / rev * 100, contrib = (exg - vc) / rev * 100;
    const zone = mer <= full ? 'g' : mer <= contrib ? 'a' : 'b';
    return { full, contrib, mer, headroom: full - mer, zone,
      signal: zone === 'g' ? 'Scale' : zone === 'a' ? 'Hold' : 'Pull back' };
  }

  // Sparkline: current period (bright yellow) overlaid with the prior period (faded grey), shared scale.
  function sparkline(canvas, cur, prev) {
    cur = (cur || []).filter(v => v != null); prev = prev ? prev.filter(v => v != null) : null;
    if (!cur.length) return;
    const c = canvas.getContext('2d'), w = canvas.width = canvas.clientWidth * 2, h = canvas.height = canvas.clientHeight * 2;
    const all = (prev && prev.length) ? cur.concat(prev) : cur, min = Math.min(...all), max = Math.max(...all), rng = (max - min) || 1;
    const yof = v => h - ((v - min) / rng) * (h * 0.76) - h * 0.12;
    c.clearRect(0, 0, w, h);
    const line = (v, col, wd, dot) => { if (!v.length) return; c.beginPath();
      v.forEach((val, i) => { const x = (i / (v.length - 1 || 1)) * w, y = yof(val); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.strokeStyle = col; c.lineWidth = wd; c.lineJoin = 'round'; c.stroke();
      if (dot) { c.beginPath(); c.arc(w - 4, yof(v[v.length-1]), 5, 0, 7); c.fillStyle = col; c.fill(); } };
    if (prev && prev.length) line(prev, 'rgba(179,171,172,0.5)', 3, false);
    line(cur, 'rgba(245,235,25,0.95)', 3.6, true);
  }

  return { MONTH_ABBR, isoToNice, fmtRange, rollingAvg, periodSlices, aggregate, breakeven, sparkline,
           pendingOf, isPending, pendingMode, pendingLabel, SUPPRESS_ABOVE };
})();

if (typeof window !== 'undefined') window.DLcore = DLcore;                       // browser
if (typeof module !== 'undefined' && module.exports) module.exports = DLcore;    // node (unit test)
