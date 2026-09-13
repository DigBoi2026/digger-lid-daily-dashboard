/* Unit tests for lib/gpam.js — the GPAM layers, waterfall, bridge and periods. */
const G = require('../lib/gpam.js');
let pass = 0, fail = 0;
const ok = (n, c, g) => { if (c) pass++; else { fail++; console.log(`  ✗ ${n}` + (g !== undefined ? `  (got ${JSON.stringify(g)})` : '')); } };
const near = (a, b, t = 0.01) => Math.abs(a - b) <= t;

const day = (date, o) => Object.assign({ date, revenue: 1100, revExGst: 1000, returns: 0, prodCost: 300, shipCost: 80, pickPack: 0, packaging: 10, txnFees: 5, merchFees: 25, totalVC: 420, metaTotal: 200, google: 50, tiktok: 0, totalAds: 250, salaries: 120, software: 10, office: 40, totalFC: 170, profit: 1000 - 420 - 250 - 170 }, o || {});
const rows = [day('2026-09-01'), day('2026-09-02'), day('2026-09-03')];

const L = G.layers(rows);
ok('layers: net revenue = ex GST less returns', L.netRevenue === 3000 && L.gst === 300, [L.netRevenue, L.gst]);
ok('layers: COGS uses the sheet total and lists six lines', L.cogs.total === 1260 && L.cogs.items.length === 6 && L.cogs.other === 0, L.cogs);
ok('layers: gross profit and GM%', L.grossProfit === 1740 && near(L.gmPct, 58), [L.grossProfit, L.gmPct]);
ok('layers: advertising total and %', L.ads.total === 750 && near(L.adsPct, 25), L.ads.total);
ok('layers: contribution margin', L.cm === 990 && near(L.cmPct, 33), L.cm);
ok('layers: no overhead line in the sheet → GPAM = CM, flagged', L.overhead.total === 0 && L.overhead.inSheet === false && L.gpam === 990 && near(L.gpamPct, 33), [L.overhead, L.gpam]);
ok('layers: below the line and profit tie to the sheet', L.btl.total === 510 && L.profit === 480 && L.sheetProfit === 480 && L.profitGap === 0, [L.profit, L.sheetProfit]);

const L2 = G.layers(rows, { overheadPerDay: 50 });
ok('layers: declared overhead reduces GPAM, not CM', L2.cm === 990 && L2.overhead.declared === 150 && L2.gpam === 840, [L2.cm, L2.gpam]);
const L3 = G.layers([day('2026-09-01', { mktConsult: 100, creative: 40 })]);
ok('layers: sheet overhead lines are read when present', L3.overhead.inSheet && L3.overhead.total === 140 && L3.gpam === 330 - 140, L3.overhead);
const L4 = G.layers([day('2026-09-01', { returns: 100 })]);
ok('layers: returns reduce net revenue and GPAM, and explain the gap to sheet profit', L4.netRevenue === 900 && L4.gpam === 230 && L4.profitGap === -100, [L4.netRevenue, L4.gpam, L4.profitGap]);
const L5 = G.layers([day('2026-09-01', { totalVC: 450 })]);
ok('layers: a sheet total above its parts shows the difference as other', L5.cogs.other === 30 && L5.cogs.total === 450, L5.cogs);
ok('layers: pending / zero-revenue days are skipped', G.layers(rows.concat([{ date: '2026-09-04', revenue: 0 }])).days === 3);

const W = G.waterfall(L);
ok('waterfall: starts at gross sales, GPAM total equals layers', W[0].value === 3300 && W.find(s => s.key === 'gpam').value === 990);
const run = W.filter(s => s.kind === 'minus' || s.kind === 'total').reduce((r, s) => s.kind === 'total' ? s.value : r + s.value, 0);
ok('waterfall: minus steps carry the running total exactly to GPAM', near(run, 990), run);
ok('waterfall: returns step omitted when zero, present when not', !W.some(s => s.key === 'returns') && G.waterfall(L4).some(s => s.key === 'returns'));
ok('waterfall: ghost tail lands on profit', W[W.length - 1].key === 'profit' && W[W.length - 1].value === 480);

const then = G.layers([day('2025-09-01', { revenue: 880, revExGst: 800, prodCost: 280, totalVC: 400, totalAds: 160, metaTotal: 160, profit: 800 - 400 - 160 - 170 })]);
const now = G.layers([day('2026-09-01')]);
const B = G.bridge(now, then);
ok('bridge: four effects sum to ΔGPAM to the cent', B && near(B.items.reduce((a, i) => a + i.value, 0), B.delta) && near(B.residual, 0), B);
ok('bridge: ΔGPAM is now − then', near(B.delta, now.gpam - then.gpam));
ok('bridge: null without a prior', G.bridge(now, null) === null && G.bridge(now, G.layers([])) === null);

