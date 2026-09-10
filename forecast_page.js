/* =========================================================================
   DiggerLid — Forecast.

   The board's other pages answer "what happened". This one answers "what is
   about to", which for this business is a different question than it looks:
   in 2025, June and November earned +$48,917 and +$103,174 while the other
   seven months lost $50,772 between them. The year is made in two months.

   All of the modelling lives in forecast.js (unit-tested by
   source/test_forecast.js). This file is the page: it feeds the engine the two
   books, renders the answer, and — the part that matters most — renders what
   the answer does NOT know. A forecast page that shows only numbers is a page
   that will be believed more than it deserves.
   ========================================================================= */
const { MONTH_ABBR, isoToNice, pendingOf, pendingLabel } = DLcore;
const F = window.DLforecast;

const API_URL = '/api/data';
const REFRESH_MINUTES = 30;
const MOD_KEY = 'dl_forecast_modifiers';
const OFF_KEY = 'dl_forecast_sale_off';       // sale periods the user has switched off
const EDIT_KEY = 'dl_forecast_sale_edit';     // and lifts they have re-sized

const S = { scen: 'realistic', hor: 90, live: 'snap',
            mods: [], saleOff: [], saleEdit: {}, sale: [], ceiling: null };
let DATA = window.DL_DATA || null;
const PRIOR = window.DL_PRIOR || null;
let CHART = null;
let BT = null;                       // measured backtest, filled in after first paint

/* ---- formatters ---- */
const money = (n, c = false) => {
  if (n == null || isNaN(n)) return '—';
  if (c) { const a = Math.abs(n), s = n < 0 ? '-$' : '$';
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
    return s + Math.round(a); }
  return n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
};
const pct = (n, d = 1) => n == null || isNaN(n) ? '—' : (n > 0 ? '+' : '') + n.toFixed(d) + '%';
const mult = n => n == null || isNaN(n) ? '—' : 'x' + n.toFixed(2);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const yesterdayISO = () => { const t = new Date(); t.setDate(t.getDate() - 1); t.setHours(0, 0, 0, 0); return t.toISOString().slice(0, 10); };
const niceFull = iso => { const [y, m, d] = iso.split('-').map(Number); return d + ' ' + MONTH_ABBR[m - 1] + ' ' + y; };
const monthLabel = ym => MONTH_ABBR[+ym.slice(5, 7) - 1] + " '" + ym.slice(2, 4);

/* ------------------------------------------------------------------ data */

/* The two books, merged. 2026 comes from the live sheet (or the snapshot);
   2025 is static — the year is closed and there is nothing left to refresh —
   so prior_year.js ships as a file rather than a fetch. Where they overlap,
   the live book wins. */
function rows() {
  const map = new Map();
  ((PRIOR && PRIOR.daily) || []).forEach(d => { if (d && d.date) map.set(d.date, d); });
  ((DATA && DATA.daily) || []).forEach(d => { if (d && d.date) map.set(d.date, d); });
  return [...map.values()].filter(d => d.revenue > 0).sort((a, b) => a.date < b.date ? -1 : 1);
}

/* Where the forecast starts.

   Not simply the newest row. A day the sheet has not finished — revenue typed,
   ad spend not yet — is a real day of trade with a fictional cost side, and
   anchoring a forecast on it would take the fiction as the present. So the
   anchor walks back to the last COMPLETE day, exactly as the trailing windows
   on the other pages do. */
function anchorOf(list) {
  const cap = Math.min(yesterdayISO(), (DATA && DATA.meta && DATA.meta.latestDataDate) || '9999');
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].date <= cap && !list[i].pending) return list[i].date;
  }
  return list.length ? list[list.length - 1].date : null;
}

function horizonDays(from) {
  if (S.hor !== 'EOY') return S.hor;
  const end = Date.UTC(+from.slice(0, 4), 11, 31);
  return Math.max(1, Math.round((end - Date.parse(from + 'T00:00:00Z')) / 86400000));
}

/* Same dates last year, so a 22-day stub of September is never compared to a
   whole September. Getting this wrong once read a +132% month as -32%. */
function priorSameDates(list, from, to) {
  const by = {}; list.forEach(r => by[r.date] = r.revenue);
  const back = d => { const t = new Date(d + 'T00:00:00Z'); t.setUTCFullYear(t.getUTCFullYear() - 1); return t.toISOString().slice(0, 10); };
  let s = 0, n = 0, miss = 0;
  for (let d = from; d <= to; d = F.addDays(d, 1)) {
    const p = by[back(d)];
    if (p != null) { s += p; n++; } else miss++;
  }
  return { sum: n ? s : null, days: n, missing: miss };
}

/* Recurring sale periods, measured from the book and dated for every year the
   data touches plus the two ahead, so a horizon that crosses into next
   September still knows what happens there.

   These are ON by default, and that is a deliberate choice rather than a
   convenience. Leaving a promotion the business demonstrably ran out of the
   model is not neutral — it silently treats a fortnight of discounting as the
   new run rate. On 2026-09-08 that put the level 33% above the pre-promotion
   trade and projected October to December at x2.0-x2.3 on last year, when
   August measured BEFORE the promotion ran x1.69, in line with May's x1.77,
   June's x1.72 and July's x1.51. Switching one off is one click, and the choice
   is remembered. */
function refreshSalePeriods() {
  const list = rows();
  if (!list.length) { S.sale = []; return; }
  const years = new Set(list.map(r => r.date.slice(0, 4)));
  const thisYear = +list[list.length - 1].date.slice(0, 4);
  years.add(String(thisYear + 1));
  try {
    S.sale = F.salePeriodModifiers(list, { years: [...years].sort(), overrides: S.saleEdit });
    if (S.ceiling == null) S.ceiling = F.observedCeiling(list);
  } catch (e) { S.sale = []; }
}

