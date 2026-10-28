/* =========================================================================
   DiggerLid — spend-led forecast (Oct 2026).

   One sentence:

       Revenue for a period = the same days last year
                            x today's year-on-year revenue growth
                            x (planned spend growth / today's spend growth) ^ e

   With e = 1 this is the same as: planned spend x today's MER x last year's
   change in MER between now and then. Profit then follows from the sheet's
   own identity: revenue x contribution rate - ad spend - fixed cost.

   WHY IT REPLACED THE SEASONAL ENGINE (forecast.js) FOR PLANNING
   ---------------------------------------------------------------
   Revenue here moves with ad spend: Aug/Sep/Oct 2026 revenue was x2.02 /
   x2.37 / x1.45 on last year while spend was x2.25 / x2.65 / x1.38. The
   seasonal engine learned its month index from one year of history, and that
   year's spend timing came with it: October 2025 spent 80% more than September
   and sold 64% more, so the engine read "October = +64%" as demand. In 2026
   spend was held flat, revenue stayed flat, and the engine over-forecast the
   30 days from 2026-09-25 by +22% (this model: -8%).

   Walk-forward from every day with a last year to lean on (origins 25 May -
   25 Sep 2026, refit at each, actual spend), MAPE (bias):

                               30 days         60 days         90 days
       seasonal engine         12.9% (-8%)     10.7% (-10%)     9.6% (-9%)
       this model, e = 1        9.1% (-4%)      9.4% (-8%)     11.1% (-10%)
       ... e = 0.5 / 1.25      11.5 / 10.9     11.7 / 10.4
       ... without spend (e=0) 17.9%           15.0%           14.4%

   Better at the one-to-two-month horizon it is used for, and since July far
   better (30 days: 6-8% against the engine's 10-24%). Worse around EOFY, where
   it ran 11-17% low, and slightly worse at 90 days: read the third month with
   more caution than the first. Both models under-forecast on average, which is
   why the scenario band below is skewed upward.

   Spend and last year's same days are the two inputs that matter. Everything
   else the engine carried measured at or near zero and is not here: prior-year
   smoothing (0.0 pts), the event-scaling threshold (0.0), day-of-week (whole
   weeks make it cancel), the growth trend (today's year-on-year ratio already
   is one), the shape-mode level, the observed ceiling and the monthly ad-rate
   index (spend is an input now, not a rate on revenue).

   Days are matched to last year 364 days back, so weekdays line up and so do
   Father's Day (first Sunday of September) and Black Friday. A fitted sale
   modifier is therefore not needed; only a CHANGE to a promotion is declared
   (see saleExtension).

   What it cannot do: forecast without a spend plan, or a period whose
   same-days-last-year are missing (Feb-Apr 2025 are not in the book). It was
   backtested through EOFY (June) but never through BFCM, because there is no
   2024 to backtest November 2025 from.
   ========================================================================= */
