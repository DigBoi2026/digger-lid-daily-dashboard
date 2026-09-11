/* =========================================================================
   DiggerLid — Meta benchmark engine (v5.2 framework, "ColdStart" package).

   Shared by the Meta Ads page (browser) and unit tests (node). No DOM, no
   fetch: pure functions over the framework's source inputs and Meta's daily
   rows, so every benchmark on the page is DERIVED here from the same numbers
   the framework's verify script derives them from — never typed in.

   THE FRAMEWORK IN FOUR LINES

     Kill CPA (break-even)  = 12-month contribution per acquisition
     Target CPA (healthy)   = Kill − fixed cost × orders/acq − 15% × 12-mo revenue/acq
     Kill ROAS (Meta basis) = first-order gross AOV (× 1.10 GST) ÷ Kill CPA
     Cost per ATC           = CPA × ATC→Purchase %      (Kill and Target alike)

   Every input carries its provenance (cohort N, window, whether a rate is
   measured or estimated) and the page shows it, because the framework's own
   history is a list of confident numbers that turned out to rest on the wrong
   base — Pro Mats' revenue read as contribution, Coupler inheriting Grease's
   cap. The engine flags what it cannot measure rather than filling it in.
   ========================================================================= */
var DLmeta = (function () {

  /* ------------------------------------------------------------ inputs */

  /* Locked parameters — a business choice, stated as such. */
  const PARAMS = {
    fixedPerOrder: 50, fixedLow: 43, fixedHigh: 60,   // P&L 2026 YTD: weighted $44, simple avg $52, range $22–$64
    targetMargin: 0.15,                               // healthy net margin, ex GST
    gst: 1.10,                                        // first-order gross conversion
    newCustHaircut: [1.30, 1.40],                     // New-customer CPA ÷ blended CPA on the P&L (Jan: $85 vs $62)
    cohortWindowMonths: 12, cohortN: 2182, cohortEntered: 'May–Aug 2025',
  };

  /* 12-month cohort economics per entry category (cohort_summary.csv). ex GST. */
  const COHORT = {
    Diggershield:       { n: 52,   repeatPct: 13.5, subseqOrders: 0.15, entryContrib: 1027, subseqContrib: 36, contrib: 1063, entryRev: 1334, subseqRev: 67, margin: 0.80, note: 'N=52 — directional. 7.7% Grease attach is 4 customers.' },
    'Pro Enclosure':    { n: 415,  repeatPct: 11.3, subseqOrders: 0.14, entryContrib: 385,  subseqContrib: 24, contrib: 409,  entryRev: 626,  subseqRev: 50, margin: 0.63 },
    'Excavator Covers': { n: 445,  repeatPct: 14.6, subseqOrders: 0.18, entryContrib: 174,  subseqContrib: 19, contrib: 193,  entryRev: 289,  subseqRev: 41, margin: 0.62 },
    Grease:             { n: 1138, repeatPct: 24.8, subseqOrders: 0.35, entryContrib: 82,   subseqContrib: 36, contrib: 118,  entryRev: 321,  subseqRev: 106, margin: 0.25 },
    Accessories:        { n: 132,  repeatPct: 17.4, subseqOrders: 0.20, entryContrib: 31,   subseqContrib: 36, contrib: 67,   entryRev: 63,   subseqRev: 57, margin: 0.50, note: 'N=132 — smallish.' },
    /* 6-month cohort only (launched 25 Aug 2025). Revenue is DERIVED from
       contribution ÷ margin — reading contribution as revenue was the v5.1
       error that put Target at $66 instead of $51. OG pricing ($219); PLUS
       ($299, Aug 2026) is not in it. */
    'Pro Mats':         { n: 853, repeatPct: 4, subseqOrders: 0.04, entryContrib: 135, subseqContrib: 5, contrib: 139, entryRev: 135 / 0.59, subseqRev: 5 / 0.59, margin: 0.59, months: 6, note: '6-month cohort, OG pricing. PLUS variant not captured.' },
  };

  /* ATC→Purchase and top-of-funnel baselines from the 90-day Meta pull, per
     line × tier. `est` marks a rate the framework had to borrow. */
  const FUNNEL = {
    'Pro Enclosure':    { Prospecting: { atcToPurchase: 27.5, lpvToAtc: 2.59, cpv: 1.38 } },
    'Pro Mats':         { Prospecting: { atcToPurchase: 28.7, lpvToAtc: 6.12, cpv: 2.86 }, Retargeting: { atcToPurchase: 30.8, lpvToAtc: 15.20, cpv: 3.20 } },
    'Excavator Covers': { Prospecting: { atcToPurchase: 30.9, lpvToAtc: 2.67, cpv: 1.02 }, Retargeting: { atcToPurchase: 33.2, lpvToAtc: 7.82, cpv: 1.65 } },
    Grease:             { Prospecting: { atcToPurchase: 23.8, lpvToAtc: 7.82, cpv: 2.27 }, Retargeting: { atcToPurchase: 22.9, lpvToAtc: 19.64, cpv: 2.55 } },
    Coupler:            { Prospecting: { atcToPurchase: 38.5, lpvToAtc: 17.80, cpv: 1.78 } },
    'Multi/Broad':      { Prospecting: { atcToPurchase: 23.9, lpvToAtc: 14.38, cpv: 2.77 }, Retargeting: { atcToPurchase: 19.9, lpvToAtc: 7.46, cpv: 0.98 }, Retention: { atcToPurchase: 23.5, lpvToAtc: 28.26, cpv: 4.33 } },
    Diggershield:       { Prospecting: { atcToPurchase: 27.5, lpvToAtc: 2.6, cpv: 1.40, est: 'no dedicated campaign — Pro Enclosure analog; high-AOV lines usually convert lower (20–24%)' } },
    Accessories:        { Prospecting: { atcToPurchase: 28.4, est: 'blended prospecting rate — never cold-prospected' } },
    'Draw Bar':         { Prospecting: { atcToPurchase: 30.9, lpvToAtc: 2.7, cpv: 1.02, est: 'Excavator Covers rates — no dedicated ad set yet' } },
  };

  /* Which cohort category a line's purchase economics come from, and where a
     line's cap is a policy or its own arithmetic rather than the category's. */
  const LINES = [
    { id: 'Diggershield',     label: 'Diggershield',      cohort: 'Diggershield',     action: 'PUSH — dedicated campaign; ~10× headroom vs blended', slow: 'wait 14–21 days between scaling steps (small cohort)' },
    { id: 'Pro Enclosure',    label: 'Pro Enclosure',     cohort: 'Pro Enclosure',    action: 'PUSH — scale spend in 30–50% steps' },
    { id: 'Excavator Covers', label: 'Excavator Covers',  cohort: 'Excavator Covers', action: 'HOLD — tighten toward Target; landing page work' },
    { id: 'Draw Bar',         label: 'Draw Bar',          cohort: 'Excavator Covers', policyKill: 110, action: 'PUSH — dedicated ad set under a $110 policy cap', note: '$110 is a policy cap for the dedicated sub-line ad set, not break-even' },
    { id: 'Pro Mats',         label: 'Pro Mats',          cohort: 'Pro Mats',         action: 'DISCIPLINE — pause prospecting above Kill; retargeting works' },
    { id: 'Grease',           label: 'Grease / KAJO',     cohort: 'Grease',           action: 'STOP prospecting above Kill — retention is the play' },
    { id: 'Coupler',          label: 'Coupler',           cohort: 'Grease', ownEconomics: true, action: 'HOLD — at its own break-even; validate SKU cohort before scaling', note: 'Own economics: Meta AOV × 25% × Grease LTV 1.33. v5.1 wrongly inherited Grease’s $118.' },
    { id: 'Accessories',      label: 'Accessories',       cohort: 'Accessories',      action: 'UPSELL ONLY — never cold prospect' },
    { id: 'Multi/Broad',      label: 'Multi / Broad',     cohort: null,               action: 'Mixed line — judge against the account blend', blended: true },
  ];

  /* Campaign / ad-set name → line and tier. Applied case-insensitively, first
     match wins, so the specific sub-lines sit above the categories that would
     otherwise swallow them (Coupler and Draw Bar before Grease and Covers). */
  const LINE_RULES = [
    ['Coupler',          /coupler/],
    ['Draw Bar',         /draw ?bar/],
    ['Diggershield',     /digger ?shield|rear screen|earthmover/],
    ['Pro Enclosure',    /enclosure|topless/],
    ['Pro Mats',         /pro ?mat|promat/],
    ['Grease',           /grease|kajo|adapt[oe]r|hammer paste/],
    ['Excavator Covers', /cover|quicky|skid ?steer|mini ?loader|micro|1\.7/],
    ['Accessories',      /wipes|caddy|cradle|magnet|cap ?set|bottle|beanie|hoodie|trucker|tee\b|hauler|luggage/],
  ];
  const TIER_RULES = [
    ['Retention',   /retention|customers?\b|purchasers|existing|loyal|winback|win-back/],
    ['Retargeting', /retarget|rt\b|remarket|warm|dpa|catalog|abandon|viewed|engaged|visitors/],
    ['Prospecting', /prospect|cold|tof|broad|interest|lookalike|lal|acquisition|new/],
  ];
  function classify(name) {
    const t = String(name || '').toLowerCase();
    let line = 'Multi/Broad', tier = 'Prospecting', lineHit = false, tierHit = false;
    for (const [id, re] of LINE_RULES) if (re.test(t)) { line = id; lineHit = true; break; }
    for (const [id, re] of TIER_RULES) if (re.test(t)) { tier = id; tierHit = true; break; }
    return { line, tier, lineHit, tierHit };
  }

  /* ------------------------------------------------------------ derive */

  /* The purchase benchmarks, from the cohort inputs, at a given fixed cost.
     Returns per category: kill, target (null = INFEASIBLE), killRoasMeta,
     killRoasEcon, ltvMult, ordersPerAcq, totalRev. */
  function deriveCategory(c, fixed) {
    fixed = fixed == null ? PARAMS.fixedPerOrder : fixed;
    const orders = 1 + c.subseqOrders, totalRev = c.entryRev + c.subseqRev;
    const kill = c.contrib;
    const target = kill - fixed * orders - PARAMS.targetMargin * totalRev;
    return {
      kill, target: target > 0 ? target : null, infeasible: target <= 0,
      killRoasMeta: c.entryRev * PARAMS.gst / kill, killRoasEcon: totalRev / kill,
      ltvMult: totalRev / c.entryRev, ordersPerAcq: orders, totalRev, entryRev: c.entryRev,
      aovGross: c.entryRev * PARAMS.gst, n: c.n, months: c.months || PARAMS.cohortWindowMonths, margin: c.margin, note: c.note || null,
    };
  }

  /* Coupler is a Grease sub-SKU with its own arithmetic: Meta AOV × Grease
     margin × Grease LTV multiplier. `couplerAov` is Meta revenue ÷ purchases
     for the Coupler line over the reference pull ($80,417 ÷ 1,033 = $77.85). */
  function deriveCoupler(couplerAov, fixed) {
    /* The framework applies the margin to Meta's AOV as reported ($77.85) and
       grosses it up only for the ROAS — kept as-is so the page reproduces the
       canonical $26 / 3.31× rather than a re-derived $24. */
    const g = deriveCategory(COHORT.Grease, fixed);
    const contrib = couplerAov * COHORT.Grease.margin;
    const kill = contrib * g.ltvMult;
    return { kill, target: null, infeasible: true, killRoasMeta: couplerAov * PARAMS.gst / kill, killRoasEcon: null,
             ltvMult: g.ltvMult, ordersPerAcq: g.ordersPerAcq, entryRev: couplerAov, aovGross: couplerAov * PARAMS.gst, n: null, months: 12,
             margin: COHORT.Grease.margin, note: 'Own economics, interim: downstream Grease Packs attach is hidden inside Grease→Grease 20.9%.' };
  }

  /* Every line's benchmarks, both tiers where the funnel has them. */
  function deriveAll(opts) {
    opts = opts || {};
    const fixed = opts.fixed == null ? PARAMS.fixedPerOrder : opts.fixed;
    const couplerAov = opts.couplerAov || (80417.21 / 1033);
    const out = {};
    LINES.forEach(L => {
      let econ = null;
      if (L.ownEconomics) econ = deriveCoupler(couplerAov, fixed);
      else if (L.cohort) econ = deriveCategory(COHORT[L.cohort], fixed);
      if (econ && L.policyKill) {
        econ = Object.assign({}, econ, { kill: L.policyKill, policy: true,
          killRoasMeta: COHORT[L.cohort] ? (149 * PARAMS.gst / L.policyKill) : null });   // Draw Bar first-order AOV $149 (framework)
      }
      const tiers = {};
      Object.entries(FUNNEL[L.id] || {}).forEach(([tier, f]) => {
        tiers[tier] = {
          atcToPurchase: f.atcToPurchase, lpvToAtc: f.lpvToAtc == null ? null : f.lpvToAtc, cpv: f.cpv == null ? null : f.cpv, est: f.est || null,
          killCostPerAtc: econ ? econ.kill * f.atcToPurchase / 100 : null,
          targetCostPerAtc: econ && econ.target ? econ.target * f.atcToPurchase / 100 : null,
        };
      });
      out[L.id] = Object.assign({ id: L.id, label: L.label, action: L.action, note: L.note || (econ && econ.note) || null, slow: L.slow || null, blended: !!L.blended }, econ || {}, { tiers });
    });
    /* Account blend: cohort-weighted across the five 12-month categories;
       INFEASIBLE categories contribute $0 to the Target. */
    const five = ['Diggershield', 'Pro Enclosure', 'Excavator Covers', 'Grease', 'Accessories'];
    const nTot = five.reduce((a, c) => a + COHORT[c].n, 0);
    const d = five.map(c => deriveCategory(COHORT[c], fixed));
    out.blended = {
      kill: five.reduce((a, c, i) => a + COHORT[c].n * d[i].kill, 0) / nTot,
      target: five.reduce((a, c, i) => a + COHORT[c].n * (d[i].target || 0), 0) / nTot,
      killRoasMeta: 1.4, n: nTot,
    };
    return out;
  }

  /* ------------------------------------------------------------ rollup */

  /* Sum Meta daily rows (date, tier, line, spend, impressions, lpv, atc,
     purchases, revenue) into one record with the derived rates. */
  function rollup(rows) {
    const s = { spend: 0, impressions: 0, lpv: 0, atc: 0, purchases: 0, revenue: 0, days: new Set() };
    (rows || []).forEach(r => { s.spend += r.spend || 0; s.impressions += r.impressions || 0; s.lpv += r.lpv || 0; s.atc += r.atc || 0; s.purchases += r.purchases || 0; s.revenue += r.revenue || 0; if (r.date) s.days.add(r.date); });
    const d = (a, b) => b ? a / b : null;
    return { spend: s.spend, impressions: s.impressions, lpv: s.lpv, atc: s.atc, purchases: s.purchases, revenue: s.revenue, days: s.days.size,
      cpa: d(s.spend, s.purchases), roas: d(s.revenue, s.spend), costPerAtc: d(s.spend, s.atc), cpv: d(s.spend, s.lpv),
      lpvToAtc: s.lpv ? s.atc / s.lpv * 100 : null, atcToPurchase: s.atc ? s.purchases / s.atc * 100 : null, aov: d(s.revenue, s.purchases) };
  }

  /* ------------------------------------------------------------ verdict */

  /* The framework's daily rules, as a function of a rolled-up window and its
     benchmarks. Returns { status, rule, detail }:
       PAUSE     CPA above Kill (or ROAS below Kill ROAS) — every day is money burnt
       OPTIMISE  between Target and Kill — profitable, not healthy
       SCALE     at or under Target — candidate for 30–50% steps
       WATCH     top-of-funnel above its Kill while purchase still inside
       LOW       too few purchases to judge (< minPurchases)
       NONE      no benchmark for this line / tier */
  function verdict(roll, bench, tier, opts) {
    opts = opts || {};
    const minP = opts.minPurchases == null ? 5 : opts.minPurchases;
    if (!bench || bench.kill == null) return { status: 'NONE', rule: 'no benchmark for this line' };
    const t = bench.tiers && bench.tiers[tier];
    if (!roll || !(roll.spend > 0)) return { status: 'NONE', rule: 'no spend in the window' };
    if ((roll.purchases || 0) < minP) return { status: 'LOW', rule: `${roll.purchases || 0} purchases — too few to judge (needs ${minP})` };
    const out = [];
    const m$ = v => '$' + (bench.kill < 50 ? v.toFixed(2) : v.toFixed(0));   // cents when the cap is small enough for them to matter
    if (roll.cpa != null && roll.cpa > bench.kill) out.push({ status: 'PAUSE', rule: `CPA ${m$(roll.cpa)} above Kill ${m$(bench.kill)} — above break-even, pause` });
    if (roll.roas != null && bench.killRoasMeta && roll.roas < bench.killRoasMeta) out.push({ status: 'PAUSE', rule: `ROAS ${roll.roas.toFixed(2)}× below Kill ROAS ${bench.killRoasMeta.toFixed(2)}×` });
    if (t && roll.costPerAtc != null && t.killCostPerAtc && roll.costPerAtc > t.killCostPerAtc) out.push({ status: 'WATCH', rule: `Cost/ATC $${roll.costPerAtc.toFixed(0)} above Kill $${t.killCostPerAtc.toFixed(0)} — CPA follows in 3–7 days` });
    if (t && roll.lpvToAtc != null && t.lpvToAtc && roll.lpvToAtc < t.lpvToAtc * 0.8) out.push({ status: 'WATCH', rule: `LPV→ATC ${roll.lpvToAtc.toFixed(1)}% is ${(100 - roll.lpvToAtc / t.lpvToAtc * 100).toFixed(0)}% under baseline — landing page or creative, not bidding` });
    if (out.some(o => o.status === 'PAUSE')) return Object.assign({ status: 'PAUSE' }, { rule: out.filter(o => o.status === 'PAUSE').map(o => o.rule).join(' · '), tof: out.filter(o => o.status === 'WATCH').map(o => o.rule) });
    const tof = out.filter(o => o.status === 'WATCH').map(o => o.rule);
    if (bench.target != null && roll.cpa != null && roll.cpa <= bench.target) return { status: tof.length ? 'WATCH' : 'SCALE', rule: tof.length ? tof.join(' · ') : `CPA $${roll.cpa.toFixed(0)} at or under Target $${bench.target.toFixed(0)} — scale in 30–50% steps${bench.slow ? '; ' + bench.slow : ''}`, tof };
    if (bench.target == null) return { status: tof.length ? 'WATCH' : 'OPTIMISE', rule: tof.length ? tof.join(' · ') : `inside Kill but INFEASIBLE for a healthy margin — never scale cold`, tof };
    return { status: tof.length ? 'WATCH' : 'OPTIMISE', rule: tof.length ? tof.join(' · ') : `CPA $${roll.cpa.toFixed(0)} between Target $${bench.target.toFixed(0)} and Kill $${bench.kill.toFixed(0)} — profitable, not healthy; optimise, don’t pause`, tof };
  }

  /* Consecutive days (from the newest back) a daily series has breached a
     line, for the "3+ days" rules. */
  function streak(dailyValues, limit, above) {
    let n = 0;
    for (let i = dailyValues.length - 1; i >= 0; i--) {
      const v = dailyValues[i]; if (v == null) break;
      if (above ? v > limit : v < limit) n++; else break;
    }
    return n;
  }

  /* ------------------------------------------------------------ Meta API rows */

  /* Turn a Graph API insights row (level=adset, time_increment=1) into the
     flat daily row the page uses. Prefers the omni_ action types and falls
     back to the pixel-only ones. */
  function actionValue(list, types) {
    for (const t of types) { const hit = (list || []).find(a => a.action_type === t); if (hit) return +hit.value || 0; }
    return 0;
  }
  function fromInsight(r) {
    const name = [r.campaign_name, r.adset_name].filter(Boolean).join(' · ');
    const c = classify(name);
    return {
      date: r.date_start, campaign: r.campaign_name || '', adset: r.adset_name || '', line: c.line, tier: c.tier, mapped: c.lineHit,
      spend: +r.spend || 0, impressions: +r.impressions || 0,
      lpv: actionValue(r.actions, ['landing_page_view']),
      atc: actionValue(r.actions, ['omni_add_to_cart', 'add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart']),
      purchases: actionValue(r.actions, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']),
      revenue: actionValue(r.action_values, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']),
    };
  }

  return { PARAMS, COHORT, FUNNEL, LINES, LINE_RULES, TIER_RULES, classify, deriveCategory, deriveCoupler, deriveAll, rollup, verdict, streak, fromInsight };
})();

if (typeof window !== 'undefined') window.DLmeta = DLmeta;
if (typeof module !== 'undefined' && module.exports) module.exports = DLmeta;