function activeSale() {
  return S.sale.filter(m => S.saleOff.indexOf(m.key) === -1);
}

/* Everything project() should apply, seeded and typed together. Typed lifts
   arrive as percentages from the form; seeded ones are already fractions. */
function allMods() {
  return activeSale().concat(S.mods.map((m, i) => ({
    key: 'user:' + i, kind: 'user', name: m.name,
    start: m.start, end: m.end, lift: m.lift / 100,
    payback: m.payback ? m.payback / 100 : 0,
    paybackEnd: m.payback ? F.addDays(m.end, 14) : null,
  })));
}

function run(scen, hor) {
  const list = rows();
  const from = anchorOf(list);
  if (!from) return null;
  return F.projectPnl({ rows: list, from, horizon: hor || horizonDays(from),
                        scenario: scen || S.scen, modifiers: allMods(), observedCeiling: S.ceiling });
}

/* ------------------------------------------------------------------- KPIs */

function renderKpis(p, ctx) {
  const el = document.getElementById('kpis');
  const ly = priorSameDates(ctx.list, F.addDays(p.from, 1), F.addDays(p.from, p.horizon));
  const yoy = ly.sum ? (p.total / ly.sum - 1) * 100 : null;
  const nov = p.months.find(m => m.month.slice(5) === '11');
  const eoy = ctx.eoy;
  const label = S.hor === 'EOY' ? 'to year end' : 'next ' + p.horizon + ' days';

  const tiles = [
    { lbl: 'Revenue · ' + label, val: money(p.total, true), accent: true,
      sub: ly.sum ? 'same dates last year <b>' + money(ly.sum, true) + '</b>' : 'no prior year for these dates',
      foot: yoy != null ? '<span class="delta ' + (yoy > 0 ? 'up' : 'down') + '">' + (yoy > 0 ? '▲' : '▼') + ' ' + Math.abs(yoy).toFixed(0) + '%</span> vs last year' : '' },
    { lbl: 'Profit · ' + label, val: money(p.profit, true),
      sub: 'margin <b>' + (p.total ? (p.profit / p.total * 100).toFixed(1) + '%' : '—') + '</b>',
      foot: p.profit < 0 ? '<span class="delta down">below breakeven</span>' : '<span class="delta up">above breakeven</span>' },
    { lbl: 'Ad spend · ' + label, val: money(p.adSpend, true),
      sub: 'at <b>' + (p.adSpend ? (p.total / p.adSpend).toFixed(2) + 'x' : '—') + '</b> MER',
      foot: (p.pnl ? (p.pnl.adRate * 100).toFixed(1) + '% of revenue, seasonally shaped' : '') },
    { lbl: 'November', val: nov ? money(nov.revenue, true) : '—',
      sub: nov ? 'profit <b>' + money(nov.profit, true) + '</b>' : 'outside this horizon',
      foot: nov ? '<span class="delta flat">one prior November</span>' : '<span class="delta flat">widen the horizon</span>' },
    { lbl: 'Year end total', val: eoy ? money(eoy.revenue, true) : '—',
      sub: eoy ? 'actual to date <b>' + money(eoy.actual, true) + '</b>' : '',
      foot: eoy ? 'profit <b>' + money(eoy.profit, true) + '</b> for 2026' : '' },
    { lbl: 'Breakeven', val: p.breakevenPerDay ? money(p.breakevenPerDay, true) + '<small>/day</small>' : '—',
      sub: p.pnl ? 'fixed <b>' + money(p.pnl.fcPerDay, true) + '/day</b>' : '',
      foot: p.breakevenPerDay ? money(p.breakevenPerDay * 30, true) + ' a month to stand still' : '' },
  ];
  el.innerHTML = tiles.map(t => `<div class="kpi${t.accent ? ' accent' : ''}">
      <div class="k-top"><div class="k-lbl">${t.lbl}</div></div>
      <div class="k-val">${t.val}</div>
      <div class="k-sub">${t.sub || ''}</div>
      <div class="k-foot">${t.foot || ''}</div>
    </div>`).join('');
}

const nearestHorizon = h => [30, 60, 90].reduce((a, b) => Math.abs(b - h) < Math.abs(a - h) ? b : a);

/* -------------------------------------------------------------- scenarios */

function renderScenarios(ctx) {
  const el = document.getElementById('scenList');
  const defs = [
    ['pessimistic', 'Growth stops dead, and the big months land 15% short.'],
    ['realistic',   'The current trajectory continues; events repeat as they have.'],
    ['optimistic',  'Growth holds at its year-on-year rate, events scale with it.'],
  ];
  el.innerHTML = defs.map(([k, why]) => {
    const p = ctx.scen[k];
    const on = k === S.scen;
    return `<button class="scenrow${on ? ' on' : ''}" data-scen="${k}">
      <div class="sr-top"><span class="sr-name">${k}</span><span class="sr-rev">${money(p.total, true)}</span></div>
      <div class="sr-bot"><span class="sr-why">${why}</span><span class="sr-pr ${p.profit < 0 ? 'neg' : 'pos'}">${money(p.profit, true)}</span></div>
    </button>`;
  }).join('');
  el.querySelectorAll('.scenrow').forEach(b => b.onclick = () => { S.scen = b.dataset.scen; render(); });

  const p = ctx.scen[S.scen];
  document.getElementById('scenNote').textContent =
    'spread ' + money(ctx.scen.optimistic.total - ctx.scen.pessimistic.total, true) + ' of revenue';
  document.getElementById('beVal').textContent = p.breakevenPerDay ? money(p.breakevenPerDay, true) + '/d' : '—';
  document.getElementById('beSub').textContent = p.pnl
    ? 'to cover ads + ' + money(p.pnl.fcPerDay, true) + ' fixed' : '';

  const b30 = BT && BT[30], b90 = BT && BT[90];
  document.getElementById('acc30').textContent = b30 ? '±' + (b30.mape * 100).toFixed(0) + '%' : '…';
  document.getElementById('acc30Sub').textContent = b30 ? b30.n + ' past origins' : 'measuring';
  document.getElementById('acc90').textContent = b90 ? '±' + (b90.mape * 100).toFixed(0) + '%' : '…';
  document.getElementById('acc90Sub').textContent = b90 ? b90.n + ' past origins' : 'measuring';
}

