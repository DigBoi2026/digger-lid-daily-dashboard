/* Unit tests for lib/meta_bench.js — the Meta benchmark engine.
   Run: node source/test_meta.js   (exit 0 = all pass)

   The framework's own history is a list of confident numbers that rested on
   the wrong base (Pro Mats' revenue read as contribution → Target $66 not $51;
   Coupler inheriting Grease's $118 cap). So the page derives every benchmark
   from the source inputs, and these tests pin the derivation to the v5.2
   verification output — the canonical set. */
const M = require('../lib/meta_bench.js');
let pass = 0, fail = 0;
const ok = (n, c, g) => { if (c) pass++; else { fail++; console.log(`  ✗ ${n}` + (g !== undefined ? `  (got ${JSON.stringify(g)})` : '')); } };
const near = (a, b, t = 0.6) => a != null && Math.abs(a - b) <= t;

/* ---- purchase benchmarks reproduce verify_v5_2.py ---- */
const B = M.deriveAll();
const rows = [['Diggershield', 795, 1063, 1.38], ['Pro Enclosure', 251, 409, 1.68], ['Excavator Covers', 84, 193, 1.65], ['Pro Mats', 51, 139, 1.81]];
rows.forEach(([id, target, kill, roas]) => {
  ok(`${id}: Target $${target}`, near(B[id].target, target), B[id].target);
  ok(`${id}: Kill $${kill}`, near(B[id].kill, kill), B[id].kill);
  ok(`${id}: Kill ROAS (Meta) ${roas}×`, near(B[id].killRoasMeta, roas, 0.02), B[id].killRoasMeta);
});
ok('Grease: INFEASIBLE for a healthy margin', B.Grease.infeasible && B.Grease.target === null, B.Grease.target);
ok('Grease: Kill $118, Kill ROAS 2.99×', near(B.Grease.kill, 118) && near(B.Grease.killRoasMeta, 2.99, 0.02), [B.Grease.kill, B.Grease.killRoasMeta]);
ok('Accessories: INFEASIBLE, Kill $67, Kill ROAS 1.03×', B.Accessories.infeasible && near(B.Accessories.kill, 67) && near(B.Accessories.killRoasMeta, 1.03, 0.02), B.Accessories);
ok('Pro Mats revenue is contribution ÷ margin, not contribution (the v5.1 error)', near(B['Pro Mats'].entryRev, 228.81, 0.1) && near(B['Pro Mats'].totalRev, 237.29, 0.1), [B['Pro Mats'].entryRev, B['Pro Mats'].totalRev]);
ok('Coupler: own economics, Kill ~$26, Kill ROAS ~3.3×', near(B.Coupler.kill, 25.89, 0.3) && near(B.Coupler.killRoasMeta, 3.31, 0.05), [B.Coupler.kill, B.Coupler.killRoasMeta]);
ok('Coupler does not inherit Grease’s $118', B.Coupler.kill < 40);
ok('Draw Bar carries the $110 policy cap, flagged', B['Draw Bar'].kill === 110 && B['Draw Bar'].policy === true && near(B['Draw Bar'].target, 84), B['Draw Bar']);
ok('account blend: Target $84 / Kill $208', near(B.blended.target, 84) && near(B.blended.kill, 208), B.blended);
ok('Diggershield LTV multiplier 1.05×, Accessories 1.90×', near(B.Diggershield.ltvMult, 1.05, 0.01) && near(B.Accessories.ltvMult, 1.90, 0.01));

