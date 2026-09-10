/* =========================================================================
   DiggerLid — forecast engine.

   Shared by the Forecast page and unit-tested offline by
   source/test_forecast.js. No DOM, no fetch: pure functions over daily rows,
   so every claim it makes can be checked against history.

   WHY IT LOOKS LIKE THIS
   ----------------------
   This business is not a trend with noise on top. It is two enormous events a
   year with flat water in between, and a naive trailing-level forecast fails
   catastrophically on exactly that shape — backtested over 2026 it scored 43%
   MAPE and, coming out of June, over-forecast the next 30 days by 137% because
   its trailing window was still full of EOFY.

   Measured across two years:

       EOFY   Jun/May   x2.00 (2025)   x1.94 (2026)
       BFCM   Nov/Oct   x1.99 (2025)
       payback after    -46%, -52%, -60%

   Three events, all near x2.0, all followed by roughly -50%. That is a
   structure, not noise, and the model is built around it. With prior-year
   seasonality the same backtest scores 14.6% MAPE out of sample, and predicts
   June — the month the naive model missed twice — to within 4.2%.

   And the reason any of it matters: in 2025, June and November earned +$48,917
   and +$103,174 while the other seven months lost $50,772 between them. The
   year is made in two months. A forecast that cannot see them is decoration.
   ========================================================================= */