/* ------------------------------------------------------------------ chart */

function smooth(vals, n) {
  return vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - n + 1), i + 1).filter(v => v != null);
    return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
}

function renderChart(p, ctx) {
  const wrap = document.getElementById('chartWrap');
  const cv = document.getElementById('fcChart');
  if (!cv || !wrap.clientHeight) return;
  if (typeof Chart === 'undefined') {
    document.getElementById('chartNote').textContent = 'chart library unavailable — the numbers below are unaffected';
    return;
  }
  const HIST = 56;
  const hist = ctx.list.filter(r => r.date <= p.from).slice(-HIST);
  const labels = hist.map(r => r.date).concat(p.days.map(d => d.date));
  const actual = smooth(hist.map(r => r.revenue), 7);
  const pad = new Array(hist.length - 1).fill(null);

  const fc = smooth(hist.slice(-6).map(r => r.revenue).concat(p.days.map(d => d.revenue)), 7).slice(6);
  const fcSeries = pad.concat([actual[actual.length - 1]], fc);

  const b = BT && BT[nearestHorizon(p.horizon)];
  const lo = b ? fc.map(v => v * (1 + b.p10)) : null;
  const hi = b ? fc.map(v => v * (1 + b.p90)) : null;

  const ds = [];
  if (lo) {
    ds.push({ label: 'low', data: pad.concat([actual[actual.length - 1]], lo), borderWidth: 0,
      pointRadius: 0, backgroundColor: 'rgba(245,235,25,0.10)', fill: '+1' });
    ds.push({ label: 'high', data: pad.concat([actual[actual.length - 1]], hi), borderWidth: 0,
      pointRadius: 0, fill: false });
  }
  ds.push({ label: 'Actual', data: actual.concat(new Array(p.days.length).fill(null)),
    borderColor: 'rgba(245,235,25,0.95)', borderWidth: 2.4, pointRadius: 0, tension: .3, fill: false });
  ds.push({ label: 'Forecast', data: fcSeries, borderColor: 'rgba(245,235,25,0.95)',
    borderDash: [5, 4], borderWidth: 2.4, pointRadius: 0, tension: .3, fill: false });

  if (CHART) CHART.destroy();
  const grid = 'rgba(255,255,255,0.06)', tick = 'rgba(179,171,172,0.8)';
  CHART = new Chart(cv.getContext('2d'), {
    type: 'line',
    data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: i => i.dataset.label === 'Actual' || i.dataset.label === 'Forecast',
          callbacks: {
            title: it => niceFull(it[0].label),
            label: i => i.dataset.label + ': ' + money(i.parsed.y, true) + '/day',
          },
        },
      },
      scales: {
        x: { grid: { color: grid }, ticks: { color: tick, maxTicksLimit: 8,
             callback(v) { const d = this.getLabelForValue(v); return d ? isoToNice(d) : ''; } } },
        y: { grid: { color: grid }, ticks: { color: tick, callback: v => money(v, true) }, beginAtZero: true },
      },
    },
  });
  document.getElementById('chartSpan').textContent =
    '· ' + isoToNice(hist[0].date) + ' → ' + isoToNice(p.days[p.days.length - 1].date);
  document.getElementById('chartNote').textContent = b
    ? '7-day average · band is the measured p10–p90 backtest error at ' + nearestHorizon(p.horizon) + ' days'
    : '7-day average · measuring the error band…';
}

/* ------------------------------------------------------------ month table */

function renderMonths(p, ctx) {
  const el = document.getElementById('monthTable');
  const rowsHtml = p.months.map(m => {
    const ds = p.days.filter(d => d.month === m.month);
    const ly = priorSameDates(ctx.list, ds[0].date, ds[ds.length - 1].date);
    const r = ly.sum ? m.revenue / ly.sum : null;
    const nObs = (p.basis.season.observations[+m.month.slice(5, 7)]) || 0;
    /* An index fitted on one year is a guess with a sample size, and November's
       is the one the whole year-end number hangs on. Say the number out loud
       rather than letting the forecast imply more confidence than it has. */
    const conf = nObs >= 2 ? '<span class="cf ok">2 yrs</span>'
               : nObs === 1 ? '<span class="cf thin">1 yr</span>'
               : '<span class="cf none">no history</span>';
    return `<div class="trow">
      <div class="c1">${monthLabel(m.month)}<small>${m.days}d</small></div>
      <div class="c2">${money(m.revenue, true)}</div>
      <div class="c3">${ly.sum ? money(ly.sum, true) : '—'}</div>
      <div class="c4 ${r == null ? '' : r >= 1 ? 'pos' : 'neg'}">${r == null ? '—' : mult(r)}</div>
      <div class="c5 ${m.profit < 0 ? 'neg' : 'pos'}">${money(m.profit, true)}</div>
      <div class="c6">${(m.margin * 100).toFixed(1)}%</div>
      <div class="c7">${conf}</div>
    </div>`;
  }).join('');
  const lyAll = priorSameDates(ctx.list, F.addDays(p.from, 1), F.addDays(p.from, p.horizon));
  const rAll = lyAll.sum ? p.total / lyAll.sum : null;
  const total = `<div class="trow tot">
      <div class="c1">Total<small>${p.horizon}d</small></div>
      <div class="c2">${money(p.total, true)}</div>
      <div class="c3">${lyAll.sum ? money(lyAll.sum, true) : '—'}</div>
      <div class="c4 ${rAll == null ? '' : rAll >= 1 ? 'pos' : 'neg'}">${rAll == null ? '—' : mult(rAll)}</div>
      <div class="c5 ${p.profit < 0 ? 'neg' : 'pos'}">${money(p.profit, true)}</div>
      <div class="c6">${p.total ? (p.profit / p.total * 100).toFixed(1) : '—'}%</div>
      <div class="c7"></div>
    </div>`;
  el.innerHTML = `<div class="thead">
      <div class="c1">Month</div><div class="c2">Revenue</div><div class="c3">Last yr</div>
      <div class="c4">vs</div><div class="c5">Profit</div><div class="c6">Margin</div><div class="c7">Basis</div>
    </div>${rowsHtml}${total}`;
  document.getElementById('monthNote').textContent =
    'vs the same dates last year · ' + S.scen;
}