var DLforecastSimple = (function () {
  'use strict';

  const DEFAULTS = { window: 28, lag: 364, elasticity: 1, contribWindow: 90 };

  function addDays(iso, n) {
    const t = new Date(iso + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
  }

  /* Rows a forecast may learn from: a day the sheet has finished. A pending
     day has revenue typed and ad spend not yet, which would read as a free
     day of sales. */
  function index(rows) {
    const by = {};
    (rows || []).forEach(r => { if (r && r.date && r.revenue > 0 && !r.pending) by[r.date] = r; });
    return by;
  }
  function total(by, a, b, key) {
    let s = 0, n = 0;
    for (let d = a; d <= b; d = addDays(d, 1)) { const r = by[d]; if (r) { s += +r[key] || 0; n++; } }
    return { sum: s, days: n };
  }

  /* Revenue for one period [start, end] given its planned ad spend, as seen
     from `from` (the last finished day). Null when last year's days are not
     there to lean on: a guess dressed as a forecast is worse than a blank. */
  function period(by, from, start, end, spend, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const w0 = addDays(from, -(o.window - 1));
    const ly = d => addDays(d, -o.lag);
    const n = daysBetween(start, end);
    const rW = total(by, w0, from, 'revenue'), rWly = total(by, ly(w0), ly(from), 'revenue');
    const sW = total(by, w0, from, 'totalAds'), sWly = total(by, ly(w0), ly(from), 'totalAds');
    const rTly = total(by, ly(start), ly(end), 'revenue'), sTly = total(by, ly(start), ly(end), 'totalAds');
    if (rWly.days < o.window * 0.9 || rTly.days < n * 0.9 || !sW.sum || !sWly.sum || !sTly.sum) return null;
    const yoyRevenue = rW.sum / rWly.sum;
    const yoySpendNow = sW.sum / sWly.sum;
    const yoySpendPlan = spend / sTly.sum;
    const revenue = rTly.sum * yoyRevenue * Math.pow(yoySpendPlan / yoySpendNow, o.elasticity);
    return { start, end, days: n, spend, revenue, lastYearRevenue: rTly.sum, lastYearSpend: sTly.sum,
             yoyRevenue, yoySpendNow, yoySpendPlan, mer: spend ? revenue / spend : null };
  }

  /* Contribution rate, GST share and fixed cost, from the sheet's identity
     profit = revExGst - totalVC - totalAds - totalFC. Fixed cost is a staircase
     (salaries step up as people are hired), so the latest day is used, not a
     mean. The contribution rate barely moves with promotion: 44.7% through
     BFCM 2025 against 44.3% in the six weeks before it. */
  function rates(by, from, contribWindow) {
    const a = addDays(from, -((contribWindow || DEFAULTS.contribWindow) - 1));
    const rev = total(by, a, from, 'revenue').sum;
    if (!rev || !by[from]) return null;
    return {
      contrib: (total(by, a, from, 'revExGst').sum - total(by, a, from, 'totalVC').sum) / rev,
      exGst: total(by, a, from, 'revExGst').sum / rev,
      fixedPerDay: +by[from].totalFC || 0,
    };
  }

  /* Walk-forward backtest with the spend that was actually spent. It measures
     the model, not the spend plan: a forecast run on a plan that is not
     followed will miss by more. */
  function backtest(rows, opts) {
    /* Every day an origin: weekly origins gave 8.1% or 9.7% at 30 days
       depending only on which weekday they started from. */
    const o = Object.assign({ horizon: 30, step: 1, start: null }, DEFAULTS, opts);
    const by = index(rows);
    const dates = Object.keys(by).sort();
    if (!dates.length) return null;
    const last = dates[dates.length - 1];
    const errors = [], origins = [];
    for (let from = o.start || dates[0]; addDays(from, o.horizon) <= last; from = addDays(from, o.step)) {
      if (!by[from]) continue;
      const s = addDays(from, 1), e = addDays(from, o.horizon);
      const act = total(by, s, e, 'revenue');
      if (act.days !== o.horizon) continue;
      const p = period(by, from, s, e, total(by, s, e, 'totalAds').sum, o);
      if (!p) continue;
      errors.push(p.revenue / act.sum - 1); origins.push(from);
    }
    if (!errors.length) return null;
    const sorted = errors.slice().sort((x, y) => x - y);
    const q = p => sorted[Math.round(p * (sorted.length - 1))];
    const mean = a => a.reduce((x, v) => x + v, 0) / a.length;
    return { n: errors.length, mape: mean(errors.map(Math.abs)), bias: mean(errors),
             p10: q(0.1), p90: q(0.9), errors, origins };
  }

  /* A promotion that runs longer than last year's. The extra days were, last
     year, the lull before the sale (customers waiting for it); they become sale
     days. Returned at last year's scale. How much of it is new money rather
     than the same sales spread wider is not measurable from one BFCM, so the
     forecast books none of it in the pessimistic case, half in the realistic
     case and all of it in the optimistic case. */
  function saleExtension(rows, o) {
    const by = index(rows);
    const lull = total(by, o.lull[0], o.lull[1], 'revenue'), sale = total(by, o.sale[0], o.sale[1], 'revenue');
    if (!lull.days || !sale.days) return 0;
    return o.days * (sale.sum / sale.days - lull.sum / lull.days);
  }

  /* periods: [{ name, start, end, spend, extension }] where `extension` is
     last-year-scale revenue from saleExtension (optional).
     Scenarios come from the backtest, not from a guess: the measured 10th and
     90th percentile errors, turned the right way round. A forecast that runs
     +7% at the 90th percentile means actual comes in 1/1.07 of it. */
  function forecast(rows, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const by = index(rows);
    const from = o.from || Object.keys(by).sort().pop();
    const r = rates(by, from, o.contribWindow);
    const bt = o.band ? null : backtest(rows, Object.assign({}, o, { horizon: 30 }));
    const band = o.band || (bt ? { p10: bt.p10, p90: bt.p90 } : { p10: 0, p90: 0 });
    const factor = { pessimistic: 1 / (1 + band.p90), realistic: 1, optimistic: 1 / (1 + band.p10) };
    const share = { pessimistic: 0, realistic: 0.5, optimistic: 1 };
    const out = (o.periods || []).map(pd => {
      const p = period(by, from, pd.start, pd.end, pd.spend, o);
      if (!p) return { name: pd.name, start: pd.start, end: pd.end, missing: true };
      const scale = p.revenue / p.lastYearRevenue;
      const ext = (pd.extension || 0) * scale;
      const scen = {};
      Object.keys(factor).forEach(k => {
        const revenue = p.revenue * factor[k] + ext * share[k];
        scen[k] = { revenue, revExGst: r ? revenue * r.exGst : null, spend: pd.spend,
                    profit: r ? revenue * r.contrib - pd.spend - r.fixedPerDay * p.days : null };
      });
      return Object.assign({ name: pd.name, extension: ext }, p, { scenarios: scen });
    });
    return { from, rates: r, band, backtest: bt, periods: out };
  }

  /* Spend plan: last year's month-on-month change applied to this year's
     spend, with increases trimmed (default: by 15%) and decreases kept as they
     were. `lastYear` and `start` are average spend per day. */
  function spendPlan(start, lastYear, trimIncrease) {
    const t = trimIncrease == null ? 0.15 : trimIncrease;
    const out = [];
    let prev = start;
    for (let i = 1; i < lastYear.length; i++) {
      const r = lastYear[i] / lastYear[i - 1];
      prev = prev * (r > 1 ? 1 + (1 - t) * (r - 1) : r);
      out.push(prev);
    }
    return out;
  }

  return { DEFAULTS, addDays, daysBetween, index, total, period, rates, backtest, saleExtension, forecast, spendPlan };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DLforecastSimple;