/* ---- top of funnel ---- */
const T = (id, tier) => B[id].tiers[tier];
ok('Pro Enclosure Cost/ATC: Target $69 / Kill $112', near(T('Pro Enclosure', 'Prospecting').targetCostPerAtc, 68.92, 0.3) && near(T('Pro Enclosure', 'Prospecting').killCostPerAtc, 112.48, 0.3));
ok('Excavator Covers Cost/ATC: Target $26 / Kill $60', near(T('Excavator Covers', 'Prospecting').targetCostPerAtc, 26.11, 0.3) && near(T('Excavator Covers', 'Prospecting').killCostPerAtc, 59.64, 0.3));
ok('Pro Mats prospect $15 / $40, retarget $16 / $43', near(T('Pro Mats', 'Prospecting').targetCostPerAtc, 14.75, 0.3) && near(T('Pro Mats', 'Prospecting').killCostPerAtc, 39.89, 0.3) && near(T('Pro Mats', 'Retargeting').targetCostPerAtc, 15.83, 0.3) && near(T('Pro Mats', 'Retargeting').killCostPerAtc, 42.81, 0.3));
ok('Grease Kill Cost/ATC $28, no Target', near(T('Grease', 'Prospecting').killCostPerAtc, 28.08, 0.3) && T('Grease', 'Prospecting').targetCostPerAtc === null);
ok('Coupler Kill Cost/ATC ~$10', near(T('Coupler', 'Prospecting').killCostPerAtc, 9.97, 0.3), T('Coupler', 'Prospecting').killCostPerAtc);
ok('Diggershield Kill Cost/ATC $292 / Target $219, marked estimated', near(T('Diggershield', 'Prospecting').killCostPerAtc, 292.3, 0.5) && near(T('Diggershield', 'Prospecting').targetCostPerAtc, 218.7, 0.5) && !!T('Diggershield', 'Prospecting').est);
ok('Accessories Kill Cost/ATC $19', near(T('Accessories', 'Prospecting').killCostPerAtc, 19.03, 0.3));

/* ---- sensitivity: fixed cost ---- */
const lo = M.deriveAll({ fixed: 43 }), hi = M.deriveAll({ fixed: 60 });
ok('fixed $43 raises Excavator Covers Target to $93; $60 lowers it to $73', near(lo['Excavator Covers'].target, 93) && near(hi['Excavator Covers'].target, 73), [lo['Excavator Covers'].target, hi['Excavator Covers'].target]);
ok('Grease stays INFEASIBLE at every fixed cost', lo.Grease.infeasible && hi.Grease.infeasible);