/* ------------------------------------------------------ seasonal trend */

/* The fitted baseline, month by month. Not a control: there is no switching
   this off, because it is not an adjustment to the forecast — it IS the
   forecast's shape. Shown in full rather than only for the horizon, because the
   number a reader needs to judge November is how many Novembers there were. */
function renderSeason(p) {
  const el = document.getElementById('seasonTable');
  const s = p.basis.season;
  const inHor = new Set(p.months.map(m => +m.month.slice(5, 7)));
  const byMonth = {};
  F.EVENTS.forEach(e => { if (e.via === 'index') byMonth[e.month] = e.name; });
  const rowsHtml = [];
  for (let m = 1; m <= 12; m++) {
    const n = s.observations[m] || 0;
    const idx = s.index[m];
    const conf = n >= 2 ? '<span class="cf ok">2 yrs</span>'
               : n === 1 ? '<span class="cf thin">1 yr</span>'
               : '<span class="cf none">none</span>';
    rowsHtml.push(`<div class="trow${inHor.has(m) ? ' hit' : ''}">
      <div class="c1">${MONTH_ABBR[m - 1]}</div>
      <div class="c2">${n ? idx.toFixed(2) : '—'}</div>
      <div class="c3">${byMonth[m] ? esc(byMonth[m]) : ''}</div>
      <div class="c4">${conf}</div>
    </div>`);
  }
  el.innerHTML = `<div class="thead"><div class="c1">Month</div><div class="c2">Index</div>
      <div class="c3">Why</div><div class="c4">Basis</div></div>${rowsHtml.join('')}`;

  const thin = [];
  for (let m = 1; m <= 12; m++) if ((s.observations[m] || 0) <= 1) thin.push(MONTH_ABBR[m - 1]);
  document.getElementById('seasonWarn').innerHTML =
    `<div class="bwarn"><b>One year only:</b> ${esc(thin.join(', '))}. November matters most —
       the year-end number leans on it, and no backtest reaches it, because no origin in
       the data has a horizon that gets to October.</div>`;
  document.getElementById('seasonNote').textContent =
    (p.basis.season.cells || 0) + ' months fitted';
}

/* -------------------------------------------------------- sale periods */

/* Measured, recurring, dated by rule. The lift is a FACT about the past for a
   year that has happened, and an editable expectation for one that has not —
   so the input is offered either way but says which it is. */
function renderSales(p) {
  const el = document.getElementById('saleList');
  const horFrom = F.addDays(p.from, 1), horTo = F.addDays(p.from, p.horizon);
  const runsFor = key => (p.modifierEffect.runs || []).filter(r => r.keys.indexOf(key) !== -1);

  el.innerHTML = S.sale.map(m => {
    const off = S.saleOff.indexOf(m.key) !== -1;
    const live = (m.paybackEnd || m.end) >= horFrom && m.start <= horTo;
    const other = (m.measured.allYears || []).filter(y => y.year !== m.measured.from);
    const ov = runsFor(m.key);
    const past = m.end <= p.from;
    return `<div class="catrow sale${off ? ' off' : ''}">
      <div class="cinfo">
        <div class="cname">${esc(m.name)}
          ${m.overridden ? '<small class="yours">yours</small>'
            : m.measured.own ? '<small>measured</small>' : '<small>carried fwd</small>'}</div>
        <div class="cmeta">${isoToNice(m.start)} → ${isoToNice(m.end)}${m.paybackEnd
          ? ', payback to ' + isoToNice(m.paybackEnd) : ', no payback'}
          ${m.measured.lift != null ? '· book says ' + pct(m.measured.lift * 100, 0) : '· no precedent'}
          ${other.length ? '(' + other.map(y => y.year + ' ' + pct(y.lift * 100, 0)).join(', ') + ')' : ''}
          ${ov.length ? '<b class="ovl">overlaps ' + ov.reduce((a, r) => a + r.days, 0) + 'd with ' +
             esc(ov[0].names.filter(n => n !== m.name).join(', ')) + '</b>' : ''}</div>
        <div class="saleedit">
          <label>Lift <input type="number" step="5" data-sale-lift="${esc(m.key)}"
            value="${Math.round(m.lift * 100)}" ${past ? 'disabled' : ''} aria-label="Lift percent" />%</label>
          <label>Payback <input type="number" step="5" data-sale-pay="${esc(m.key)}"
            value="${Math.round((m.payback || 0) * 100)}" ${past ? 'disabled' : ''} aria-label="Payback percent" />%</label>
          ${m.overridden && !past ? `<button class="salereset" data-sale-reset="${esc(m.key)}">reset</button>` : ''}
        </div>
      </div>
      <div class="cright">
        ${off ? '<span class="cf none">off</span>'
          : live ? '<span class="cf ok">applied</span>' : '<span class="cf thin">outside</span>'}
        <button class="modx" data-sale="${esc(m.key)}"
          aria-label="${off ? 'Switch on' : 'Switch off'} ${esc(m.name)}">${off ? '+' : '✕'}</button>
      </div>
    </div>`;
  }).join('') || '<div class="empty">No sale period measurable in the book yet.</div>';

  el.querySelectorAll('[data-sale]').forEach(b => b.onclick = () => {
    const k = b.dataset.sale, at = S.saleOff.indexOf(k);
    if (at === -1) S.saleOff.push(k); else S.saleOff.splice(at, 1);
    saveMods(); render();
  });
  /* `change`, not `input`: re-rendering the board on every keystroke would take
     the focus out of the field being typed into. */
  el.querySelectorAll('[data-sale-lift]').forEach(i => i.onchange = () => {
    setSaleOverride(i.dataset.saleLift, 'lift', parseFloat(i.value));
  });
  el.querySelectorAll('[data-sale-pay]').forEach(i => i.onchange = () => {
    setSaleOverride(i.dataset.salePay, 'payback', parseFloat(i.value));
  });
  el.querySelectorAll('[data-sale-reset]').forEach(b => b.onclick = () => {
    delete S.saleEdit[b.dataset.saleReset]; saveMods(); render();
  });

  const nLive = activeSale().filter(m => (m.paybackEnd || m.end) >= horFrom && m.start <= horTo).length;
  document.getElementById('saleNote').textContent =
    nLive ? nLive + ' applied in this horizon' : 'none in this horizon';

  const lc = levelCorrected(p);
  document.getElementById('saleWarn').innerHTML = lc ? (() => {
    const bare = uncorrectedLevel(p);
    return `<div class="bwarn"><b>Level corrected:</b> ${esc(lc.name)} is divided out before
      anything is fitted, taking the level from ${money(bare)} to ${money(p.level)} a day
      (${pct((p.level / bare - 1) * 100, 0)}). The three weeks of August before it ran x1.69 on
      last year, in line with May's x1.77 and June's x1.72; the promotion fortnight ran x2.93.
      Direction certain, size less so — an independent estimate lands about 9% above.</div>`;
  })() : `<div class="bwarn">No sale period touches the window the level is measured over,
      so the level is an ordinary trading baseline.</div>`;
}

