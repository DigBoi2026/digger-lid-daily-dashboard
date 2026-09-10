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

/* HOW THIS FORECAST WORKS, on the page rather than in a commit message.

   Written to be read by someone who runs the business, not someone who builds
   models: plain sentences, every claim carrying the actual number from the
   actual book, and the limits stated as plainly as the capabilities. The
   numbers are live — they come from the projection currently on screen — so
   this cannot drift out of date the way a static help page would. */
function renderNotes(p) {
  const el = document.getElementById('notesBody');
  const g = p.basis.growth, se = p.basis.season, pnl = p.pnl;
  const b30 = BT && BT[30], b60 = BT && BT[60], b90 = BT && BT[90];
  const lc = levelCorrected(p);
  const yl = se.yearLevel || {};
  const yrs = Object.keys(yl).sort();
  const nov = se.index[11], jan = se.index[1];

  const sec = (title, body) => `<section><h3>${title}</h3>${body}</section>`;
  const dl = pairs => '<dl>' + pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';

  el.innerHTML =
    sec('The short version', `
      <p>The forecast asks one question: <b>how big is the business right now, and what
      does the calendar do to it next?</b> It answers by measuring four things from your
      own two years of daily numbers — the weekly rhythm, the shape of the year, the rate
      you are growing, and today's underlying run rate — and then multiplying them
      together, day by day, for as far ahead as you ask.</p>
      <p>Nothing in it is a rule of thumb or an industry benchmark. Every figure below was
      read out of your P&amp;L sheet, and the page recalculates them whenever the sheet
      updates.</p>`) +

    sec('Why this business needs a forecast built this way', `
      <p>Most forecasts assume a trend with some noise on top. Yours is not that. In 2025,
      June and November earned <b>+$48,917</b> and <b>+$103,174</b> while the other seven
      months lost <b>$50,772</b> between them. The year is made in two months.</p>
      <p>A model that smooths over that is worse than useless — it will tell you a calm
      October is a problem and a huge November is luck. So the shape of the year is the
      first thing this one fits, not an afterthought.</p>`) +

    sec('The four things it measures', dl([
      ['Weekly rhythm',
        `Monday to Wednesday run about 15% above average, Saturday about 25% below. Fitted
         across both years, because how a trade customer shops through the week does not
         change from one year to the next.`],
      ['Shape of the year',
        `A number per month saying how big it is relative to a typical month.
         November is <b>${nov ? nov.toFixed(2) : '—'}</b> — over twice a normal month —
         and January the weakest at <b>${jan ? jan.toFixed(2) : '—'}</b>, when sites are
         shut. Year and month are solved together rather than one year at a time, because
         2025 has nine months in it including both giants while 2026 has more months but
         no BFCM yet, and averaging those two directly makes every figure wrong.`],
      ['Growth rate',
        `<b>x${g.yoy ? g.yoy.toFixed(2) : '—'}</b> year on year, the middle of
         ${g.n} whole months compared like for like, ranging
         x${g.low ? g.low.toFixed(2) : '—'} to x${g.high ? g.high.toFixed(2) : '—'}.
         Only whole months count: comparing eight days of September to a full September
         once read a <b>+132%</b> month as <b>−32%</b>.`],
      ['Run rate today',
        `<b>${money(p.level)}</b> a day, from the last 28 complete days with the season
         and the weekday taken out, so it is comparable to any other time of year.
         Days the sheet has not finished are excluded — a day with revenue typed but no ad
         spend is a real day of trade with a fictional cost side.
         ${lc ? `And ${esc(lc.name)} is divided out of it, because a fortnight of
         discounting is not a new run rate.` : ''}`],
    ])) +

    sec('How a day ahead gets its number', `
      <p>Two independent estimates, blended:</p>
      <ol>
        <li><b>From today's trajectory.</b> Run rate x growth x that weekday x that month.</li>
        <li><b>From the same days last year</b>, smoothed over a week either side, then
        scaled up by the growth rate. This one carries events the month figure cannot see,
        because it knows what actually happened on the 24th of November.</li>
      </ol>
      <p>Last year gets <b>${(p.priorWeight * 100).toFixed(0)}%</b> of the weight at this
      horizon, and less the further out you look — last year tells you a great deal about
      next week and much less about next quarter. Blending beat either one alone at every
      distance tested: 30-day error fell from 21.6% to about 15%.</p>`) +

    sec('Three separate things, and why they are separate', dl([
      ['Seasonal trend',
        `Fitted from history, and not optional. It is not an adjustment to the forecast,
         it is the forecast's shape. EOFY and BFCM live here: they are month-aligned, so
         the month figure prices them exactly, and declaring them again anywhere else
         would count them twice.`],
      ['Sale periods',
        `Measured from the book, recurring, dated by rule each year. Father's Day is one
         because it <i>cannot</i> live in the seasonal trend: it is the first Sunday of
         September, its run-up sits in August and its payback in September, so no
         per-month figure can hold it. 2026 measured <b>+47%</b> over fourteen days
         against its own pre-promotion August; 2025 measured <b>−10%</b>, which is to say
         2025 ran no promotion. For a year still ahead you can re-size the lift, and the
         measured ramp scales with it — the shape is how your customers behave, the size
         is your decision.`],
      ['Your modifiers',
        `Things you assert about the future that two years of history cannot know: a
         launch, a price change, a new channel. Nothing here is measured and nothing is on
         by default.`],
    ]) + `
      <p><b>They overlap, and the page says so.</b> Factors multiply, so a +47% sale period
      and a +30% launch over the same days make +91%, not +77%. That is the right treatment
      for effects that stack, and it is also the easiest way to forecast a number with no
      precedent by accident — so every overlap is named with its combined effect, and
      compared against the biggest lift your book has ever recorded
      ${S.ceiling ? '(' + pct((S.ceiling - 1) * 100, 0) + ')' : ''}. It is never clipped:
      the assertion is yours, and quietly shrinking your number would be worse than a
      large one you can see.</p>
      <p>A declaration also applies <i>backwards</i>. Anything you declare is divided out
      of history first, everything is fitted on what is left, and it is multiplied back on
      to the days ahead. Correcting after the fit does not work: a promotion left
      undeclared contaminates the month figures and the growth rate too, and nothing
      downstream can reach a season figure that has already swallowed it.</p>`) +

    sec('Profit is not forecast — it is derived', `
      <p>Your sheet already carries an exact identity, which checks to the dollar over
      every window tried:</p>
      <pre>profit = revenue ex GST − variable costs − ad spend − fixed costs</pre>
      <p>So rather than guess at profit, the forecast builds its parts:</p>` +
      dl([
        ['Contribution', `<b>${pnl ? (pnl.contribRate * 100).toFixed(1) : '—'}%</b> of
          revenue after GST and variable costs. Steady to within a couple of points.`],
        ['Ad spend', `<b>${pnl ? (pnl.adRate * 100).toFixed(1) : '—'}%</b> of revenue,
          shaped by month — and your big months are the <i>efficient</i> ones. June 2025
          spent 18.1c per revenue dollar; July 2026 spent 38.9c.`],
        ['Fixed costs', `<b>${money(pnl && pnl.fcPerDay)}</b> a day. This is a staircase,
          not a trend: salaries went $1,178/day to $1,381 to $1,463 to $1,837 to $2,081 as
          you hired, and never came back down. So the forecast uses the latest step, not an
          average — the only estimator that is right about a staircase.`],
        ['Breakeven', `<b>${money(p.breakevenPerDay)}</b> a day, or
          <b>${money(p.breakevenPerDay * 30, true)}</b> a month, just to stand still.`],
      ]) + `
      <p>Costs are held <b>identical across all three scenarios</b>, on purpose. What is
      uncertain here is demand, not your cost structure — and holding costs still is what
      shows the leverage: fixed cost is ${money(pnl && pnl.fcPerDay)} a day whatever
      happens, so a 20% revenue miss is a far bigger than 20% profit miss. Flexing costs
      with each scenario would hide exactly the risk the pessimistic case exists to show.</p>`) +

    sec('What the three scenarios actually assume', dl([
      ['Realistic', 'The current trajectory continues, and events repeat as they have.'],
      ['Optimistic', 'Growth holds at its full year-on-year rate, and the big months scale with it.'],
      ['Pessimistic', 'Growth stops dead, and the big months land 15% short.'],
    ]) + `
      <p>Each is a sentence you could defend in a board meeting, not a percentage bolted on
      to one number. The shaded band on the chart is separate from all three: it is the
      measured error from testing the model against your own history.</p>`) +

    sec('How accurate it is, measured not claimed', `
      <p>The model is walked forward through your book: stand at a past date, refit
      everything using only what was known then, forecast, compare to what happened, move
      on. Nothing leaks backwards.</p>` +
      dl([
        ['30 days', b30 ? `<b>±${(b30.mape * 100).toFixed(0)}%</b> across ${b30.n} past
           starting points, running ${b30.bias < 0 ? 'low' : 'high'} by
           ${Math.abs(b30.bias * 100).toFixed(0)}% on average` : 'measuring…'],
        ['60 days', b60 ? `<b>±${(b60.mape * 100).toFixed(0)}%</b> across ${b60.n}` : 'measuring…'],
        ['90 days', b90 ? `<b>±${(b90.mape * 100).toFixed(0)}%</b> across ${b90.n}` : 'measuring…'],
        ['With no prior year', b30 && b30.coldStart
           ? `<b>±${(b30.coldStart.mape * 100).toFixed(0)}%</b> — what the same model scored
              from 2025 starting points, which had no BFCM anywhere in their history`
           : 'not measurable here'],
      ]) + `
      <p>It runs slightly low overall. That is the honest reading of a business growing this
      fast, and it is reported rather than corrected, because "add 15%" fitted to one
      strong year is not a model, it is a wish.</p>`) +

    sec('What it cannot do', `
      <ul>
        <li><b>October to December are unvalidated.</b> No starting point in your data has a
        horizon that reaches them, so BFCM — the single largest claim on this page — is
        untested by backtest and rests on
        <b>${se.observations[11] || 0} observed November${(se.observations[11] || 0) === 1 ? '' : 's'}</b>.
        The 2025 evidence for what that costs is stark: standing at 4 November 2025 with
        nothing in its history that had ever seen a BFCM, the model missed the following 30
        days by <b>−58%</b>.</li>
        <li><b>February to April 2025 were never filled into the workbook</b>, so those
        months are fitted on 2026 alone and say so.</li>
        <li><b>The month figures step at month boundaries.</b> BFCM decays over days in real
        life; here 30 November to 1 December is a cliff, softened only by the prior-year
        half of the blend.</li>
        <li><b>It cannot see a decision you have not told it about.</b> A promotion, a
        launch, a stock-out, a price rise — the 2026 Father's Day promotion was invisible to
        every model until it was declared. That is what the modifiers are for.</li>
        <li><b>It is a forecast, not a commitment.</b> Two years is a short book, and one of
        them has three months missing.</li>
      </ul>` +
      (yrs.length >= 2 ? `<p class="foot">Fitted on ${yrs.join(' and ')} · underlying level
        ${yrs.map(y => y + ' ' + money(yl[y]) + '/day').join(' → ')} · forecast from
        ${niceFull(p.from)}.</p>` : '')) ;
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