const P = G.period('MTD', '2026-09-12');
ok('period: MTD from the 1st, prior is the same dates last year', P.start === '2026-09-01' && P.end === '2026-09-12' && P.prev.start === '2025-09-01' && P.prev.end === '2025-09-12');
ok('period: last month is the whole prior month', (p => p.start === '2026-08-01' && p.end === '2026-08-31')(G.period('LM', '2026-09-12')));
ok('period: last month across a year boundary', (p => p.start === '2025-12-01' && p.end === '2025-12-31')(G.period('LM', '2026-01-05')));
ok('period: QTD in September starts 1 July; in November 1 October; in February 1 January', G.period('QTD', '2026-09-12').start === '2026-07-01' && G.period('QTD', '2026-11-03').start === '2026-10-01' && G.period('QTD', '2026-02-10').start === '2026-01-01');
ok('period: FYTD starts 1 July and is labelled by the FY it ends in', (p => p.start === '2026-07-01' && p.label === 'FY27 to date')(G.period('FYTD', '2026-09-12')) && G.period('FYTD', '2026-03-01').start === '2025-07-01');
ok('period: 12M is 365 days', G.expectedDays(G.period('12M', '2026-09-12')) === 365);
ok('period: a named month is clipped to the anchor', (p => p.start === '2026-09-01' && p.end === '2026-09-12')(G.period('2026-09', '2026-09-12')));
ok('coverage: 90% rule', G.coverage(rows, { start: '2026-09-01', end: '2026-09-03' }).ok && !G.coverage(rows, { start: '2026-09-01', end: '2026-09-10' }).ok);
ok('fyMonths: July to the anchor month', JSON.stringify(G.fyMonths('2026-09-12')) === JSON.stringify(['2026-07', '2026-08', '2026-09']) && G.fyMonths('2026-02-01').length === 8);

// ---- benchmark: 14 synthetic complete months, GPAM% stepping 10..23, plus a partial month
const mk = (ym, gpamPct, days) => { const out = []; for (let d = 1; d <= days; d++) { const iso = `${ym}-${String(d).padStart(2, '0')}`; const nr = 1000; const ads = nr * (0.55 - gpamPct / 100); out.push(day(iso, { revenue: 1100, revExGst: nr, totalVC: 450, prodCost: 450, shipCost: 0, packaging: 0, txnFees: 0, merchFees: 0, totalAds: ads, metaTotal: ads, profit: nr - 450 - ads - 170 })); } return out; };
const months = [['2025-07', 10, 31], ['2025-08', 12, 31], ['2025-09', 13, 30], ['2025-10', 14, 31], ['2025-11', 22, 30], ['2025-12', 15, 31], ['2026-01', 16, 31], ['2026-02', 17, 28], ['2026-03', 18, 31], ['2026-04', 19, 30], ['2026-05', 20, 31], ['2026-06', 23, 30], ['2026-07', 11, 31], ['2026-08', 21, 31]];
let brows = []; months.forEach(([ym, g, n]) => brows = brows.concat(mk(ym, g, n))); brows = brows.concat(mk('2026-09', 30, 8));
const Bm = G.benchmark(brows, '2026-09-08');
ok('benchmark: counts only complete months', Bm.n === 14 && Bm.first === '2025-07' && Bm.last === '2026-08', [Bm.n, Bm.first, Bm.last]);
ok('benchmark: target is the trailing-12-month rate', Bm.t12 && near(Bm.ladder.target, Bm.t12.gpamPct) && Bm.ladder.target > 16 && Bm.ladder.target < 19, Bm.ladder);
ok('benchmark: floor is the 25th percentile of complete months', near(Bm.ladder.floor, Bm.rates.p25) && Bm.rates.p25 > 12 && Bm.rates.p25 < 15, Bm.rates);
ok('benchmark: stretch mirrors the floor around target', near(Bm.ladder.stretch, 2 * Bm.ladder.target - Bm.ladder.floor));
ok('benchmark: seasonal July is the mean of both Julys', near(Bm.seasonal[7].rate, 10.5) && Bm.seasonal[7].n === 2, Bm.seasonal[7]);
ok('benchmark: a never-observed month falls back to target', (() => { const B2 = G.benchmark(brows.filter(r => !r.date.startsWith('2025-11')), '2026-09-08'); return !B2.seasonal[11].observed && near(B2.seasonal[11].rate, B2.ladder.target); })());
ok('benchmark: forMonth carries the offsets', (() => { const f = Bm.forMonth(11); return near(f.target, 22) && near(f.target - f.floor, Bm.ladder.target - Bm.ladder.floor); })(), Bm.forMonth(11));
ok('benchmark: forWindow is revenue-weighted', near(Bm.forWindow([{ month: 7, netRevenue: 100 }, { month: 11, netRevenue: 300 }]).target, (10.5 * 100 + 22 * 300) / 400));
ok('benchmark: rates min/max span the months', near(Bm.rates.min, 10) && near(Bm.rates.max, 23));
ok('benchmark: with under a year it falls back to the all-months rate', (() => { const B3 = G.benchmark(brows.filter(r => r.date >= '2026-03-01'), '2026-09-08'); return B3.t12 === null && B3.ladder.target != null; })());

console.log(`gpam: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