function setSaleOverride(key, field, val) {
  if (isNaN(val)) return;
  const base = S.sale.find(m => m.key === key);
  if (!base) return;
  const e = S.saleEdit[key] || (S.saleEdit[key] = {});
  e[field] = val / 100;
  /* Switching a payback off has to clear the window too, or the modifier keeps a
     date range with a zero factor in it and the overlap report counts days that
     do nothing. */
  if (field === 'payback' && val === 0) e.paybackDays = null;
  else if (field === 'payback' && !e.paybackDays && !base.paybackEnd) {
    e.paybackDays = 14;                       // a window to put the number in
  }
  saveMods(); render();
}

/* --------------------------------------------------------- modifiers */

/* Your assertions about the future. Nothing here is measured and nothing here
   is defaulted on: the data cannot check a launch that has not happened. */
function renderMods(p) {
  const el = document.getElementById('modList');
  const runsFor = key => (p.modifierEffect.runs || []).filter(r => r.keys.indexOf(key) !== -1);
  el.innerHTML = S.mods.map((m, i) => {
    const ov = runsFor('user:' + i);
    return `<div class="catrow mod">
      <div class="cinfo"><div class="cname">${esc(m.name)} <small class="yours">yours</small></div>
        <div class="cmeta">${isoToNice(m.start)} → ${isoToNice(m.end)} at ${pct(m.lift, 0)}${
          m.payback ? ', then ' + pct(m.payback, 0) + ' for 14 days' : ''}
          ${ov.length ? '<b class="ovl">overlaps ' + ov.reduce((a, r) => a + r.days, 0) + 'd with ' +
             esc(ov[0].names.filter(n => n !== m.name).join(', ')) + '</b>' : ''}</div></div>
      <div class="cright"><button class="modx" data-i="${i}" aria-label="Remove ${esc(m.name)}">✕</button></div>
    </div>`;
  }).join('') || `<div class="empty">Nothing added. A launch, a price change, a channel
     going live — anything the last two years cannot know about.</div>`;
  el.querySelectorAll('.modx[data-i]').forEach(b => b.onclick = () => {
    S.mods.splice(+b.dataset.i, 1); saveMods(); render();
  });
  document.getElementById('modNote').textContent = S.mods.length
    ? S.mods.length + ' applied' : 'what the data cannot know';
  renderCombined(p);
}

/* The combined effect, stated rather than left to be inferred.

   Factors multiply, so two declarations over the same days compound: a +47%
   sale period and a +30% launch make +91%, not +77%. That is the standard
   treatment of independent proportional effects and it is what each measured
   lift already is — but it is also the easiest way to forecast a number with no
   precedent by accident, so every overlap is named and the peak is compared
   against the largest lift the book has ever recorded. Not capped: the
   assertion is the user's, and clipping it quietly would be worse than a large
   number they can see. */
function renderCombined(p) {
  const e = p.modifierEffect, el = document.getElementById('combined');
  if (!e || !e.runs.length) {
    const n = (p.modifiers || []).length;
    el.innerHTML = n
      ? `<div class="comb"><span class="l">Combined</span> ${n} declaration${n > 1 ? 's' : ''}, none overlapping</div>`
      : '';
    return;
  }
  const days = e.runs.reduce((a, r) => a + r.days, 0);
  el.innerHTML = `<div class="comb${e.beyondBook ? ' warn' : ''}">
      <span class="l">Combined</span> ${days} overlapping day${days > 1 ? 's' : ''} ·
      peak ${pct((e.peak - 1) * 100, 0)}
      ${e.ceiling ? '(biggest ever recorded ' + pct((e.ceiling - 1) * 100, 0) + ')' : ''}
      ${e.beyondBook ? '<b>— past anything recorded</b>' : ''}
      <div class="cruns">${e.runs.map(r => isoToNice(r.start) + '–' + isoToNice(r.end) +
        ' ' + esc(r.names.join(' + ')) + ' → ' + pct((r.peak - 1) * 100, 0) +
        (Math.abs(r.peak - r.low) > 0.02 ? ' … ' + pct((r.low - 1) * 100, 0) : '')).join('<br>')}</div>
    </div>`;
}

