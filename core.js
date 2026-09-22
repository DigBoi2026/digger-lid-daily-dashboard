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
  /* The same dates a year earlier, for a "vs last year" comparison. Prior rows
     come from the 2025 book (prior_year.js), which has gaps (Feb–Apr 2025), so
     coverage is reported and a window under 90% covered is not offered as a
     comparison — a stub of last year is not last year. */
  const yearBack = iso => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCFullYear(t.getUTCFullYear() - 1); return t.toISOString().slice(0, 10); };
  function sameDatesLastYear(cur, priorRows) {
    const by = new Map(); (priorRows || []).forEach(r => { if (r && r.date && r.revenue > 0) by.set(r.date, r); });
    const rows = []; (cur || []).forEach(d => { const r = d && d.date ? by.get(yearBack(d.date)) : null; if (r) rows.push(r); });
    const expected = (cur || []).length;
    return { rows, covered: rows.length, expected, ok: expected > 0 && rows.length >= Math.ceil(expected * 0.9) };
  }

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

  /* ------------------------------------------------------------------------
     WINDOWED BASELINES — the Pulse page's "day vs its own history", generalised
     to a window of N days ending at index i.

     y is the window's pooled value: a plain mean for a flow, or Σ(value×den)/Σden
     for a rate that carries its denominators, so three days at different traffic
     pool like one longer day rather than averaging a quiet Sunday's rate with a
     busy Tuesday's as equals. The baselines sit BEFORE the window, not inside
     it: 3 days before its first day, up to 30 before it (needs 7), and the same
     N-day window in each of the previous four weeks. For N=1 this is exactly
     the single-day rule the page always had. */
  function windowBaselines(ser, i, win) {
    win = Math.max(1, win | 0);
    const start = i - win + 1;
    if (i < 0 || start < 0 || i >= ser.vals.length) return null;
    const pooled = (a, b) => {                       // indices a..b inclusive
      let num = 0, den = 0, n = 0, sum = 0;
      for (let k = a; k <= b; k++) {
        const v = ser.vals[k]; if (v == null) continue;
        if (ser.dens) { const d = ser.dens[k]; if (d == null || !d) continue; num += v * d; den += d; }
        else { sum += v; n++; }
      }
      if (ser.dens) return den ? { y: num / den, den } : { y: null, den: 0 };
      return { y: n ? sum / n : null, den: null };
    };
    const cur = pooled(start, i);
    const prevVals = (from, n) => { const out = []; for (let k = 1; k <= n; k++) { if (from - k < 0) break; out.push(ser.vals[from - k]); } return out; };
    const meanOf = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
    const b3 = meanOf(prevVals(start, 3));
    const w30 = prevVals(start, 30), n30 = w30.filter(v => v != null).length;
    const b30 = n30 >= 7 ? meanOf(w30) : null;
    const wk = [];
    for (let k = 1; k <= 4; k++) { const e = i - 7 * k; if (e - win + 1 >= 0) wk.push(pooled(e - win + 1, e).y); }
    const bwk = wk.filter(v => v != null).length >= 2 ? meanOf(wk) : null;
    return { y: cur.y, b3, b30, bwk, n30, den: cur.den, win, start };
  }

  /* The shop's day, not the viewer's. Shopify and the P&L both close their day
     on Australian Eastern Standard Time (the store reports AEST, no daylight
     saving), so "yesterday" is yesterday in Brisbane whoever is looking. */
  const AEST_TZ = 'Australia/Brisbane';
  function todayAEST(now) {
    const d = now || new Date();
    return new Intl.DateTimeFormat('en-CA', { timeZone: AEST_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  function previousDayAEST(now) {
    const t = todayAEST(now);
    const d = new Date(t + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  /* Days the sheet has not been given yet, filled from Shopify.

     Shopify's total_sales matches the P&L's revenue to the cent (checked day by
     day: 14,095.81 / 17,590.78 / 11,957.87 / 10,905.13), so for a day after the
     sheet's last entry the revenue and order count are not estimates — they are
     the same numbers a day early. Everything the sheet adds (sessions, costs,
     ad spend, profit) is absent, so those fields stay null and the row is
     flagged provisional, pending ad spend and profit like any half-entered day.
     A day the sheet already has is never overwritten. */
  function shopifyFill(sheetRows, recent, today) {
    const have = new Set((sheetRows || []).filter(r => r && r.date).map(r => r.date));
    const last = [...have].sort().pop() || '';
    const cut = today || todayAEST();                  // today is still trading: never a full day
    return (recent || [])
      .filter(r => r && r.date && r.date > last && r.date < cut && !have.has(r.date) && (r.total > 0 || r.orders > 0))
      .sort((a, b) => a.date < b.date ? -1 : 1)
      .map(r => ({
        date: r.date, revenue: r.total, orders: r.orders,
        aov: r.orders ? r.total / r.orders : null,
        provisional: 'shopify', pending: ['adSpend', 'profit'],
      }));
  }

  /* A long window drawn day by day is ninety bars nobody can read; drawn as
     thirteen weeks it is a shape. Chunks of seven from the window's FIRST day
     (so the buckets are the period's own weeks, not calendar weeks that would
     clip both ends), each aggregated the same way a window is — sums for
     flows, ratios recomputed — and dated by its first day. The last bucket may
     be short; it says so in `days`. */
  function weeklyBuckets(list) {
    const out = [];
    for (let i = 0; i < (list || []).length; i += 7) {
      const chunk = list.slice(i, i + 7);
      const rec = aggregate(chunk);
      if (!rec) continue;
      /* aggregate() sums (x || 0), so a field no day in the week carries comes
         out 0. Daily Ops reads "every day null" as "no forecast row", and a 0
         there would render as a zero target with every dollar an overspend —
         so a field that is null on every day of the week stays null. */
      const keys = new Set(); chunk.forEach(d => Object.keys(d).forEach(k => keys.add(k)));
      keys.forEach(k => { if (typeof rec[k] === 'number' && chunk.every(d => d[k] == null)) rec[k] = null; });
      rec.date = chunk[0].date; rec.days = chunk.length; rec.label = 'w/c ' + isoToNice(chunk[0].date);
      out.push(rec);
    }
    return out;
  }

  /* ---------------------------------------------------------- formatting

     These four lived in all eight page scripts and had drifted apart, which is
     worse than duplication: the same number rendered differently depending on
     which page you were looking at.

       money   four pages built the compact string from the SIGNED number
               ('$'+(n/1e3)), so a negative read "$-1.2K" — dollar sign before
               the minus. Two pages did it correctly off the absolute value.
               The correct one wins here.
       pct     two genuinely different jobs wearing one name: a level ("20.2%")
               and a signed delta ("+2.4%"). Kept apart as pct and pctSigned,
               because merging them would silently change the forecast page.
       esc     two variants; the null-safe one wins ("" rather than "null").

     Each page keeps its own DEFAULT for compactness and decimals via a one-line
     wrapper, so this change alters no page's output except the negative-sign
     fix above. */
  function money(n, compact = true) {
    if (n == null || isNaN(n)) return '\u2014';
    const a = Math.abs(n), s = n < 0 ? '-$' : '$';
    if (!compact) return s + Math.round(a).toLocaleString('en-AU');
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
    return s + Math.round(a);
  }
  const pct = (n, d = 1) => n == null || isNaN(n) ? '\u2014' : n.toFixed(d) + '%';
  const pctSigned = (n, d = 1) => n == null || isNaN(n) ? '\u2014' : (n > 0 ? '+' : '') + n.toFixed(d) + '%';
  const numf = n => n == null || isNaN(n) ? '\u2014' : Math.round(n).toLocaleString('en-AU');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------------------------------------------------- snapshot age

     Every committed snapshot is a fallback the board shows when the live route
     cannot be reached, and a fallback that cannot say how old it is will sit
     there looking current. region_data.js did exactly that: a hard-coded
     asOf of "2026-07-02" inside a builder with no network call at all, so it
     froze for eighty-one days and nothing on the page, in the watchdog, or in
     the build ever said a word.

     One contract, used by the pages, the builder and the watchdog: read
     meta.asOf (or meta.builtAt), say how old it is, and grade it. A snapshot
     that declares meta.static is closed by design (last year's book) and is
     never stale. */
  const SNAP_BUDGET = { fresh: 2, aging: 7 };
  /* `staleAfter` is how many days this PARTICULAR snapshot is allowed. A
     products history the page tops up live earns a longer leash than a geo
     fallback; passing it here keeps the chip on the page and the freshness gate
     in CI reading from one number instead of quietly disagreeing. */
  function snapshotAge(meta, now, staleAfter) {
    const m = meta || {};
    if (m.static === true) return { asOf: m.asOf || null, days: null, level: 'static', label: 'static by design' };
    /* Snapshots name their build date four different ways; accept all of them
       rather than let a file look ageless because it said builtOn. */
    const raw = m.asOf || m.builtAt || m.builtOn || m.snapshotDate || m.extractedOn || m.generatedAt || null;
    const asOf = raw ? String(raw).slice(0, 10) : null;
    if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      return { asOf: null, days: null, level: 'unknown', label: 'age not declared' };
    }
    const today = typeof now === 'string' ? now : todayAEST(now);
    const days = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(asOf + 'T00:00:00Z')) / 86400000);
    const limit = Number.isFinite(staleAfter) ? staleAfter : SNAP_BUDGET.aging;
    const level = days <= Math.min(SNAP_BUDGET.fresh, limit) ? 'fresh' : days <= limit ? 'aging' : 'stale';
    const label = days <= 0 ? 'today' : days === 1 ? '1 day old' : days + ' days old';
    return { asOf, days, level, label };
  }

  /* Put that age on the page, next to the live pill. Written as its own chip
     rather than into #liveText because every page's setLive() rewrites that
     text on each call and would wipe it. */
  function stampSnapshotAge(meta, now, staleAfter) {
    if (typeof document === 'undefined') return null;
    const pill = document.getElementById('livePill'); if (!pill) return null;
    let chip = pill.querySelector('.snapage');
    /* null clears it — a page that reaches the live route is no longer on the
       snapshot, so its age stops being the thing to say. */
    if (!meta) { if (chip) chip.remove(); return null; }
    const a = snapshotAge(meta, now, staleAfter);
    if (a.level === 'fresh' || a.level === 'static') { if (chip) chip.remove(); return a; }
    if (!chip) { chip = document.createElement('span'); chip.className = 'snapage'; pill.appendChild(chip); }
    chip.className = 'snapage ' + a.level;
    chip.textContent = a.level === 'unknown' ? '?' : a.label.replace(' days old', 'd').replace('1 day old', '1d');
    chip.title = a.asOf ? `Fallback snapshot built ${a.asOf} — ${a.label}. The live route is what refreshes it.`
                        : 'This snapshot does not declare when it was built.';
    return a;
  }

  return { MONTH_ABBR, isoToNice, fmtRange, rollingAvg, periodSlices, aggregate, breakeven, sparkline,
           pendingOf, isPending, pendingMode, pendingLabel, SUPPRESS_ABOVE,
           windowBaselines, todayAEST, previousDayAEST, shopifyFill, AEST_TZ, weeklyBuckets , yearBack, sameDatesLastYear,
           snapshotAge, stampSnapshotAge, SNAP_BUDGET,
           money, pct, pctSigned, numf, esc };
})();

if (typeof window !== 'undefined') window.DLcore = DLcore;                       // browser
if (typeof module !== 'undefined' && module.exports) module.exports = DLcore;    // node (unit test)
