/* =========================================================================
   DiggerLid — Meta spend ↔ revenue.

   How connected ad spend, revenue, MER and profit actually are, measured on
   this book's own daily P&L rows rather than asserted. Pure functions, no DOM
   and no fetch, so spend.js and source/test_spend.js share one implementation.

   Three things this file is careful about, because each of them is a way to be
   confidently wrong on a dashboard:

   1. THE SHEET'S `mer` COLUMN IS NOT MER. It holds totalAds / revenue — an ad
      COST RATIO (26.7%), the reciprocal of the media efficiency ratio (3.75x).
      The sheet's `roas` column is the true MER. The naming is live in the data
      and cannot be fixed from here, so both numbers are computed from the raw
      sums and named for what they are: `adPct` and `mer`.

   2. PROFIT'S OWN IDENTITY DECIDES BREAK-EVEN. Checked against the book:
      profit = revExGst - totalVC - totalAds - totalFC, to the cent over the
      last 90 days and within $1.07 over all 527. `returns` is already carried
      inside those lines and subtracting it again double-counts, which is what
      pulled an earlier read of break-even MER to 2.63x when the book says
      3.27x. Break-even is derived from that identity, not re-stated.

   3. CORRELATION IS NOT CAUSE. High-spend weeks are also peak-demand weeks, so
      `bands` is explicitly descriptive and every statistic carries its n. A
      band of two weeks is not a band, so the band count steps down with the
      window rather than quietly splitting twelve weeks five ways.
   ========================================================================= */