/* Three separate declarations, three separate keys. A sale period the user
   switched off, a lift they re-sized, and a modifier they typed are different
   kinds of decision, and merging them into one blob would mean a change to the
   shape of any of them silently discarding the other two. */
function saveMods() {
  try {
    localStorage.setItem(MOD_KEY, JSON.stringify(S.mods));
    localStorage.setItem(OFF_KEY, JSON.stringify(S.saleOff));
    localStorage.setItem(EDIT_KEY, JSON.stringify(S.saleEdit));
  } catch (e) { /* private mode, or site data blocked — the page still works */ }
}
function loadMods() {
  try { const v = JSON.parse(localStorage.getItem(MOD_KEY) || '[]'); if (Array.isArray(v)) S.mods = v; }
  catch (e) { S.mods = []; }
  try { const v = JSON.parse(localStorage.getItem(OFF_KEY) || '[]'); if (Array.isArray(v)) S.saleOff = v; }
  catch (e) { S.saleOff = []; }
  try { const v = JSON.parse(localStorage.getItem(EDIT_KEY) || '{}');
        if (v && typeof v === 'object' && !Array.isArray(v)) S.saleEdit = v; }
  catch (e) { S.saleEdit = {}; }
}

/* --------------------------------------------------------------- notes */

/* HOW THIS FORECAST WORKS — a diagram and the arithmetic, nothing else.

   This was nine sections of prose. Prose was the wrong instrument: the thing a
   reader needs is the SHAPE of the calculation — what feeds what, in what order
   — and a paragraph can only describe a shape one clause at a time. A diagram
   shows it at once, and the formula underneath it is the same thing again in
   twelve lines, with every symbol carrying its live value.

   The numbers come from the projection currently on screen, so this cannot
   drift out of date the way a written page would. */

const SYM = {
  L: 'run rate', g: 'drift', D: 'weekday', S: 'month',
  Y: 'year on year', M: 'modifiers', w: 'blend',
  c: 'contribution', a: 'ad rate', F: 'fixed cost',
};

