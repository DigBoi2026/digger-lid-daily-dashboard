/* =========================================================================
   DiggerLid — FY27 Plan page.

   The forecast part of the forecast report, condensed onto the board: the
   month just closed against last year, the next three months and the year by
   case, the quarterly profit targets, and how the forecast is made. The numbers
   are a snapshot (plan_data.js, rebuilt by `npm run plan` at each quarterly
   reforecast); the live figures are the month in progress, paced against that
   snapshot, and the profit targets, tracked year to date, both from data.js.
   ========================================================================= */
const PLAN = typeof window !== 'undefined' ? window.DL_PLAN : null;
const DATA = typeof window !== 'undefined' ? window.DL_DATA : null;
const C = typeof DLcore !== 'undefined' ? DLcore : require('./core.js');
const money = (n, c = true) => C.money(n, c);
const esc = s => C.esc(s);
const x = (a, b) => (a != null && b ? (a / b).toFixed(2) + '×' : '—');
const CASES = ['pessimistic', 'realistic', 'optimistic'];

/* Pace of the month in progress: actual revenue since the snapshot, against
   the forecast for the same days. Pure, so it is testable without a DOM. */
function pace(plan, daily) {
  const fc = new Map(plan.daily.map(d => [d[0], d]));
  let act = 0, n = 0, lo = 0, mid = 0, hi = 0, last = null;
  (daily || []).forEach(r => {
    if (!r || !r.date || r.date <= plan.asOf || r.pending || !(r.revenue > 0)) return;
    const f = fc.get(r.date);
    if (!f) return;
    act += r.revenue; lo += f[1]; mid += f[2]; hi += f[3]; n++; last = r.date > (last || '') ? r.date : last;
  });
  return n ? { days: n, through: last, actual: act, pessimistic: lo, realistic: mid, optimistic: hi,
               vsRealistic: act / mid - 1, band: act < lo ? 'below' : act > hi ? 'above' : 'inside' } : null;
}

/* The quarterly profit targets against the books: year-to-date profit and
   sales (ex GST) from 1 October, finished days only. A quarter is judged once
   the books reach its last day. Pure, so it is testable without a DOM. */
function targetStatus(plan, daily) {
  const rows = (daily || []).filter(r => r && r.date && !r.pending && r.revenue > 0);
  return ((plan && plan.targets) || []).map(t => {
    const own = rows.filter(r => r.date >= t.start && r.date <= t.end);
    const through = own.reduce((m, r) => (r.date > m ? r.date : m), '') || null;
    const actual = own.length ? own.reduce((s, r) => s + (+r.profit || 0), 0) : null;
    const sales = own.length ? own.reduce((s, r) => s + (+r.revExGst || 0), 0) : null;
    const status = !through || through < t.qStart ? 'not started'
      : through < t.end ? 'in progress'
      : sales < t.salesFloor ? 'below sales floor'
      : actual >= t.stretch ? 'beat stretch'
      : actual >= t.profit ? 'met' : 'missed';
    return Object.assign({}, t, { days: own.length, actual, sales, through, status });
  });
}

function kpiTile(lbl, val, sub, foot, cls) {
  return `<div class="kpi ${cls || ''}"><div class="k-head"><div class="k-lbl">${lbl}</div></div>` +
         `<div class="k-val">${val}</div><div class="k-sub">${sub}</div><div class="k-foot">${foot || ''}</div></div>`;
}

function renderKpis(p) {
  const m = p.lastMonth, a = m.actual, ly = m.lastYear, fy = p.fy.realistic.FY;
  const name = C.isoToNice ? C.isoToNice(m.month + '-01').replace(/^\d+\s*/, '') : m.month;
  const pc = pace(p, DATA && DATA.daily);
  const paceTile = pc
    ? kpiTile('Month to date vs forecast', (pc.vsRealistic >= 0 ? '+' : '') + (pc.vsRealistic * 100).toFixed(1) + '%',
        `${money(pc.actual)} actual · ${money(pc.realistic)} realistic`,
        `<span class="k-per">${pc.days} day${pc.days === 1 ? '' : 's'} to ${esc(pc.through)} · ${pc.band} the range</span>`,
        pc.band === 'below' ? 'bad' : pc.band === 'above' ? 'good' : 'accent')
    : kpiTile('Month to date vs forecast', '—', 'starts with the first day after ' + esc(p.asOf), '', 'accent');
  document.getElementById('kpis').innerHTML = [
    kpiTile(name + ' revenue', money(a.revenue), `last year <b>${money(ly.revenue)}</b>`, `<span class="k-per">${x(a.revenue, ly.revenue)} last year</span>`),
    kpiTile(name + ' profit', money(a.profit), `last year <b>${money(ly.profit)}</b>`, `<span class="k-per">ad spend ${money(a.adSpend)} · MER ${(a.revenue / a.adSpend).toFixed(2)}</span>`),
    paceTile,
    kpiTile('FY27 revenue · realistic', money(fy.revExGst), `ex GST · FY26 <b>${money(p.fy26.revExGst)}</b>`, `<span class="k-per">${x(fy.revExGst, p.fy26.revExGst)} FY26</span>`),
    kpiTile('FY27 profit · realistic', money(fy.profit), `range <b>${money(p.fy.pessimistic.FY.profit)}</b> to <b>${money(p.fy.optimistic.FY.profit)}</b>`, `<span class="k-per">${x(fy.profit, p.fy26.profit)} FY26</span>`),
  ].join('');
}