/* ---- name classification ---- */
const c = M.classify;
ok('classify: "Prospecting · Pro Mat Broad" → Pro Mats / Prospecting', c('Prospecting · Pro Mat Broad').line === 'Pro Mats' && c('Prospecting · Pro Mat Broad').tier === 'Prospecting');
ok('classify: Coupler wins over Grease', c('KAJO Grease Coupler cold').line === 'Coupler');
ok('classify: Draw Bar wins over Covers', c('Covers RT — Draw Bar').line === 'Draw Bar' && c('Covers RT — Draw Bar').tier === 'Retargeting');
ok('classify: Diggershield by machine kit words', c('Earthmovers Bundle LAL').line === 'Diggershield');
ok('stageOf: TOF / TOM / MOF from the campaign name', M.stageOf('🦘AU - ASC - RS - TOF - Broad - Excl.', 'Flagship') === 'TOF' && M.stageOf('🎨 Creative Testing - TOM - ABO - Broad', 'Operator POV') === 'TOM' && M.stageOf('🔥 #5 - EOFY26 - AU - NASC - LS - MOF - All Mid', 'x') === 'MOF');
ok('stageOf: BOF is the MOF stage; ad set decides only when the campaign says nothing', M.stageOf('🔥 #8 - EOFY26 - AU - NASC - LS - BOF - All', 'x') === 'MOF' && M.stageOf('THS - AU - Conversions/Sales (NEW)', 'MOF (C) Low Ticket Items Retargeting') === 'MOF' && M.stageOf('Prospecting — Pro Mat', 'Broad AU') === null);
ok('stageOf: does not match inside words', M.stageOf('Bottom line TOMORROW offer', 'x') === null);
ok('stageFor: falls back on the audience tier when no stage word — Prospecting → TOF, Retargeting/Retention → MOF', M.stageFor('Prospecting — Pro Mat', 'Broad AU', 'Prospecting') === 'TOF' && M.stageFor('RT — Covers DPA', 'viewed 14d', 'Retargeting') === 'MOF' && M.stageFor('x', 'customers', 'Retention') === 'MOF');
ok('stageFor: a stage word in the name wins over the audience tier', M.stageFor('AU - ASC - RS - MOF - All Mid', 'Broad', 'Prospecting') === 'MOF');
ok('STAGE_TIER: TOF and TOM judged on Prospecting, MOF on Retargeting', M.STAGE_TIER.TOF === 'Prospecting' && M.STAGE_TIER.TOM === 'Prospecting' && M.STAGE_TIER.MOF === 'Retargeting');
ok('classify: team shorthand — PRO ENCL', c('Creative Testing · AU_PRO ENCL_30 SECOND INSTALL_SEPT26').line === 'Pro Enclosure');
ok('classify: team shorthand — PR MAT typo', c('Creative Testing · AU_AUSSIEADVENTURE_SEPT26_PR MAT').line === 'Pro Mats');
ok('classify: [M] and [PM] prefixes are Pro Mats', c('Creative Testing · [M] AU|PRO||"REVIEW UGC"|JULY26').line === 'Pro Mats' && c('x · [PM] 4WD - 12/5').line === 'Pro Mats');
ok('classify: [G] prefix is Grease, [C] prefix is Covers unless the name says Enclosure', c('x · [G] BJP - 24/04').line === 'Grease' && c('x · [C] Current Colours Quicky').line === 'Excavator Covers' && c('x · [C] DLCIVIL V1 | PRO ENCLOSURE').line === 'Pro Enclosure');
ok('classify: battery grease-gun brands are the Grease line', c('x · Dewalt_ASMR - 24/04').line === 'Grease' && c('x · [S] Milwaukee_ASMR').line === 'Grease');
ok('classify: TerraPro hauler is Accessories', c('x · Terra Pro 2nd run - No Excl.').line === 'Accessories');
ok('classify: MOF / BOF / Mid are Retargeting', c('THS - AU - Conversions/Sales (NEW) · MOF High Ticket Items').tier === 'Retargeting' && c('#8 EOFY26 NASC - LS - BOF - All').tier === 'Retargeting' && c('AU #5 MOF - All Mid - All Placements').tier === 'Retargeting');
ok('classify: ASC broad flagship is Multi/Broad prospecting BY DESIGN (mapped)', c('AU - ASC - RS - TOF - Broad - Excl. · Maximise Value - Flagship').line === 'Multi/Broad' && c('AU - ASC - RS - TOF - Broad - Excl. · Maximise Value - Flagship').tier === 'Prospecting' && c('AU - ASC - RS - TOF - Broad - Excl. · Maximise Value - Flagship').lineHit === true);
ok('classify: a name nobody can place is Multi/Broad and UNMAPPED', c('Creative Testing - TOM - ABO - Broad · Operator POV - 30/04').lineHit === true || c('Some Campaign · Operator POV - 30/04').lineHit === false);
ok('classify: retargeting words', c('DPA — all products viewed').tier === 'Retargeting');
ok('classify: retention words', c('Existing customers — grease reorder').tier === 'Retention' && c('Existing customers — grease reorder').line === 'Grease');
ok('classify: nothing recognised → Multi/Broad, Prospecting, flagged unmapped', c('Campaign 7').line === 'Multi/Broad' && c('Campaign 7').lineHit === false);
ok('classify: Adaptor is Grease (framework rulebook)', c('Battery KAJO Adaptor').line === 'Grease');

/* ---- rollup ---- */
const R = M.rollup([{ date: '2026-09-01', spend: 100, impressions: 10000, lpv: 100, atc: 10, purchases: 4, revenue: 800 }, { date: '2026-09-02', spend: 100, impressions: 10000, lpv: 100, atc: 10, purchases: 6, revenue: 1200 }]);
ok('rollup: CPA = spend ÷ purchases', R.cpa === 20 && R.roas === 10 && R.costPerAtc === 10 && R.cpv === 1, R);
ok('rollup: rates pooled, not averaged', R.lpvToAtc === 10 && R.atcToPurchase === 50 && R.days === 2, R);
ok('rollup: empty is null rates, zero flows', M.rollup([]).cpa === null && M.rollup([]).spend === 0);