var DLforecast = (function () {

  const DAY = 86400000;
  const iso = d => new Date(d).toISOString().slice(0, 10);
  const addDays = (s, n) => iso(new Date(s + 'T00:00:00Z').getTime() + n * DAY);
  const dow = s => new Date(s + 'T00:00:00Z').getUTCDay();      // 0=Sun
  const monthOf = s => parseInt(s.slice(5, 7), 10);
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const sum = a => a.reduce((x, y) => x + y, 0);

  /* ---------------------------------------------------------------- fitting */

  /* Day-of-week shape. Fitted across every year available, because the weekly
     rhythm of a trade customer does not change between years and more days make
     it steadier. Mon-Wed run ~1.13-1.16, Saturday ~0.77. */
  function fitDow(rows) {
    const b = {};
    rows.forEach(r => { if (r.revenue > 0) (b[dow(r.date)] = b[dow(r.date)] || []).push(r.revenue); });
    const all = mean(Object.values(b).flat());
    const out = {};
    for (let i = 0; i < 7; i++) out[i] = (b[i] && all) ? mean(b[i]) / all : 1;
    return out;
  }

  /* Month index.

     The obvious way to do this is: normalise each year against its own average,
     then average the years. That is what the first cut did, and on an unbalanced
     panel it is wrong in a way that quietly wrecked the forecast.

     2025 holds nine months INCLUDING June and November, so every other 2025
     month is measured against an average those two giants inflate, and reads
     low. 2026 (at an April vantage) held only January to March, none of them
     big, so every 2026 month is measured against a small average and reads high.
     Mixing the two means deseasonalising a level by a too-high index and then
     re-seasonalising it by a too-low one. Backtested from April origins that
     double deflation under-forecast the following 30 days by 29-39%.

     So fit year and month effects JOINTLY instead, by alternating least squares
     on log daily revenue:

         log v[y][m] = yearEffect[y] + monthEffect[m]

     which is the standard way to read a shape off a panel with holes in it. The
     month effects then share one base whether or not any given year happens to
     contain November, and the year effects fall out as a free by-product worth
     showing. Months no year has (Feb-Apr 2025 were never filled in) get 1 and
     are reported as n=0, never guessed. */
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  function fitSeason(rows) {
    const cell = {};                                   // cell[year][month] = [revenue...]
    rows.forEach(r => {
      if (!(r.revenue > 0)) return;
      const y = r.date.slice(0, 4), m = monthOf(r.date);
      ((cell[y] = cell[y] || {})[m] = cell[y][m] || []).push(r.revenue);
    });
    /* Drop part-months. The current month is always incomplete, and whichever
       days it happens to hold are not a fair sample of it: September 2026 was
       eight days, all of them the post-Father's-Day slump, which pulled the
       September index down to 0.91 when the days present ran far below the
       month's own average. An index built from a biased eighth of a month is
       worse than no index at all. */
    for (const y in cell) {
      for (const m in cell[y]) if (cell[y][m].length < daysInMonth(+y, +m)) delete cell[y][m];
      if (!Object.keys(cell[y]).length) delete cell[y];
    }
    const obs = [];                                    // {y, m, log daily mean}
    for (const y in cell) for (const m in cell[y]) obs.push({ y, m: +m, v: Math.log(mean(cell[y][m])) });

    const years = [...new Set(obs.map(o => o.y))];
    const months = [...new Set(obs.map(o => o.m))];
    const A = {}, Bm = {};
    years.forEach(y => A[y] = 0); months.forEach(m => Bm[m] = 0);
    for (let it = 0; it < 200; it++) {
      years.forEach(y => {
        const r = obs.filter(o => o.y === y).map(o => o.v - Bm[o.m]);
        if (r.length) A[y] = mean(r);
      });
      months.forEach(m => {
        const r = obs.filter(o => o.m === m).map(o => o.v - A[o.y]);
        if (r.length) Bm[m] = mean(r);
      });
    }
    const centre = months.length ? mean(months.map(m => Bm[m])) : 0;
    months.forEach(m => Bm[m] -= centre);
    years.forEach(y => A[y] += centre);

    const index = {}, n = {};
    for (let m = 1; m <= 12; m++) {
      index[m] = months.includes(m) ? Math.exp(Bm[m]) : 1;
      n[m] = obs.filter(o => o.m === m).length;
    }
    const yearLevel = {};
    years.forEach(y => yearLevel[y] = Math.exp(A[y]));
    return { index, observations: n, yearLevel, cells: obs.length };
  }

  /* Year-on-year growth from whole months present in both years, so a partial
     month cannot masquerade as a collapse — comparing 8 days of September to a
     full September once read as -32% when the true like-for-like was +132%. */
  function fitGrowth(rows) {
    const m = {};
    rows.forEach(r => {
      if (!(r.revenue > 0)) return;
      const k = r.date.slice(0, 7);
      (m[k] = m[k] || { sum: 0, days: 0 });
      m[k].sum += r.revenue; m[k].days++;
    });
    const daysIn = k => new Date(Date.UTC(+k.slice(0,4), +k.slice(5,7), 0)).getUTCDate();
    const ratios = [];
    for (const k in m) {
      const y = +k.slice(0, 4), prev = (y - 1) + k.slice(4);
      if (!m[prev]) continue;
      if (m[k].days < daysIn(k) || m[prev].days < daysIn(prev)) continue;   // whole months only
      ratios.push(m[k].sum / m[prev].sum);
    }
    ratios.sort((a, b) => a - b);
    return {
      yoy: ratios.length ? ratios[Math.floor(ratios.length / 2)] : null,   // median, not mean
      low: ratios.length ? ratios[0] : null,
      high: ratios.length ? ratios[ratios.length - 1] : null,
      n: ratios.length,
    };
  }

  /* --------------------------------------------------------------- events */

  /* Recurring events are ALREADY in the month index — June reads 1.75 and
     November 2.11 precisely because EOFY and BFCM happen in them. Multiplying by
     a separate event factor on top would count them twice and forecast a
     $1.8M November.

     So this list is annotation, not arithmetic: it tells the page where to draw
     a marker and what to warn about. Only user modifiers actually move the
     numbers, because only they are genuinely new information the history has
     not already priced in. */
  const EVENTS = [
    { key: 'eofy',    name: 'EOFY',           month: 6,  via: 'index',
      note: 'x2.0 on May, two years running. Tax-deductible asset purchases before 30 June.' },
    { key: 'eofy_pb', name: 'EOFY payback',   month: 7,  via: 'index',
      note: 'Demand pulled forward. -46% (2025), -52% (2026).' },
    { key: 'fathers', name: "Father's Day",   month: 9,  via: 'sale',
      note: 'First Sunday. The run-up straddles Aug/Sep, so it is carried as a sale period, not by the month index.' },
    { key: 'bfcm',    name: 'BFCM',           month: 11, via: 'index',
      note: 'x1.99 on October (2025). The single most profitable month of the year.' },
    { key: 'bfcm_pb', name: 'BFCM payback',   month: 12, via: 'index',
      note: '-60% (2025), plus the construction shutdown from mid-December.' },
    { key: 'shutdown',name: 'Trade shutdown', month: 1,  via: 'index',
      note: 'Sites closed to late January. Weakest index of the year at 0.66.' },
  ];

  /* ------------------------------------------------------------- metrics */

  /* Re-point the whole engine at a different measure.

     Everything below — the day-of-week shape, the month index, the growth rate,
     the level, the sale periods, the backtest — is written against `revenue`
     because that is what it was built for. None of it is actually specific to
     money: an order count has a weekly rhythm and a November too. So rather
     than thread a metric key through fifteen functions, a row list is mapped
     once and the engine runs on it unchanged. One implementation, one set of
     answers, whatever is being forecast.

     PENDING IS PER-MEASURE, and getting that wrong throws away good data. A day
     the sheet has not finished carries revenue and orders but no ad spend, so it
     is unusable for a revenue-and-profit forecast and perfectly good for an
     order-count one. `pending` is therefore cleared unless the caller says the
     measure depends on the unfilled fields. */
  function asMetric(rows, key, opts) {
    opts = opts || {};
    const derive = typeof key === 'function' ? key : (r => r[key]);
    return (rows || []).map(r => {
      const v = derive(r);
      return {
        date: r.date,
        revenue: (v == null || isNaN(v)) ? 0 : +v,
        pending: opts.keepPending ? (r.pending || null) : null,
        /* Carried through so fitPnl still works when the measure IS revenue. */
        revExGst: r.revExGst, totalVC: r.totalVC, totalAds: r.totalAds, totalFC: r.totalFC,
      };
    }).filter(r => r.date);
  }

  /* ------------------------------------------------------- sale periods */

  /* WHY FATHER'S DAY IS A SALE PERIOD AND EOFY IS NOT.

     EOFY and BFCM are already inside the month index — June reads 1.86 and
     November 2.50 precisely because they happen in them — so declaring those
     as sale periods on top would count them twice. What makes them
     representable is that they are month-ALIGNED: EOFY is June, its payback is
     July, and a per-month figure can say both.

     Father's Day cannot be represented that way at all. It is the first Sunday
     of September, its run-up sits almost entirely in AUGUST and its payback in
     September, so it straddles the boundary and no month index — however well
     fitted — can hold it. That is not a gap in the seasonality; it is a shape
     the seasonality is the wrong instrument for. Hence a sale period.

     And it earns the treatment. Measured against the three pre-promotion weeks
     of its own August, deseasonalised:

         2026   run-up 24 Aug - 6 Sep   +47%      payback  -34%
         2025   same window             -10%      payback  -22%

     2025 had no Father's Day promotion worth the name. 2026 did, and it was
     large. So this is new information the history genuinely does not carry —
     exactly what a modifier is for — and it is measured from the book rather
     than asserted. */
  function nthDowOfMonth(year, month, wantDow, n) {
    let seen = 0;
    const dim = daysInMonth(year, month);
    for (let d = 1; d <= dim; d++) {
      const iso2 = year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      if (dow(iso2) === wantDow && ++seen === n) return iso2;
    }
    return null;
  }

  const SALE_PERIODS = [
    {
      key: 'fathers', name: "Father's Day",
      when: y => nthDowOfMonth(y, 9, 0, 1),        // first Sunday of September (AU)
      runUp: 14,                                    // days of run-up, ending on the day itself
      /* The payback length is not guessed. A 14-day window at +47% pulls about
         6.6 days of trade forward, and giving 6.6 days back at -34% a day takes
         twenty. So the window is derived from the lift it has to repay, and
         shortens on its own if a future year promotes less hard. */
      note: 'Run-up straddles the Aug/Sep boundary, so no month index can hold it.',
    },
  ];

  /* Measure one sale period, per year, against the three weeks of its own month
     that precede it. Deseasonalised by day-of-week and by the year's own level,
     so a year twice the size of another is still comparable.

     The baseline deliberately stops two days short of the run-up: a promotion
     leaks backwards a little (teasers, early access) and including those days
     in the baseline would flatter the lift. */
  function fitSale(rows, sp, dowIdx, yearLevel) {
    const by = {}; rows.forEach(r => { if (r.revenue > 0) by[r.date] = r.revenue; });
    const shapeAt = d => {
      const y = d.slice(0, 4);
      if (by[d] == null || !yearLevel[y]) return null;
      return by[d] / dowIdx[dow(d)] / yearLevel[y];
    };
    const winMean = (a, b) => {
      const v = [];
      for (let d = a; d <= b; d = addDays(d, 1)) { const s = shapeAt(d); if (s != null) v.push(s); }
      return v.length ? { mean: mean(v), n: v.length } : null;
    };
    const out = [];
    Object.keys(yearLevel).sort().forEach(y => {
      const day = sp.when(+y);
      if (!day) return;
      const runStart = addDays(day, -(sp.runUp - 1));
      const base = winMean(addDays(runStart, -22), addDays(runStart, -2));   // 21 days
      const run  = winMean(runStart, day);
      if (!base || !run || base.n < 14 || run.n < sp.runUp) return;
      const lift = run.mean / base.mean - 1;

      /* A PROFILE, not a flat block. The first cut applied one average lift
         across all fourteen days, and that reads the promotion badly at both
         ends: 2026 ramped from +4% on the opening day to +84% at its peak four
         days later, then eased back to +25% by the day itself. Dividing the
         quiet tail days by the fourteen-day average over-corrected them, and
         the baseline it recovered came out 10% BELOW an independent
         pre-promotion estimate having started 11% above it — the same error,
         mirrored. Smoothed over three days so one odd Saturday cannot invent a
         spike. */
      const profile = [];
      const lo = -(sp.runUp - 1);
      for (let k = lo; k <= 0; k++) {
        const v = [];
        for (let j = -1; j <= 1; j++) {
          const o = k + j;
          if (o < lo || o > 0) continue;                 // never reach outside the window
          const sh = shapeAt(addDays(day, o));
          if (sh != null) v.push(sh);
        }
        profile.push({ offset: k, lift: v.length ? mean(v) / base.mean - 1 : lift });
      }

      /* Repay the pulled-forward volume: the profile's total lift in
         day-equivalents, given back at whatever the days after the event
         actually run at. The window is derived from the debt, so a year that
         promotes less hard pays it back faster on its own. */
      const pbProbe = winMean(addDays(day, 1), addDays(day, 30));
      const payback = pbProbe ? pbProbe.mean / base.mean - 1 : null;
      const pulled = sum(profile.map(o => Math.max(0, o.lift)));
      const paybackDays = (payback != null && payback < 0)
        ? Math.max(1, Math.round(pulled / -payback)) : null;
      out.push({ year: y, day, runStart, lift, profile, payback, paybackDays, pulled,
                 baseline: base.mean, baselineDays: base.n, paybackObserved: pbProbe ? pbProbe.n : 0 });
    });
    return out;
  }

  /* Concrete, dated modifiers for a sale period, ready to hand to project().

     Sized from the MOST RECENT year in which the promotion actually registered,
     not an average across years. A promotion is a decision, not a season: 2025
     chose not to run one and averaging that in would halve a lift the business
     has since shown it can produce. Every year measured is returned alongside,
     so the choice is visible rather than buried. */
  function salePeriodModifiers(rows, opts) {
    opts = opts || {};
    const overrides = opts.overrides || {};
    const src = (rows || []).filter(r => r.revenue > 0).sort((a, b) => a.date < b.date ? -1 : 1);
    if (!src.length) return [];
    const dowIdx = opts.dowIdx || fitDow(src);
    const season = opts.season || fitSeason(src);
    const years = opts.years || [];
    const out = [];
    (opts.periods || SALE_PERIODS).forEach(sp => {
      const fits = fitSale(src, sp, dowIdx, season.yearLevel);
      const byYear = {}; fits.forEach(f => byYear[f.year] = f);
      /* A lift is enough to declare a sale period. Requiring a payback window
         too was wrong: a promotion that pulled nothing forward still has to be
         divided out of the level, and gating on the slump meant the whole
         modifier was silently dropped — lift and all — whenever the days after
         the event happened to hold up. */
      const useful = fits.filter(f => f.lift > 0.05);
      /* An override is allowed to reach past the book — a sale being planned for
         a September the business has never promoted in. Without one, nothing
         measurable means nothing declared. */
      const hasOverride = years.some(y => overrides[sp.key + ':' + y]) || overrides[sp.key];
      if (!useful.length && !hasOverride) return;
      const ref = useful.length ? useful[useful.length - 1] : null;

      years.forEach(y => {
        const day = sp.when(+y);
        if (!day) return;
        /* EACH YEAR USES ITS OWN MEASUREMENT WHERE IT HAS ONE.

           Only a year with no measurement — a year still ahead — is sized from
           the most recent one that registered. Applying the reference year's
           lift to a HISTORICAL year is not a forecast, it is a false statement
           about the past, and it does real damage: 2025 ran no Father's Day
           promotion, so dividing 2025's ordinary late-August trade by 2026's
           +47% deflated the prior year, inflated year-on-year growth, and
           pushed the forecast UP by 24% — the exact opposite of what declaring
           the promotion is meant to do. */
        const own = byYear[y];
        const key = sp.key + ':' + y;
        const ov = overrides[key] || overrides[sp.key] || null;
        const src2 = (own && own.lift > 0.05) ? own : (own ? null : ref);   // ref may be null
        /* An override can declare a promotion in a year the book measured none —
           a sale planned for a September that has not happened yet — but nothing
           else can. Without one, a measured year that shows no lift stays
           undeclared rather than inheriting somebody else's. */
        if (!src2 && !ov) return;

        /* A LIFT THE USER SETS SCALES THE MEASURED RAMP, it does not flatten it.
           Saying "we expect +60% this year" is a statement about the size of the
           promotion, not about its shape: the ramp — slow open, peak four days
           in, ease off by the day itself — is a property of how the customers
           behave, and it is the part the book actually knows. So the profile is
           multiplied through, and a year with no measured shape at all falls
           back to a flat block, which is the only honest thing to do with no
           precedent to scale. */
        const baseLift = src2 ? src2.lift : null;
        const lift = ov && ov.lift != null ? ov.lift : baseLift;
        const k = (baseLift && lift != null && baseLift !== 0) ? lift / baseLift : null;
        const profile = (src2 && k != null)
          ? src2.profile.map(o => ({ date: addDays(day, o.offset), lift: o.lift * k }))
          : null;

        const pbDays = ov && ov.paybackDays != null ? ov.paybackDays
                     : (src2 ? src2.paybackDays : null);
        const payback = ov && ov.payback != null ? ov.payback
                      : (src2 && src2.paybackDays ? src2.payback : 0);

        out.push({
          key, name: sp.name + ' ' + y, periodKey: sp.key, kind: 'sale',
          start: addDays(day, -(sp.runUp - 1)), end: day,
          lift,
          /* Day-by-day, anchored on the event itself, so the ramp lands on the
             same offsets whichever year it is applied to. */
          profile,
          payback: pbDays ? payback : 0,
          paybackEnd: pbDays ? addDays(day, pbDays) : null,
          overridden: !!(ov && (ov.lift != null || ov.payback != null)),
          measured: src2
            ? { from: src2.year, own: !!(own && own.lift > 0.05),
                lift: src2.lift, payback: src2.payback,
                paybackDays: src2.paybackDays, pulled: src2.pulled, allYears: fits }
            : { from: null, own: false, lift: null, payback: null, paybackDays: null, allYears: fits },
          note: sp.note,
        });
      });
    });
    return out;
  }

  /* -------------------------------------------------- composing modifiers */

  /* SEPARATE DECLARATIONS, ONE ARITHMETIC.

     Seasonal trends, sale periods and modifiers are three different kinds of
     claim and belong apart:

       seasonal trend   fitted from history, month-aligned, not optional. It is
                        the baseline itself, not an adjustment to one.
       sale period      measured from the book, recurring, dated by rule. Its
                        size is a FACT about the past that can be overridden for
                        a year still ahead.
       modifier         asserted by you about the future — a launch, a price
                        change, a channel going live. Its size is a judgement,
                        and the data cannot check it.

     But they must COMPOSE through one path, because they overlap. A launch
     inside the Father's Day run-up, a sale period whose payback runs into the
     next promotion's opening days, a modifier landing in November on top of a
     BFCM index of 2.5 — every one of those is a real thing a user will do, and
     two separate mechanisms would answer them differently depending on which
     code path ran, which is the worst outcome available.

     So: factors multiply, which is the standard treatment of independent
     proportional effects and is what each measured lift already is. What this
     function adds is that it says so — every overlap is returned, with the
     composed factor and the names that produced it, so the page can show a
     combined effect instead of leaving it to be inferred.

     Deliberately NOT capped. A modifier is the user's assertion, and clipping
     it silently would be worse than a large number they can see and judge.
     `peak` and `beyondBook` are returned so the page can say plainly when a
     combination has gone past anything the business has ever recorded. */
  function composeMods(mods, opts) {
    mods = mods || [];
    const profileAt = {};
    mods.forEach(m => (m.profile || []).forEach(o => { profileAt[m.key + '|' + o.date] = o.lift; }));

    const factorOf = (m, date) => {
      if (date >= m.start && date <= m.end) {
        const p = profileAt[m.key + '|' + date];
        return 1 + (p != null ? p : (m.lift || 0));
      }
      if (m.payback && m.paybackEnd && date > m.end && date <= m.paybackEnd) return 1 + (m.payback || 0);
      return 1;
    };
    const at = date => {
      let f = 1;
      for (let i = 0; i < mods.length; i++) f *= factorOf(mods[i], date);
      return f;
    };
    const applyingAt = date => mods.filter(m => factorOf(m, date) !== 1);

    /* Walk every day any declaration touches, so an overlap is found by
       inspection rather than by comparing date ranges — paybacks, profiles and
       one-day windows all included, with no special cases to get wrong. */
    const spans = mods.map(m => [m.start, m.paybackEnd || m.end]);
    let lo = null, hi = null;
    spans.forEach(([a, b]) => { if (!lo || a < lo) lo = a; if (!hi || b > hi) hi = b; });
    const overlaps = [], perDay = [];
    let peak = 1, trough = 1;
    if (lo) {
      for (let d = lo; d <= hi; d = addDays(d, 1)) {
        const f = at(d);
        if (f === 1) continue;
        const who = applyingAt(d);
        perDay.push({ date: d, factor: f, names: who.map(m => m.name) });
        if (f > peak) peak = f;
        if (f < trough) trough = f;
        if (who.length > 1) overlaps.push({ date: d, factor: f, names: who.map(m => m.name),
                                            keys: who.map(m => m.key) });
      }
    }
    /* Grouped into runs, because "12 days from 24 Aug" reads and a list of
       twelve dates does not. */
    const runs = [];
    overlaps.forEach(o => {
      const last = runs[runs.length - 1];
      if (last && addDays(last.end, 1) === o.date && last.keys.join() === o.keys.join()) {
        last.end = o.date; last.days++;
        last.peak = Math.max(last.peak, o.factor);
        last.low = Math.min(last.low, o.factor);
      } else {
        /* Grouped by WHICH declarations collide, not by the resulting number, so
           one collision reads as one run. But a run can span a lift and the
           payback of its neighbour, and reporting only the peak would hide that
           half of it is a reduction — so it carries both ends. */
        runs.push({ start: o.date, end: o.date, days: 1, peak: o.factor, low: o.factor,
                    names: o.names, keys: o.keys });
      }
    });
    const ceiling = (opts && opts.observedCeiling) || null;
    return { at, perDay, overlaps, runs, peak, trough,
             beyondBook: ceiling ? peak > ceiling : false, ceiling };
  }

  /* The largest lift the book actually records, over any window a declaration
     could describe. Used only to tell the reader when a combination has left
     the range of anything observed — never to clip one. */
  function observedCeiling(rows, opts) {
    opts = opts || {};
    const src = (rows || []).filter(r => r.revenue > 0);
    if (!src.length) return null;
    const dowIdx = opts.dowIdx || fitDow(src);
    const season = opts.season || fitSeason(src);
    let best = 1;
    /* Sale periods, at their measured peak day. */
    (opts.periods || SALE_PERIODS).forEach(sp => {
      fitSale(src, sp, dowIdx, season.yearLevel).forEach(f => {
        f.profile.forEach(o => { if (1 + o.lift > best) best = 1 + o.lift; });
      });
    });
    /* And the seasonality's own biggest month, against a typical one, since
       that is the largest recurring swing the business has. */
    const idx = Object.keys(season.index).map(k => season.index[k]).filter(v => v > 0).sort((a, b) => a - b);
    if (idx.length) {
      const median = idx[Math.floor(idx.length / 2)];
      const ratio = idx[idx.length - 1] / (median || 1);
      if (ratio > best) best = ratio;
    }
    return best;
  }

  /* ----------------------------------------------------------- projection */

  /* Scenarios differ in ASSUMPTIONS, not in an arbitrary percentage bolted onto
     one number. Each is a sentence you could defend in a board meeting:

       realistic    the current trajectory continues, events repeat as they have
       optimistic   growth holds at its year-on-year rate, events scale with it
       pessimistic  growth stops dead, and the big months land 15% short

     The band drawn around them is separate, and comes from measured backtest
     error rather than from these. */
  const SCENARIOS = {
    realistic:   { driftFrom: 'recent', eventScale: 1.00 },
    optimistic:  { driftFrom: 'yoy',    eventScale: 1.10 },
    pessimistic: { driftFrom: 'flat',   eventScale: 0.85 },
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* Prior-year daily shape. Returns, for a date, last year's smoothed daily
     revenue around the same calendar position, and the mean of the whole month
     it sits in — the ratio of the two is where that day sat WITHIN its month.
     Smoothed over +/-3 days so one odd day cannot swing it, and over a full
     week the day-of-week effect cancels, which is what lets the caller apply
     its own day-of-week index without double-counting. */
  function priorShaper(rows) {
    const byDate = {}, monthDays = {};
    rows.forEach(r => {
      if (!(r.revenue > 0)) return;
      byDate[r.date] = r.revenue;
      (monthDays[r.date.slice(0, 7)] = monthDays[r.date.slice(0, 7)] || []).push(r.revenue);
    });
    const last = rows.length ? rows[rows.length - 1].date : null;
    const monthMean = {};
    for (const k in monthDays) {
      if (monthDays[k].length >= daysInMonth(+k.slice(0, 4), +k.slice(5, 7))) monthMean[k] = mean(monthDays[k]);
    }
    const yearBefore = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCFullYear(t.getUTCFullYear() - 1); return iso(t); };
    return function (date) {
      const ly = yearBefore(date);
      let s2 = 0, n = 0;
      for (let k = -3; k <= 3; k++) {
        const d = addDays(ly, k);
        if (byDate[d] != null && (!last || d <= last)) { s2 += byDate[d]; n++; }
      }
      if (n < 4) return null;
      const mm = monthMean[ly.slice(0, 7)];
      return { value: s2 / n, monthMean: mm || null };
    };
  }

  /* Deseasonalised daily level: how big is the business right now, net of
     season. Two things it must not do.

     It must not count pending days: a day the sheet has not finished carries
     real revenue but no ad spend, and including it drags the level down for a
     reason that has nothing to do with trade.

     And it must not measure across a part-month. A month index is a whole-month
     average, so dividing a handful of days by it only works if those days are
     typical of their month — and the trailing window almost never is. On
     2026-09-08 the window's September days were 1-8, which hold the entire
     Father's Day peak, and dividing them by a September index that also carries
     the post-Father's-Day slump read the business at $23,962/day when the year
     was running at $15,190. That inflated level compounded out to a $1.57m
     November. So `whole` restricts the window to days inside months the data
     completes, which lags by up to a month and is corrected by drift — a lag
     drift can fix beats a bias nothing can. */
  function levelOf(rows, dowIdx, seasonIdx, window, mode, endDate, shaper) {
    let usable = rows.filter(r => r.revenue > 0 && !r.pending);
    if (mode === 'whole') {
      const end = endDate || (usable.length ? usable[usable.length - 1].date : null);
      if (end) {
        const cut = end.slice(0, 7);                    // month of the vantage point
        const complete = {};
        usable.forEach(r => {
          const k = r.date.slice(0, 7);
          complete[k] = (complete[k] || 0) + 1;
        });
        usable = usable.filter(r => {
          const k = r.date.slice(0, 7);
          if (k >= cut) return false;                   // the current month is never complete
          return complete[k] >= daysInMonth(+k.slice(0, 4), +k.slice(5, 7));
        });
      }
    }
    const tail = usable.slice(-window);
    if (!tail.length) return null;
    /* `shape` deseasonalises each day by where it sat within its month last
       year, not by a flat whole-month average — the targeted answer to the
       part-month problem, and it keeps every one of the most recent days
       instead of throwing a lag at it. Days with no usable prior year fall
       back to the month index. */
    const des = tail.map(r => {
      let f = seasonIdx[monthOf(r.date)] || 1;
      if (mode === 'shape' && shaper) {
        const p = shaper(r.date);
        if (p && p.monthMean > 0) f = (p.value / p.monthMean) * f;
      }
      return r.revenue / dowIdx[dow(r.date)] / f;
    });
    if (mode === 'median') { const s2 = des.slice().sort((a, b) => a - b); return s2[Math.floor(s2.length / 2)]; }
    return mean(des);
  }

  function project(opts) {
    const raw = (opts.rows || []).filter(r => r.revenue > 0).sort((a, b) => a.date < b.date ? -1 : 1);
    if (!raw.length) return null;
    const horizon = opts.horizon || 90;
    const scenario = SCENARIOS[opts.scenario] || SCENARIOS.realistic;
    const from = opts.from || raw[raw.length - 1].date;

    /* Modifiers describe the PAST as well as the future, and they are applied to
       the past first.

       A modifier says "this much of this day is explained by something the model
       does not otherwise know about". So the honest order of operations is:
       divide that explanation out of history, fit everything on what is left,
       then multiply it back onto the days ahead where it applies. Fitting on raw
       revenue and patching afterwards does not work, and the reason is worth
       stating: an undeclared promotion contaminates the month index and the
       year-on-year growth rate too, not just the level, and no amount of
       correction downstream can reach a season index that has already absorbed
       it. Corrected here once, every fit below is a baseline fit. */
    const mods = opts.modifiers || [];
    const composed = composeMods(mods, { observedCeiling: opts.observedCeiling });
    const modAt = composed.at;
    const rows = mods.length
      ? raw.map(r => { const f = modAt(r.date); return f === 1 ? r : Object.assign({}, r, { revenue: r.revenue / f }); })
      : raw;

    const dowIdx = opts.dowIdx || fitDow(rows);
    const season = opts.season || fitSeason(rows);
    const growth = opts.growth || fitGrowth(rows);

    const LW = opts.levelWindow || 28;
    const LM = opts.levelMode || 'shape';
    const shaper = priorShaper(rows);
    const lvl = levelOf(rows.filter(r => r.date <= from), dowIdx, season.index, LW, LM, from, shaper);
    const prev = levelOf(rows.filter(r => r.date <= addDays(from, -LW)), dowIdx, season.index, LW, LM, addDays(from, -LW), shaper);

    /* Drift is a growth RATE, so bound it by the growth this business has
       actually achieved — not by an arbitrary band. The first cut clamped a
       28-over-28 ratio to +/-10%, which sounds conservative and is not: 1.10
       every 28 days compounds to x3.46 a year, when the measured range across
       five like-for-like months is x1.15..x2.02. Pinned at that ceiling it
       inflated the far end of the horizon by pure compounding, forecasting
       December 2026 at x2.45 on December 2025 while November — the month that
       actually grows — sat at x2.25. Nothing about December earns a bigger
       year-on-year lift than BFCM; that gap was the clamp talking, not the data.

       So the ceiling is the best year-on-year month ever recorded, expressed
       per 28 days, and the floor is its reciprocal. */
    const yoyCap = Math.max(growth.high || growth.yoy || 1.3, 1.05);
    const cap = opts.driftCap || Math.pow(yoyCap, 28 / 365);
    const recentDrift = (lvl && prev) ? clamp(lvl / prev, 1 / cap, cap) : 1;
    const yoyDrift = growth.yoy ? Math.pow(growth.yoy, 28 / 365) : 1;   // per 28d
    const drift = scenario.driftFrom === 'flat' ? 1
                : scenario.driftFrom === 'yoy'  ? Math.max(recentDrift, yoyDrift)
                : recentDrift;

    /* Two independent predictors, blended.

       A. Level x drift x day-of-week x month index — carries the current
          trajectory, but its level is contaminated by whatever month it was
          measured in, which is why it over-forecast December off an inflated
          November.
       B. The same days last year x year-on-year growth, smoothed over a
          +/-3 day window so a single odd day cannot swing it — carries the
          event shape explicitly, including events the month index cannot see
          because they move within the month.

       Blending beat either alone at every horizon tested (30d MAPE 21.6% -> 15%).
       The weight on B decays with distance: last year is most informative about
       next week and least about next quarter, because the further out you go the
       more the business has changed since. */
    const byDate = {}; rows.forEach(r => { byDate[r.date] = r.revenue; });
    const lastSeen = rows[rows.length - 1].date;
    const yearBefore = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCFullYear(t.getUTCFullYear() - 1); return iso(t); };
    const priorAt = date => {
      const ly = yearBefore(date);
      let s2 = 0, n = 0;
      for (let k = -3; k <= 3; k++) {
        const d = addDays(ly, k);
        if (byDate[d] != null && d <= lastSeen) { s2 += byDate[d]; n++; }
      }
      return n >= 4 ? s2 / n : null;                      // need most of the window, or don't use it
    };
    const priorWeight = clamp(0.65 - 0.003 * horizon, 0.3, 0.65);
    const gYoY = growth.yoy || 1;

    const days = [];
    for (let k = 1; k <= horizon; k++) {
      const date = addDays(from, k);
      const m = monthOf(date);
      let si = season.index[m] || 1;
      // "events land smaller/larger" only touches months that ARE events
      if (si > 1.2) si = 1 + (si - 1) * scenario.eventScale;
      const a = lvl * Math.pow(drift, k / LW) * dowIdx[dow(date)] * si;
      /* Last year's same days are already baseline — the whole series was
         corrected above — so a promotion that ran then is not carried into this
         year's ordinary weeks, and this year's is not multiplied on top of it. */
      const lyRaw = priorAt(date);
      const b = lyRaw != null ? lyRaw * gYoY * scenario.eventScale : null;
      const w = b != null ? priorWeight : 0;
      const v = ((1 - w) * a + w * (b || 0)) * modAt(date);
      days.push({ date, revenue: v, month: date.slice(0, 7), seasonIndex: si,
                  observations: season.observations[m] || 0,
                  hasPriorYear: b != null, modified: modAt(date) !== 1 });
    }
    const months = {};
    days.forEach(d => {
      const b = months[d.month] || (months[d.month] = { month: d.month, revenue: 0, days: 0,
        observations: d.observations, priorYearDays: 0 });
      b.revenue += d.revenue; b.days++; if (d.hasPriorYear) b.priorYearDays++;
    });
    return {
      scenario: opts.scenario || 'realistic',
      from, horizon, level: lvl, drift, priorWeight,
      modifiers: mods, modifierEffect: composed,
      total: sum(days.map(d => d.revenue)),
      days, months: Object.values(months).sort((a, b) => a.month < b.month ? -1 : 1),
      basis: { dowIdx, season, growth },
    };
  }

  /* ------------------------------------------------------------- P&L */

  /* The sheet already carries an EXACT profit identity, so there is no reason
     to regress one:

         profit = revExGst - totalVC - totalAds - totalFC

     checked to the dollar over every window tried. So rather than forecast
     profit, forecast its parts and let the identity do the arithmetic.

     Two of the parts behave very differently and must be treated differently.
     Variable cost and GST are RATES on revenue, steady to within a couple of
     points. Fixed cost is a STEP: salaries went $1,178/day -> $1,381 -> $1,463
     -> $1,837 -> $2,081 as people were hired, and never came back down. An
     average across that history would bill the rest of the year at a headcount
     the business no longer has, so the latest observed value is used, not a
     mean — the only estimator that is right about a staircase. */
  function fitPnl(rows, window) {
    const usable = rows.filter(r => r.revenue > 0 && !r.pending && r.totalFC != null);
    if (!usable.length) return null;
    const tail = usable.slice(-(window || 90));
    const S = k => tail.reduce((a, r) => a + (+r[k] || 0), 0);
    const rev = S('revenue');
    if (!rev) return null;
    const last = usable[usable.length - 1];

    /* Ad spend per revenue dollar is not constant across the year and its shape
       is the same in both years: the big months are the EFFICIENT ones (June
       2025 spent 18.1c per revenue dollar, November 23.6c) and the paybacks are
       the expensive ones (July 2026, 38.9c). Measured against each year's own
       average so a change in overall efficiency does not read as seasonality. */
    const byYM = {};
    rows.forEach(r => {
      if (!(r.revenue > 0) || r.totalAds == null || r.pending) return;
      const k = r.date.slice(0, 7), b = byYM[k] || (byYM[k] = { rev: 0, ad: 0, n: 0 });
      b.rev += r.revenue; b.ad += +r.totalAds || 0; b.n++;
    });
    const byYear = {};
    for (const k in byYM) {
      if (byYM[k].n < daysInMonth(+k.slice(0, 4), +k.slice(5, 7))) continue;   // whole months only
      const y = k.slice(0, 4);
      (byYear[y] = byYear[y] || []).push({ m: +k.slice(5, 7), rate: byYM[k].ad / byYM[k].rev });
    }
    const rel = {};
    for (const y in byYear) {
      const base = mean(byYear[y].map(o => o.rate));
      byYear[y].forEach(o => (rel[o.m] = rel[o.m] || []).push(o.rate / base));
    }
    const adRateIndex = {}, adRateN = {};
    for (let m = 1; m <= 12; m++) { adRateIndex[m] = rel[m] ? mean(rel[m]) : 1; adRateN[m] = rel[m] ? rel[m].length : 0; }

    return {
      exGstRate: S('revExGst') / rev,
      vcRate:    S('totalVC') / rev,
      adRate:    S('totalAds') / rev,
      fcPerDay:  +last.totalFC || 0,
      fcPerDayAvg: S('totalFC') / tail.length,
      adRateIndex, adRateN,
      window: tail.length, from: tail[0].date, to: last.date,
      contribRate: (S('revExGst') - S('totalVC')) / rev,
    };
  }

  /* Revenue forecast plus the P&L identity applied day by day.

     Ad rate is held constant across the three scenarios ON PURPOSE. What is
     uncertain here is demand, not the cost structure, and holding costs fixed is
     what exposes the operating leverage: fixed cost is ~$2,700 a day whatever
     happens, so a 20% revenue miss is a far bigger than 20% profit miss. Letting
     costs flex with each scenario would quietly hide exactly the risk the
     pessimistic case exists to show. */
  function projectPnl(opts) {
    const rev = project(opts);
    if (!rev) return null;
    const pnl = opts.pnl || fitPnl(opts.rows || [], opts.pnlWindow);
    if (!pnl) return rev;
    const adRate = opts.adRate != null ? opts.adRate : pnl.adRate;
    rev.days.forEach(d => {
      const m = monthOf(d.date);
      d.adSpend = d.revenue * adRate * (pnl.adRateIndex[m] || 1);
      d.profit  = d.revenue * pnl.contribRate - d.adSpend - pnl.fcPerDay;
      d.mer     = d.adSpend > 0 ? d.revenue / d.adSpend : null;
    });
    rev.months.forEach(mo => {
      const ds = rev.days.filter(d => d.month === mo.month);
      mo.adSpend = sum(ds.map(d => d.adSpend));
      mo.profit  = sum(ds.map(d => d.profit));
      mo.fixed   = pnl.fcPerDay * ds.length;
      mo.margin  = mo.revenue ? mo.profit / mo.revenue : null;
      mo.mer     = mo.adSpend ? mo.revenue / mo.adSpend : null;
    });
    rev.adSpend = sum(rev.days.map(d => d.adSpend));
    rev.profit  = sum(rev.days.map(d => d.profit));
    rev.pnl     = pnl;
    /* The revenue that covers ad spend and fixed cost and nothing more. Worth
       stating in dollars a day, because it is the one number that says whether
       a quiet week is survivable. */
    rev.breakevenPerDay = (pnl.contribRate - adRate) > 0
      ? pnl.fcPerDay / (pnl.contribRate - adRate) : null;
    return rev;
  }

  /* --------------------------------------------------------- backtesting */

  /* Walk-forward, refitting everything at each origin so nothing leaks. The
     page draws its uncertainty band from THIS rather than from a guess, which
     is the only way a band means anything.

     What it cannot do is score October to December: no origin in the data has
     a horizon that reaches them, so the largest claim the model makes — BFCM —
     is unvalidated by construction. The page says so where it says it. */
  function backtest(rows, opts) {
    opts = opts || {};
    const src = (rows || []).filter(r => r.revenue > 0).sort((a, b) => a.date < b.date ? -1 : 1);
    const byDate = {}; src.forEach(r => byDate[r.date] = r.revenue);
    const horizons = opts.horizons || [30, 60, 90];
    const step = opts.step || 7;
    const minHistory = opts.minHistory || 90;
    const yearBefore = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCFullYear(t.getUTCFullYear() - 1); return iso(t); };
    const out = {};
    horizons.forEach(h => out[h] = { errors: [], origins: [], cold: [] });
    for (let i = minHistory; i < src.length; i += step) {
      const from = src[i].date;
      const hist = src.slice(0, i + 1);
      horizons.forEach(h => {
        let act = 0, n = 0;
        for (let k = 1; k <= h; k++) { const d = addDays(from, k); if (byDate[d] != null) { act += byDate[d]; n++; } }
        if (n !== h || !act) return;
        const p = project(Object.assign({}, opts.model, { rows: hist, from, horizon: h }));
        if (!p) return;
        /* Does the horizon HAVE a prior year to lean on? Origins in 2025 do not,
           and they are a different model: from 2025-11-04 the engine missed the
           following 30 days by -58% because nothing in its history had ever seen
           a BFCM. Scoring those together with 2026 origins would understate what
           the model does now — and dropping them silently would overstate it, so
           both are returned and the page shows both. */
        let cover = 0;
        for (let k = 1; k <= h; k++) if (byDate[yearBefore(addDays(from, k))] != null) cover++;
        (cover / h >= 0.8 ? out[h].errors : out[h].cold).push((p.total - act) / act);
        if (cover / h >= 0.8) out[h].origins.push(from);
      });
    }
    const q = (arr, pct) => arr.length ? arr[Math.min(arr.length - 1, Math.max(0, Math.round(pct * (arr.length - 1))))] : null;
    const summary = {};
    horizons.forEach(h => {
      const e = out[h].errors.slice().sort((a, b) => a - b);
      const c = out[h].cold.slice().sort((a, b) => a - b);
      summary[h] = e.length ? {
        n: e.length,
        mape: mean(e.map(Math.abs)),
        bias: mean(e),
        p10: q(e, 0.1), p25: q(e, 0.25), median: q(e, 0.5), p75: q(e, 0.75), p90: q(e, 0.9),
        origins: [out[h].origins[0], out[h].origins[out[h].origins.length - 1]],
        coldStart: c.length ? { n: c.length, mape: mean(c.map(Math.abs)), bias: mean(c) } : null,
      } : null;
    });
    return summary;
  }

  return { addDays, dow, monthOf, daysInMonth, nthDowOfMonth, asMetric, fitDow, fitSeason, fitGrowth,
           priorShaper, fitSale, salePeriodModifiers, SALE_PERIODS,
           composeMods, observedCeiling, fitPnl, projectPnl, backtest,
           levelOf, project, EVENTS, SCENARIOS, _mean: mean, _sum: sum };
})();

if (typeof window !== 'undefined') window.DLforecast = DLforecast;
if (typeof module !== 'undefined' && module.exports) module.exports = DLforecast;