const trio = (o, k) => CASES.map(c => `<td class="${c === 'realistic' ? 'hi' : 'dim'}">${money(o.cases[c][k])}</td>`).join('');

function renderMonths(p) {
  const rows = k => p.months.map(m => `<tr><td class="nm">${esc(m.name.replace(' 2026', '').replace(' 2027', '').replace(', 17 Nov - 1 Dec', ' 17 Nov–1 Dec'))}</td>` +
    `${k === 'revenue' ? `<td class="dim">${money(m.adSpend)}</td>` : ''}${trio(m, k)}<td class="dim">${money(m.lastYear[k])}</td></tr>`).join('');
  document.getElementById('months').innerHTML =
    `<table class="pl-table"><thead><tr><th>Revenue</th><th>Ads</th><th>Pess</th><th>Real</th><th>Opt</th><th>LY</th></tr></thead><tbody>${rows('revenue')}</tbody></table>` +
    `<table class="pl-table"><thead><tr><th>Profit</th><th>Pess</th><th>Real</th><th>Opt</th><th>LY</th></tr></thead><tbody>${rows('profit')}</tbody></table>`;
}

function renderTargets(p) {
  const st = targetStatus(p, DATA && DATA.daily);
  if (!st.length) return '';
  const label = { Q2: 'Q2 to 31 Dec', Q3: 'Q3 to 31 Mar', Q4: 'Q4 to 30 Jun' };
  const cls = s => (s === 'beat stretch' || s === 'met' ? 'hi' : s === 'missed' || s === 'below sales floor' ? 'bad' : 'dim');
  const body = st.map(t => `<tr><td class="nm">${esc(label[t.q] || t.q)}</td><td>${money(t.profit)}</td><td class="dim">${money(t.stretch)}</td>` +
    `<td class="dim">${money(t.salesFloor)}</td><td>${t.actual == null || t.status === 'not started' ? '—' : money(t.actual)}</td><td class="${cls(t.status)}">${esc(t.status)}</td></tr>`).join('');
  const now = st.find(t => t.status === 'in progress');
  const nice = d => esc(C.isoToNice ? C.isoToNice(d) : d);
  return `<div class="pl-sub">Profit targets · year to date from 1 Oct</div>` +
    `<table class="pl-table pl-t"><thead><tr><th></th><th>Target</th><th>Stretch</th><th>Sales floor</th><th>Actual</th><th></th></tr></thead><tbody>${body}</tbody></table>` +
    (now ? `<div class="pl-note">To ${nice(now.through)}: <b>${money(now.actual)}</b> profit and ${money(now.sales)} sales (ex GST) against a ${money(now.profit)} target by ${nice(now.end)}. ` +
           `Targets are the realistic case at ${nice(p.asOf)}, stretch +40%, sales floor 85% of plan; fixed for the year.</div>` : '');
}