function renderNotes(p) {
  const el = document.getElementById('notesBody');
  const b = p.basis, pnl = p.pnl, g = b.growth;
  const dowVals = Object.keys(b.dowIdx).map(k => b.dowIdx[k]);
  const seaVals = [];
  for (let m = 1; m <= 12; m++) if (b.season.observations[m]) seaVals.push(b.season.index[m]);
  const rng = a => Math.min.apply(null, a).toFixed(2) + '–' + Math.max.apply(null, a).toFixed(2);
  const b30 = BT && BT[30], b90 = BT && BT[90];
  const lc = levelCorrected(p);
  const nMods = (p.modifiers || []).length;

  /* ---- the diagram -------------------------------------------------------
     Hand-authored SVG rather than a library: it is one fixed picture of one
     fixed pipeline, and the whole point is that it shows the real mechanism —
     including the two things a box-and-arrow sketch usually leaves out, that
     history is corrected BEFORE anything is fitted, and that the same M does
     both the dividing and the multiplying. */
  const W = 760, H = 592;
  const box = (x, y, w, h, title, sub, cls) =>
    `<g class="${cls || ''}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>
      <text x="${x + w / 2}" y="${y + (sub ? 17 : h / 2 + 4)}" class="bt">${title}</text>
      ${sub ? `<text x="${x + w / 2}" y="${y + 33}" class="bs">${sub}</text>` : ''}</g>`;
  /* SVG has no <sup>, so an exponent needs a raised tspan — without it
     "g^(k/28)" sits in the box as literal characters and reads as a typo. */
  const sup = (t, e) => t + '<tspan dy="-4" font-size="7.5">' + e + '</tspan>';
  const sub_ = (t, e) => t + '<tspan dy="3" font-size="7.5">' + e + '</tspan>';
  const arrow = (x1, y1, x2, y2) =>
    `<path d="M${x1} ${y1} L${x2} ${y2}" class="ar" marker-end="url(#ah)"/>`;
  const elbow = (x1, y1, x2, y2) =>
    `<path d="M${x1} ${y1} V${(y1 + y2) / 2} H${x2} V${y2}" class="ar" marker-end="url(#ah)"/>`;

  const fits = [
    ['D', SYM.D, rng(dowVals)],
    ['S', SYM.S, rng(seaVals)],
    ['Y', SYM.Y, 'x' + (g.yoy || 1).toFixed(2)],
    ['L', SYM.L, money(p.level) + '/d'],
  ];
  /* A left gutter, reserved for the loop. Laid out from constants rather than
     by eye: the first cut ran the loop and its label straight through the
     weekday box, because both were positioned independently. */
  const GUT = 58, BW = 165, STEP = 177;
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="fcdiag" role="img"
      aria-label="How the forecast is calculated, step by step">
    <defs><marker id="ah" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5"
      orient="auto"><path d="M0 0 L8 4 L0 8 z" class="ahd"/></marker></defs>

    ${box(230, 8, 300, 34, 'YOUR BOOK', '2025 + 2026, every day', 'src')}
    ${arrow(380, 42, 380, 62)}

    ${box(230, 62, 300, 34, '÷ M', 'take out what you have declared', 'corr')}
    ${arrow(380, 96, 380, 116)}
    ${box(230, 116, 300, 30, 'BASELINE HISTORY', null, 'src')}

    ${fits.map((f, i) => {
      const x = GUT + i * STEP;
      return elbow(380, 146, x + BW / 2, 176) + box(x, 176, BW, 44, f[0] + ' · ' + f[1], f[2], 'fit');
    }).join('')}

    <!-- D, S and L feed A; Y feeds B. That is exactly what the formula says, and
         a fifth arrow from Y into A (the drift cap) would be true but would cost
         more legibility than it buys — the symbol table carries it instead. -->
    ${[0, 1, 3].map(i => elbow(GUT + i * STEP + BW / 2, 220, 225, 262)).join('')}
    ${elbow(GUT + 2 * STEP + BW / 2, 220, 555, 262)}

    ${box(75, 262, 300, 56, 'A · TODAY’S TRAJECTORY',
          'L · ' + sup('g', 'k/28') + ' · D · S', 'pred')}
    ${box(405, 262, 300, 56, 'B · THE SAME DAYS LAST YEAR',
          'smoothed ±3 days · ' + sub_('L', 'y') + ' · Y', 'pred')}

    ${elbow(225, 318, 380, 356)}${elbow(555, 318, 380, 356)}
    ${box(230, 356, 300, 40, 'BLEND', (p.priorWeight * 100).toFixed(0) + '% on B, less the further out', 'blend')}
    ${arrow(380, 396, 380, 416)}

    ${box(230, 416, 300, 34, '× M', 'put your declarations back on', 'corr')}
    ${arrow(380, 450, 380, 470)}
    ${box(230, 470, 300, 32, 'REVENUE, ONE DAY', null, 'out')}

    <!-- the same M does both halves; drawn as one loop so that is not a claim
         the reader has to take on trust -->
    <path d="M230 79 H30 V433 H230" class="loop"/>
    <text x="20" y="256" class="loopt" transform="rotate(-90 20 256)">one M, both ways</text>

    ${arrow(380, 502, 380, 522)}
    ${box(150, 522, 460, 34, 'PROFIT = REVENUE × (c − a) − F', null, 'out')}
  </svg>`;

  /* ---- the arithmetic ---------------------------------------------------- */
  const sym = [
    ['L', money(p.level), 'run rate a day, season and weekday out, ' +
       (lc ? esc(lc.name) + ' out' : 'no sale period in the window')],
    ['g', 'x' + p.drift.toFixed(3), 'per 28 days · x' + Math.pow(p.drift, 365 / 28).toFixed(2) +
       ' a year, capped at your best YoY month'],
    ['k', '1…' + p.horizon, 'days ahead'],
    ['D', rng(dowVals), 'weekday · Mon–Wed high, Sat low'],
    ['S', rng(seaVals), 'month · Jan ' + b.season.index[1].toFixed(2) +
       ', Nov ' + b.season.index[11].toFixed(2)],
    ['Y', 'x' + (g.yoy || 1).toFixed(2), g.n + ' whole months · x' + g.low.toFixed(2) +
       '–x' + g.high.toFixed(2)],
    ['w', (p.priorWeight * 100).toFixed(0) + '%', 'weight on last year, falls with k'],
    ['M', nMods ? 'x' + p.modifierEffect.peak.toFixed(2) + ' peak' : 'x1.00',
       nMods + ' declared · they multiply'],
    ['c', (pnl.contribRate * 100).toFixed(1) + '%', 'of revenue after GST and variable cost'],
    ['a', (pnl.adRate * 100).toFixed(1) + '%', 'ad spend, times that month’s efficiency'],
    ['F', money(pnl.fcPerDay), 'fixed cost a day · the latest step, not an average'],
  ];

  el.innerHTML = `
    <div class="ncol">${svg}
      <p class="ncap">Read it downwards. Anything you declare is taken out of history
      <i>before</i> the four quantities are fitted, and put back on afterwards — the same M
      both ways, or the model would learn a fortnight of discounting as your run rate.</p>
    </div>
    <div class="ncol">
      <div class="nmath">
        <div class="nm-h">Revenue, for a day k ahead</div>
<pre>R = [ (1−w)·A  +  w·B ] × M

  A = L · g<sup>k/28</sup> · D · S
  B = L<sub>y</sub> · Y</pre>
        <div class="nm-h">Profit, from your sheet’s own identity</div>
<pre>P = R × (c − a) − F</pre>
        <div class="nm-h">Break-even</div>
<pre>R₀ = F / (c − a) = ${money(p.breakevenPerDay)} a day</pre>
      </div>
      <table class="nsym"><tbody>${sym.map(r =>
        `<tr><th>${r[0]}</th><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody></table>
      <div class="nacc">
        <b>Measured</b>, walking the model forward through your book and refitting at every
        start: <b>±${b30 ? (b30.mape * 100).toFixed(0) : '—'}%</b> at 30 days,
        <b>±${b90 ? (b90.mape * 100).toFixed(0) : '—'}%</b> at 90.
        <b>±${b30 && b30.coldStart ? (b30.coldStart.mape * 100).toFixed(0) : '—'}%</b>
        without a prior year to lean on.
        <span>Nothing validates Oct–Dec: no start in the data reaches them, so BFCM rests on
        ${b.season.observations[11] || 0} observed November${(b.season.observations[11] || 0) === 1 ? '' : 's'}.
        S steps at month ends, where real demand tapers. And it cannot see a decision you have not
        declared.</span>
      </div>
    </div>`;
}

/* Whether a declared sale period actually overlaps the window the level is
   measured over — which is the only case where the correction changes anything,
   and so the only case worth telling the reader about. */
function levelCorrected(p) {
  const winStart = F.addDays(p.from, -27);
  return activeSale().find(m => (m.paybackEnd || m.end) >= winStart && m.start <= p.from) || null;
}
let _bareLevel = null;
function uncorrectedLevel(p) {
  if (_bareLevel && _bareLevel.from === p.from) return _bareLevel.level;
  let v = p.level;
  try { const q = F.project({ rows: rows(), from: p.from, horizon: 1, scenario: p.scenario }); if (q) v = q.level; }
  catch (e) { /* fall back to showing the corrected one */ }
  _bareLevel = { from: p.from, level: v };
  return v;
}

/* ------------------------------------------------------------------ render */

function render() {
  if (!DATA) return;
  refreshSalePeriods();
  const list = rows();
  const from = anchorOf(list);
  if (!from) return;
  const hor = horizonDays(from);
  const scen = {};
  ['pessimistic', 'realistic', 'optimistic'].forEach(k => scen[k] = run(k, hor));
  const p = scen[S.scen];
  if (!p) return;

  /* Year end is a fixed question — how does 2026 finish — and must not move
     when the horizon selector does. */
  const eoyH = horizonOf(from, from.slice(0, 4) + '-12-31');
  const eoyP = eoyH > 0 ? run(S.scen, eoyH) : null;
  const ytd = list.filter(r => r.date.slice(0, 4) === from.slice(0, 4))
                  .reduce((a, r) => ({ revenue: a.revenue + r.revenue, profit: a.profit + (+r.profit || 0) }), { revenue: 0, profit: 0 });
  const eoy = eoyP ? { revenue: ytd.revenue + eoyP.total, profit: ytd.profit + eoyP.profit, actual: ytd.revenue } : null;

  const ctx = { list, scen, eoy };
  document.getElementById('navDate').textContent = niceFull(from);
  document.getElementById('throughVal').textContent = niceFull(list[list.length - 1].date);
  const pend = pendingOf(list.slice(-3));
  const note = document.getElementById('pendNote');
  if (pend && pend.groups && pend.groups.length) {
    note.hidden = false; note.textContent = pendingLabel(list[list.length - 1]) || 'partly pending';
  } else note.hidden = true;

  const safe = (name, fn) => { try { fn(); } catch (e) { console.error('forecast: ' + name + ' failed', e); } };
  safe('kpis', () => renderKpis(p, ctx));
  safe('scenarios', () => renderScenarios(ctx));
  safe('chart', () => renderChart(p, ctx));
  safe('months', () => renderMonths(p, ctx));
  safe('season', () => renderSeason(p));
  safe('sales', () => renderSales(p));
  safe('modifiers', () => renderMods(p));
  safe('notes', () => renderNotes(p));
  document.getElementById('footSource').textContent =
    'Forecast from ' + niceFull(p.from) + ' · 2026 book' + (PRIOR ? ' + 2025 book' : ' only') +
    ' · ' + (S.live === 'live' ? 'live' : 'snapshot');
}

const horizonOf = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

/* The band is measured, not assumed, so it has to be computed — about half a
   second of walk-forward. Deferred past first paint so the board draws
   immediately and the band fills in behind it. */
function measure() {
  setTimeout(() => {
    try { BT = F.backtest(rows(), { model: { scenario: 'realistic' } }); render(); }
    catch (e) { BT = null; }
  }, 60);
}

/* ------------------------------------------------------------------- wire */

function setLive(state) {
  S.live = state;
  const dot = document.getElementById('liveDot'), txt = document.getElementById('liveText');
  dot.className = 'dot ' + (state === 'live' ? 'live' : state === 'loading' ? 'loading' : 'snap');
  txt.textContent = state === 'live' ? 'Live' : state === 'loading' ? 'Loading…' : 'Snapshot';
}

async function tryLiveRefresh() {
  setLive('loading');
  try {
    const r = await fetch(API_URL);
    if (!r.ok) throw new Error('http-' + r.status);
    const j = await r.json();
    if (!(j.daily || []).length) throw new Error('api-no-rows');
    const map = new Map(DATA.daily.map(d => [d.date, d]));
    (j.daily || []).forEach(d => map.set(d.date, d));
    DATA.daily = [...map.values()].sort((a, b) => a.date < b.date ? -1 : 1);
    if (j.meta && j.meta.latestDataDate) DATA.meta.latestDataDate = j.meta.latestDataDate;
    _bareLevel = null; setLive('live'); render(); measure();
  } catch (e) { setLive('snap'); }
}

function wire() {
  const notes = document.getElementById('notes');
  document.getElementById('infoBtn').onclick = () => { notes.hidden = !notes.hidden; };
  document.getElementById('notesClose').onclick = () => { notes.hidden = true; };
  window.addEventListener('keydown', e => { if (e.key === 'Escape') notes.hidden = true; });
  document.querySelectorAll('#horSeg button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#horSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); S.hor = b.dataset.hor === 'EOY' ? 'EOY' : parseInt(b.dataset.hor, 10); render();
  });
  document.getElementById('modForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('modName').value.trim();
    const start = document.getElementById('modStart').value;
    const end = document.getElementById('modEnd').value;
    const lift = parseFloat(document.getElementById('modLift').value);
    const payback = parseFloat(document.getElementById('modPay').value);
    if (!name || !start || !end || isNaN(lift)) return;
    if (end < start) return;
    S.mods.push({ name, start, end, lift, payback: isNaN(payback) ? 0 : payback });
    saveMods(); e.target.reset(); render();
  });
  window.addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(render, 200); });
}

(function init() {
  if (!DATA || !F) { document.getElementById('errBox').classList.add('show'); return; }
  loadMods(); setLive('snap'); wire(); render();
  if (window.DLmotion) DLmotion.entrance();
  measure();
  tryLiveRefresh();
  setInterval(tryLiveRefresh, REFRESH_MINUTES * 60 * 1000);
})();
