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
   modifier is therefore not needed; only a sale whose dates CHANGE is
   declared (see saleMap).

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

  /* Last year's equivalent of days [a, b]: each day is its own date `lag`
     back, unless `map` (from saleMap) says it stands for something else. */
  function lastYear(by, a, b, key, lag, map) {
    let s = 0, n = 0;
    for (let d = a; d <= b; d = addDays(d, 1)) {
      const parts = (map && map(d)) || [{ date: addDays(d, -lag), w: 1 }];
      let ok = true, v = 0;
      parts.forEach(p => { const r = by[p.date]; if (r) v += p.w * (+r[key] || 0); else ok = false; });
      if (ok) { s += v; n++; }
    }
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
    const rTly = lastYear(by, start, end, 'revenue', o.lag, o.map), sTly = lastYear(by, start, end, 'totalAds', o.lag, o.map);
    if (rWly.days < o.window * 0.9 || rTly.days < n * 0.9 || !sW.sum || !sWly.sum || !sTly.sum) return null;
    const yoyRevenue = rW.sum / rWly.sum;
    const yoySpendNow = sW.sum / sWly.sum;
    const yoySpendPlan = spend / sTly.sum;
    /* elasticityUp, when given, applies only to spend above trend: a dollar
       added works less hard than an average one, while a dollar cut still
       costs its full share. That one-sidedness is deliberate caution. */
    const rel = yoySpendPlan / yoySpendNow;
    const e = rel > 1 && o.elasticityUp != null ? o.elasticityUp : o.elasticity;
    const revenue = rTly.sum * yoyRevenue * Math.pow(rel, e);
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
             p05: q(0.05), p10: q(0.1), p90: q(0.9), p95: q(0.95), errors, origins };
  }

  /* A sale that moves or changes length from last year. 364-day matching
     carries last year's sale onto this year's calendar unchanged; when the
     dates are different, each day of this year's sale is matched to the day of
     last year's that played the same part:

       hype days        <- last year's hype days, in order, with the days
                           running up to them (the pre-sale lull) moved too
       first two days   <- last year's first two (the launch: 31% of 2025)
       Black Friday, the weekend after it, Cyber Monday <- the same days
       days after CM    <- lastWeight x an average middle day (2025 ended on
                           Cyber Monday, so nothing measured stands for them)
       other days       <- an average of last year's middle days
       after the sale   <- the same calendar date (holidays are fixed dates)

     Last year's middle days have no counterpart this year if the sale is
     shorter, so a shorter sale books fewer middle days. Each argument is
     { hype: [first, last], sale: [first, last], bf, cm } in ISO dates. */
  function saleMap(ly, ty, opts) {
    const o = Object.assign({ lead: 4, lastWeight: 1 }, opts);
    const lyLaunch = [ly.sale[0], addDays(ly.sale[0], 1)];
    const role = (s, d) => d === s.bf || d === s.cm || (d > s.bf && d < s.cm) || d === s.sale[0] || d === addDays(s.sale[0], 1);
    const middle = [];
    for (let d = ly.sale[0]; d <= ly.sale[1]; d = addDays(d, 1)) if (!role(ly, d)) middle.push(d);
    const avgMiddle = w => middle.map(date => ({ date, w: w / middle.length }));
    const hypeShift = daysBetween(ly.hype[0], ty.hype[0]) - 1;      // days this year's hype sits after last year's
    const afterShift = daysBetween(ly.sale[1], ty.sale[1]) - 1;
    const leadFrom = addDays(ty.hype[0], -o.lead);
    return function (d) {
      if (d >= leadFrom && d <= ty.hype[1]) return [{ date: addDays(d, -hypeShift), w: 1 }];
      if (d > ty.sale[1]) return d <= addDays(ty.sale[1], 62) ? [{ date: addDays(d, -afterShift), w: 1 }] : null;
      if (d < ty.sale[0]) return null;
      if (d === ty.sale[0]) return [{ date: lyLaunch[0], w: 1 }];
      if (d === addDays(ty.sale[0], 1)) return [{ date: lyLaunch[1], w: 1 }];
      if (d === ty.bf || d === ty.cm || (d > ty.bf && d < ty.cm)) return [{ date: addDays(d, daysBetween(ty.bf, ly.bf) - 1), w: 1 }];
      if (d > ty.cm) return avgMiddle(o.lastWeight);
      return avgMiddle(1);
    };
  }

  /* The three cases, deliberately leaning cautious (Matthew, 29 Oct 2026).

     band: which measured backtest miss the case assumes, turned the right
       way round. A forecast that ran +15% at the 95th percentile means actual
       came in 1/1.15 of it. Realistic takes none.
     elasticityUp: how hard spend above trend works (1 = as hard as average).
       The backtest measured e = 1 best, but over spend within about 1.5x of
       trend; the BFCM budget is 1.35x, at the edge of that.
     lastWeight: the days after Cyber Monday have no 2025 equivalent, so they
       count as one, one and a half or two average middle days.
     saleContrib: a cap on contribution margin for periods marked `sale`. The
       Scale planner puts sale orders at 44.2% (bundles and gifts); 2025's sale
       held its margin, so only the pessimistic case takes it. */
  const SCENARIOS = {
    pessimistic: { band: 'p95', elasticityUp: 0.5, lastWeight: 1, saleContrib: 0.442 },
    realistic:   { band: null, elasticityUp: 0.75, lastWeight: 1.5 },
    optimistic:  { band: 'p10', elasticityUp: 1, lastWeight: 2 },
  };

  /* periods: [{ name, start, end, spend, sale }]. sale: { ly, ty } for saleMap. */
  function forecast(rows, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const by = index(rows);
    const from = o.from || Object.keys(by).sort().pop();
    const r = rates(by, from, o.contribWindow);
    const bt = o.band ? null : backtest(rows, Object.assign({}, o, { horizon: 30, map: null }));
    const band = o.band || (bt ? { p05: bt.p05, p10: bt.p10, p90: bt.p90, p95: bt.p95 } : {});
    const cases = o.scenarios || SCENARIOS;
    const out = (o.periods || []).map(pd => {
      const scen = {};
      let base = null;
      Object.keys(cases).forEach(k => {
        const c = cases[k];
        const map = o.sale ? saleMap(o.sale.ly, o.sale.ty, { lastWeight: c.lastWeight }) : null;
        const p = period(by, from, pd.start, pd.end, pd.spend, Object.assign({}, o, { map, elasticityUp: c.elasticityUp }));
        if (!p) return;
        if (k === 'realistic') base = p;
        const revenue = p.revenue / (1 + (c.band ? band[c.band] || 0 : 0));
        const contrib = r && pd.sale && c.saleContrib != null ? Math.min(r.contrib, c.saleContrib) : r && r.contrib;
        scen[k] = { revenue, revExGst: r ? revenue * r.exGst : null, spend: pd.spend,
                    profit: r ? revenue * contrib - pd.spend - r.fixedPerDay * p.days : null };
      });
      if (!base) return { name: pd.name, start: pd.start, end: pd.end, missing: true };
      return Object.assign({ name: pd.name }, base, { scenarios: scen });
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

  return { DEFAULTS, SCENARIOS, addDays, daysBetween, index, total, lastYear, period, rates, backtest, saleMap, forecast, spendPlan };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DLforecastSimple;