/* ---- verdicts (the daily rules) ---- */
const pm = B['Pro Mats'];
const v = (roll) => M.verdict(roll, pm, 'Prospecting');
ok('verdict: CPA above Kill → PAUSE', v({ spend: 1000, purchases: 6, cpa: 163, roas: 1.81, costPerAtc: 46, lpvToAtc: 6.1 }).status === 'PAUSE');
ok('verdict: ROAS below Kill ROAS → PAUSE even with CPA inside', v({ spend: 1000, purchases: 8, cpa: 120, roas: 1.5, costPerAtc: 30, lpvToAtc: 6.1 }).status === 'PAUSE');
ok('verdict: between Target and Kill → OPTIMISE', v({ spend: 1000, purchases: 10, cpa: 100, roas: 2.5, costPerAtc: 28, lpvToAtc: 6.1 }).status === 'OPTIMISE');
ok('verdict: at or under Target → SCALE', v({ spend: 1000, purchases: 20, cpa: 50, roas: 4, costPerAtc: 14, lpvToAtc: 6.1 }).status === 'SCALE');
ok('verdict: Cost/ATC above its Kill while CPA fine → WATCH (TOF leads CPA)', v({ spend: 1000, purchases: 20, cpa: 50, roas: 4, costPerAtc: 45, lpvToAtc: 6.1 }).status === 'WATCH');
ok('verdict: LPV→ATC 20%+ under baseline → WATCH, and the rule names the page, not the bid', /landing page/.test(v({ spend: 1000, purchases: 20, cpa: 50, roas: 4, costPerAtc: 14, lpvToAtc: 4.5 }).rule));
ok('verdict: too few purchases → LOW', v({ spend: 200, purchases: 2, cpa: 100 }).status === 'LOW');
ok('verdict: INFEASIBLE line inside Kill → OPTIMISE with the never-scale note', /INFEASIBLE/.test(M.verdict({ spend: 500, purchases: 10, cpa: 50, roas: 4, costPerAtc: 12, lpvToAtc: 7.8 }, B.Grease, 'Prospecting').rule));
ok('verdict: no benchmark → NONE', M.verdict({ spend: 500, purchases: 10, cpa: 50 }, B['Multi/Broad'], 'Prospecting').status === 'NONE');
ok('streak counts consecutive newest days above a line', M.streak([10, 50, 60, 70], 40, true) === 3 && M.streak([50, 10, 60], 40, true) === 1 && M.streak([], 40, true) === 0);

/* ---- Graph API row → flat row ---- */
const ins = M.fromInsight({ date_start: '2026-09-10', campaign_name: 'Prospecting — Pro Enclosure', adset_name: 'Interest stack', spend: '412.10', impressions: '55000',
  actions: [{ action_type: 'landing_page_view', value: '300' }, { action_type: 'omni_add_to_cart', value: '9' }, { action_type: 'add_to_cart', value: '7' }, { action_type: 'omni_purchase', value: '3' }],
  action_values: [{ action_type: 'omni_purchase', value: '2100.50' }] });
ok('insight: mapped to Pro Enclosure / Prospecting', ins.line === 'Pro Enclosure' && ins.tier === 'Prospecting' && ins.mapped);
ok('insight: omni_ action types preferred over pixel-only', ins.atc === 9 && ins.purchases === 3 && ins.revenue === 2100.5 && ins.lpv === 300 && ins.spend === 412.1, ins);
ok('insight: missing actions are 0, not NaN', M.fromInsight({ date_start: '2026-09-10', spend: '10' }).purchases === 0);

console.log(`meta bench: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