const DLspend = (() => {
  const S = (rows, k) => (rows || []).reduce((a, r) => a + (+r[k] || 0), 0);
  const fin = n => typeof n === 'number' && isFinite(n);

  /* ---------------------------------------------------------- statistics */

  /* Ordinary least squares plus Pearson's r, in one pass over the pairs.
     Returns null rather than a NaN-filled object when there is nothing to fit:
     under three points, or a series with no spread (every week the same spend
     has no slope, and dividing by its zero variance would invent one). */
  function ols(xs, ys) {
    const n = Math.min((xs || []).length, (ys || []).length);
    const X = [], Y = [];
    for (let i = 0; i < n; i++) if (fin(xs[i]) && fin(ys[i])) { X.push(xs[i]); Y.push(ys[i]); }
    if (X.length < 3) return null;
    const m = X.length;
    const mx = X.reduce((a, b) => a + b, 0) / m, my = Y.reduce((a, b) => a + b, 0) / m;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < m; i++) { const dx = X[i] - mx, dy = Y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    if (!sxx || !syy) return null;
    const slope = sxy / sxx, r = sxy / Math.sqrt(sxx * syy);
    return { n: m, slope, intercept: my - slope * mx, r, r2: r * r, meanX: mx, meanY: my };
  }
  const corr = (xs, ys) => { const f = ols(xs, ys); return f ? f.r : null; };

  /* Whole weeks only. A trailing 3-day stub aggregates into a "week" with half
     the spend of its neighbours, and as a point in a 12-week fit that stub has
     the leverage of a real observation — it dragged the 90-day slope by more
     than a dollar of revenue per dollar of spend. `days` comes from
     core.weeklyBuckets, which marks the short one. */
  const wholeWeeks = weeks => (weeks || []).filter(w => w && (w.days == null || w.days === 7));

  /* ---------------------------------------------------------- unit economics

     Everything here is a consequence of the profit identity above, so the page
     cannot show a break-even that disagrees with the profit it prints beside it.

       mer        revenue / ad spend                      — the real one
       adPct      ad spend / revenue                      — the sheet's "mer"
       beMer      the MER at which profit is exactly zero (fixed costs included)
       beCashMer  the MER at which the NEXT dollar of spend breaks even. Fixed
                  costs do not move with spend, so a marginal dollar only has to
                  clear the contribution margin. It is the floor for "should we
                  spend more", and it is always the kinder of the two.
       headroom   how far ad spend could rise, revenue held still, before profit
                  reaches zero. Held still is the pessimistic case by design —
                  spend that buys nothing. */
  function economics(rows) {
    const revenue = S(rows, 'revenue'), exGst = S(rows, 'revExGst'), vc = S(rows, 'totalVC'),
          fc = S(rows, 'totalFC'), ads = S(rows, 'totalAds'), meta = S(rows, 'metaTotal'),
          profit = S(rows, 'profit'), days = (rows || []).length;
    if (!revenue || !days) return null;
    const contribution = exGst - vc;            // what a revenue dollar leaves for ads + fixed
    const adsAtBreakeven = contribution - fc;   // ad spend that would take profit to exactly zero
    return {
      days, revenue, exGst, vc, fc, ads, meta, profit,
      metaShare: ads ? meta / ads * 100 : null,
      mer: ads ? revenue / ads : null,
      adPct: ads ? ads / revenue * 100 : null,
      gstPct: (revenue - exGst) / revenue * 100,
      vcPct: vc / revenue * 100,
      fcPct: fc / revenue * 100,
      contribution, contributionPct: contribution / revenue * 100,
      profitPct: profit / revenue * 100,
      /* Positive contribution is what makes a break-even MER exist at all. With
         variable costs above ex-GST revenue there is no amount of advertising
         that pays for itself, and a number here would read as one. */
      beMer: adsAtBreakeven > 0 ? revenue / adsAtBreakeven : null,
      beAdPct: adsAtBreakeven > 0 ? adsAtBreakeven / revenue * 100 : null,
      beCashMer: contribution > 0 ? revenue / contribution : null,
      beCashAdPct: contribution > 0 ? contribution / revenue * 100 : null,
      headroom: adsAtBreakeven - ads,
      /* Scale / hold / pull back, on the same three zones the rest of the board
         uses — but stated in MER, where higher is better, so the comparison
         runs the opposite way to core.breakeven's cost-ratio version. */
      zone: !(adsAtBreakeven > 0) ? 'b' : ads <= adsAtBreakeven ? 'g' : ads <= contribution ? 'a' : 'b',
    };
  }
  const ZONE_SIGNAL = { g: 'Profitable', a: 'Covers variable costs', b: 'Below cash break-even' };

  /* ---------------------------------------------------------- the link

     Daily and weekly are both reported because they answer different questions
     and the gap between them IS a finding: a single day's revenue is dominated
     by the day of the week, and pooling seven of them lifts r from ~0.77 to
     ~0.90 without any new information. Weekly is the honest read of how tightly
     the two move; daily is the one that looks noisy to someone watching a chart.

     `elasticity` is the slope of log revenue on log spend over whole weeks: the
     percentage of revenue bought by a percentage of spend. Below 1 means
     diminishing returns — the measurement the "just spend more" argument has to
     get past. It needs enough weeks to mean anything, so under MIN_ELASTIC it
     is withheld rather than printed with a wide interval nobody can see. */
  const MIN_ELASTIC = 12;
  function link(rows, weeks) {
    const d = (rows || []).filter(r => r && fin(+r.totalAds) && fin(+r.revenue));
    const w = wholeWeeks(weeks);
    const daily = ols(d.map(r => +r.totalAds), d.map(r => +r.revenue));
    const weekly = ols(w.map(r => +r.totalAds), w.map(r => +r.revenue));
    const profit = ols(w.map(r => +r.totalAds), w.map(r => +r.profit));
    let elastic = null;
    if (w.length >= MIN_ELASTIC) {
      const pos = w.filter(r => +r.totalAds > 0 && +r.revenue > 0);   // log of zero is not a point
      elastic = ols(pos.map(r => Math.log(+r.totalAds)), pos.map(r => Math.log(+r.revenue)));
    }
    return { daily, weekly, profit, elastic, weeks: w.length, days: d.length, minElastic: MIN_ELASTIC };
  }

  /* Does today's spend show up tomorrow? Revenue k days after the spend,
     against the spend. If the answer were yes, every MER on this board — all of
     which divide same-day revenue by same-day spend — would be mismatched.
     Each lag drops k pairs off the end, so n is reported with every r. */
  function lagProfile(rows, maxLag) {
    const d = (rows || []).filter(r => r && fin(+r.totalAds) && fin(+r.revenue));
    const out = [];
    for (let k = 0; k <= (maxLag == null ? 3 : maxLag); k++) {
      const x = [], y = [];
      for (let i = 0; i + k < d.length; i++) { x.push(+d[i].totalAds); y.push(+d[i + k].revenue); }
      out.push({ lag: k, r: corr(x, y), n: x.length });
    }
    return out;
  }

  /* ---------------------------------------------------------- spend bands

     Weeks sorted by spend and cut into equal groups, each aggregated whole
     (sums, then ratios) rather than averaging the weeks' own ratios — which
     would weight a quiet week the same as a peak one.

     The band count steps down with the window because five bands over twelve
     weeks is five pairs, and a "band" of two weeks moves entirely on which two.
     Under MIN_BAND_WEEKS weeks there is no honest cut and this returns null, so
     the page can say that instead of drawing something. */
  const MIN_BAND_WEEKS = 9;
  const bandCount = n => n >= 40 ? 5 : n >= 20 ? 4 : n >= MIN_BAND_WEEKS ? 3 : 0;
  const BAND_NAMES = {
    3: ['Low spend', 'Mid spend', 'High spend'],
    4: ['Lowest', 'Low-mid', 'High-mid', 'Highest'],
    5: ['Lowest fifth', 'Low fifth', 'Middle fifth', 'High fifth', 'Highest fifth'],
  };
  function bands(weeks) {
    const w = wholeWeeks(weeks).filter(x => +x.totalAds > 0 && +x.revenue > 0);
    const q = bandCount(w.length);
    if (!q) return null;
    const sorted = [...w].sort((a, b) => (+a.totalAds) - (+b.totalAds));
    const per = Math.floor(sorted.length / q);
    const out = [];
    for (let i = 0; i < q; i++) {
      const slice = sorted.slice(i * per, i === q - 1 ? sorted.length : (i + 1) * per);
      const revenue = S(slice, 'revenue'), ads = S(slice, 'totalAds'), profit = S(slice, 'profit'),
            meta = S(slice, 'metaTotal'), n = slice.length;
      out.push({
        name: BAND_NAMES[q][i], rank: i + 1, of: q, n,
        spendPerWeek: ads / n, metaPerWeek: meta / n, revenuePerWeek: revenue / n, profitPerWeek: profit / n,
        revenue, ads, profit,
        mer: ads ? revenue / ads : null,
        adPct: revenue ? ads / revenue * 100 : null,
        marginPct: revenue ? profit / revenue * 100 : null,
        from: slice[0].totalAds, to: slice[slice.length - 1].totalAds,
      });
    }
    return { bands: out, q, weeks: w.length, minWeeks: MIN_BAND_WEEKS };
  }

  return { ols, corr, economics, link, lagProfile, bands, wholeWeeks,
           bandCount, ZONE_SIGNAL, MIN_ELASTIC, MIN_BAND_WEEKS, sum: S };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = DLspend;
if (typeof window !== 'undefined') window.DLspend = DLspend;