function renderQuarters(p) {
  const qs = ['Q1', 'Q2', 'Q3', 'Q4'];
  const cell = v => `${money(v.revExGst)}<span class="pl-p">${money(v.profit)}</span>`;
  const label = { Q1: 'Q1 Jul–Sep', Q2: 'Q2 Oct–Dec', Q3: 'Q3 Jan–Mar', Q4: 'Q4 Apr–Jun' };
  const body = qs.map(q => {
    const f26 = p.fy26.q[q];
    return `<tr><td class="nm">${label[q]}${q < 'Q2' ? ' <i>actual</i>' : ''}</td><td class="dim">${cell({ revExGst: f26[0], profit: f26[1] })}</td>` +
      CASES.map(c => `<td class="${c === 'realistic' ? 'hi' : 'dim'}">${cell(p.fy[c][q])}</td>`).join('') + '</tr>';
  }).join('');
  const fy = `<tr class="tot"><td class="nm">FY27</td><td class="dim">${cell({ revExGst: p.fy26.revExGst, profit: p.fy26.profit })}</td>` +
    CASES.map(c => `<td class="${c === 'realistic' ? 'hi' : 'dim'}">${cell(p.fy[c].FY)}</td>`).join('') + '</tr>';
  const r = p.fy.realistic.FY, acc = p.accuracy;
  document.getElementById('quarters').innerHTML =
    `<table class="pl-table pl-q"><thead><tr><th></th><th>FY26</th><th>Pess</th><th>Real</th><th>Opt</th></tr></thead><tbody>${body}${fy}</tbody></table>` +
    `<div class="pl-note">Realistic is <b>${x(r.revExGst, p.fy26.revExGst)}</b> FY26 revenue and <b>${x(r.profit, p.fy26.profit)}</b> FY26 profit. ` +
    `Across ${acc.n30} forecasts since May the model misses by <b>${(acc.mape30 * 100).toFixed(1)}%</b> at 30 days and runs ` +
    `${(Math.abs(acc.bias30) * 100).toFixed(1)}% ${acc.bias30 < 0 ? 'low' : 'high'}: actual has come in up to ` +
    `${(acc.pessimisticBelow * 100).toFixed(0)}% below and ${(acc.optimisticAbove * 100).toFixed(0)}% above it.</div>` +
    renderTargets(p);
}

function renderHow(p) {
  const sp = p.spendPlan, rt = p.rates;
  document.getElementById('howto').innerHTML =
    `<ol class="pl-steps">` +
    `<li><b>Last year's same days</b>, matched 364 days back so weekdays, Father's Day and Black Friday line up; a sale whose dates move is matched part by part.</li>` +
    `<li><b>× how far ahead we are running</b>: the last 28 days against the same days last year.</li>` +
    `<li><b>× the spend plan</b>: revenue follows ad spend, so a month planned above today's growth in spend grows faster, and below it, slower.</li>` +
    `<li><b>Profit</b> = revenue × ${(rt.contribution * 100).toFixed(1)}% contribution − ad spend − ${money(rt.fixedPerDay, false)} a day fixed.</li>` +
    `<li><b>The range</b> is the model's own measured misses, plus cautious assumptions in the pessimistic case.</li></ol>` +
    `<div class="pl-sub">Spend plan</div><div class="pl-note">${money(sp.preSale)} a day to the hype · ${money(sp.saleBudget)} for BFCM ` +
    `(${esc(p.sale.hype[0].slice(5))} to ${esc(p.sale.sale[1].slice(5))}) · ${money(sp.dec)} a day in Dec · ${money(sp.jan)} in Jan · last year's pattern to EOFY.</div>` +
    `<div class="pl-sub">Watch</div><ul class="pl-watch">` +
    (rt.growth ? `<li>Growth fading: the forecast holds today's ${((rt.growth - 1) * 100).toFixed(0)}% same-day growth through January; ` +
      `each 10 points less is about ${money(p.growthSensitivity)} less Nov–Jan profit.</li>` : '') +
    `<li>The spend plan: each $10K off the BFCM budget is about $37K less revenue.</li>` +
    `<li>BFCM has never been backtested; the range is wide for that reason.</li>` +
    `<li>December loses money in all but the optimistic case: fixed costs, not the ads.</li></ul>`;
}

function render() {
  if (!PLAN) { document.getElementById('errBox').classList.add('show'); return; }
  const through = DATA && DATA.meta && DATA.meta.latestDataDate;
  document.getElementById('asOfLbl').textContent = 'Forecast as at ' + (C.isoToNice ? C.isoToNice(PLAN.asOf) : PLAN.asOf);
  document.getElementById('throughVal').textContent = through ? (C.isoToNice ? C.isoToNice(through) : through) : '—';
  renderKpis(PLAN); renderMonths(PLAN); renderQuarters(PLAN); renderHow(PLAN);
  document.getElementById('footSource').textContent = `Forecast snapshot ${PLAN.asOf} · ${PLAN.builtFrom}`;
  if (DATA && DATA.meta && C.stampSnapshotAge) C.stampSnapshotAge(DATA.meta);
}

if (typeof document !== 'undefined') render();
if (typeof module !== 'undefined' && module.exports) module.exports = { pace, targetStatus };
