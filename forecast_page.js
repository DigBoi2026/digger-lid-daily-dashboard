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

const S = { scen: 'realistic', hor: 90, live: 'snap', mods: [], saleOff: [], sale: [] };
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
    S.sale = F.salePeriodModifiers(list, { years: [...years].sort() });
  } catch (e) { S.sale = []; }
}

function activeSale() {
  return S.sale.filter(m => S.saleOff.indexOf(m.key) === -1);
}

/* Everything project() should apply, seeded and typed together. Typed lifts
   arrive as percentages from the form; seeded ones are already fractions. */
function allMods() {
  return activeSale().concat(S.mods.map((m, i) => ({
    key: 'user:' + i, start: m.start, end: m.end, lift: m.lift / 100,
    payback: m.payback ? m.payback / 100 : 0,
    paybackEnd: m.payback ? F.addDays(m.end, 14) : null,
  })));
}

function run(scen, hor) {
  const list = rows();
  const from = anchorOf(list);
  if (!from) return null;
  return F.projectPnl({ rows: list, from, horizon: hor || horizonDays(from),
                        scenario: scen || S.scen, modifiers: allMods() });
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
  document.getElementById('beVal').textContent = p.breakevenPerDay ? money(p.breakevenPerDay, true) + '/day' : '—';
  document.getElementById('beSub').textContent = p.pnl
    ? 'contribution ' + (p.pnl.contribRate * 100).toFixed(1) + '% · ads ' + (p.pnl.adRate * 100).toFixed(1) + '%'
    : '';

  const h = nearestHorizon(p.horizon), b = BT && BT[h];
  document.getElementById('accVal').textContent = b ? '±' + (b.mape * 100).toFixed(0) + '%' : 'measuring…';
  document.getElementById('accSub').textContent = b
    ? h + '-day error over ' + b.n + ' past origins'
    : 'walk-forward over the whole book';
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

/* --------------------------------------------------- events and modifiers */

function renderEvents(p) {
  const el = document.getElementById('eventList');
  const inHorizon = new Set(p.months.map(m => +m.month.slice(5, 7)));
  const horFrom = F.addDays(p.from, 1), horTo = F.addDays(p.from, p.horizon);

  /* Sale periods first: they are the only entries on this list that move a
     number, so they lead it and say so. */
  const sale = S.sale.filter(m => m.paybackEnd >= horFrom && m.start <= horTo)
    .concat(S.sale.filter(m => !(m.paybackEnd >= horFrom && m.start <= horTo)).slice(0, 1))
    .map(m => {
      const off = S.saleOff.indexOf(m.key) !== -1;
      const live = m.paybackEnd >= horFrom && m.start <= horTo;
      const other = (m.measured.allYears || []).filter(y => y.year !== m.measured.from);
      return `<div class="catrow sale${off ? ' off' : ''}">
        <div class="cinfo">
          <div class="cname">${esc(m.name)} <small>sale period</small></div>
          <div class="cmeta">${isoToNice(m.start)} → ${isoToNice(m.end)} at
            ${pct(m.lift * 100, 0)}, then ${pct(m.payback * 100, 0)} to ${isoToNice(m.paybackEnd)}
            · ${m.measured.own ? 'measured in ' + m.measured.from : 'sized from ' + m.measured.from}${other.length
              ? ' (' + other.map(y => y.year + ' ' + pct(y.lift * 100, 0)).join(', ') + ')' : ''}</div>
        </div>
        <div class="cright">
          ${live && !off ? '<span class="cf ok">applied</span>' : off ? '<span class="cf none">off</span>' : '<span class="cf thin">outside</span>'}
          <button class="modx" data-sale="${esc(m.key)}" aria-label="${off ? 'Switch on' : 'Switch off'} ${esc(m.name)}">${off ? '+' : '×'}</button>
        </div>
      </div>`;
    }).join('');

  /* Then the recurring calendar, each entry saying which mechanism carries it —
     the month index already prices EOFY and BFCM in, so declaring them here as
     well would count them twice. */
  const ev = F.EVENTS.map(e => {
    const on = inHorizon.has(e.month);
    return `<div class="catrow ev${on ? ' hit' : ''}">
      <div class="cinfo"><div class="cname">${esc(e.name)} <small>${MONTH_ABBR[e.month - 1]} · ${e.via === 'sale' ? 'sale period' : 'in the month index'}</small></div>
        <div class="cmeta">${esc(e.note)}</div></div>
      <div class="cright">${on ? '<span class="cf ok">in horizon</span>' : ''}</div>
    </div>`;
  }).join('');

  const mods = S.mods.map((m, i) => `<div class="catrow mod">
      <div class="cinfo"><div class="cname">${esc(m.name)} <small>yours</small></div>
        <div class="cmeta">${isoToNice(m.start)} → ${isoToNice(m.end)} · ${pct(m.lift, 0)}${m.payback ? ' then ' + pct(m.payback, 0) + ' for 14d' : ''}</div></div>
      <div class="cright"><button class="modx" data-i="${i}" aria-label="Remove ${esc(m.name)}">×</button></div>
    </div>`).join('');

  el.innerHTML = sale + mods + ev;
  el.querySelectorAll('.modx[data-i]').forEach(b => b.onclick = () => {
    S.mods.splice(+b.dataset.i, 1); saveMods(); render();
  });
  el.querySelectorAll('.modx[data-sale]').forEach(b => b.onclick = () => {
    const k = b.dataset.sale, at = S.saleOff.indexOf(k);
    if (at === -1) S.saleOff.push(k); else S.saleOff.splice(at, 1);
    saveMods(); render();
  });

  const nLive = activeSale().filter(m => m.paybackEnd >= horFrom && m.start <= horTo).length;
  document.getElementById('modNote').textContent =
    (nLive ? nLive + ' sale period' + (nLive > 1 ? 's' : '') + ' applied' : 'no sale period in this horizon') +
    (S.mods.length ? ' · ' + S.mods.length + ' of yours' : '');
}

function saveMods() {
  try {
    localStorage.setItem(MOD_KEY, JSON.stringify(S.mods));
    localStorage.setItem(OFF_KEY, JSON.stringify(S.saleOff));
  } catch (e) { /* private mode, or site data blocked — the page still works */ }
}
function loadMods() {
  try { const v = JSON.parse(localStorage.getItem(MOD_KEY) || '[]'); if (Array.isArray(v)) S.mods = v; }
  catch (e) { S.mods = []; }
  try { const v = JSON.parse(localStorage.getItem(OFF_KEY) || '[]'); if (Array.isArray(v)) S.saleOff = v; }
  catch (e) { S.saleOff = []; }
}

/* ------------------------------------------------------------ what it rests on */

/* The honest half of the page.

   Everything above is a number. This is what the number is made of and where
   it is thin — the month indices fitted on a single year, the drift, the
   weight given to last year, and the two things the backtest cannot check:
   BFCM, because no origin in the data has a horizon that reaches November, and
   any horizon at all if the prior year were missing, which cost -58% the one
   time it happened. */
function renderBasis(p) {
  const el = document.getElementById('basisWrap');
  const g = p.basis.growth, s = p.basis.season, pnl = p.pnl;
  const b30 = BT && BT[30], b90 = BT && BT[90];
  const line = (l, v, note) => `<div class="brow"><div class="bl">${l}</div><div class="bv">${v}</div>
      <div class="bn">${note || ''}</div></div>`;
  /* Accuracy first. A reader who only takes in the top of this panel should
     leave knowing how wrong the number above them can be, not what the level is. */
  el.innerHTML =
    (b30 ? line('Error at 30 days', '±' + (b30.mape * 100).toFixed(0) + '%',
        b30.n + ' past origins · bias ' + pct(b30.bias * 100, 0)) : '') +
    (b90 ? line('Error at 90 days', '±' + (b90.mape * 100).toFixed(0) + '%',
        b90.n + ' past origins · bias ' + pct(b90.bias * 100, 0)) : '') +
    (b30 && b30.coldStart ? line('Without a prior year', '±' + (b30.coldStart.mape * 100).toFixed(0) + '%',
        'what 2025 origins scored, with no BFCM anywhere in their history') : '') +
    line('Year on year', mult(g.yoy), g.n + ' whole months, ' + mult(g.low) + '–' + mult(g.high) + ' · last year carries ' + (p.priorWeight * 100).toFixed(0) + '% of the weight') +
    line('Drift', mult(p.drift) + ' / 28d', 'implies ' + mult(Math.pow(p.drift, 365 / 28)) + ' a year, bounded by the best year-on-year month recorded') +
    line('Level now', money(p.level, true) + '/day',
        'deseasonalised over the last 28 complete days' +
        (levelCorrected(p) ? ', with ' + levelCorrected(p).name + ' divided back out' : '')) +
    line('Fixed cost', money(pnl && pnl.fcPerDay, true) + '/day', 'the latest step, not an average — it has only ever gone up');

  document.getElementById('basisWarn').innerHTML =
    (levelCorrected(p) ? (() => {
        const m = levelCorrected(p), bare = uncorrectedLevel(p);
        return `<div class="bwarn"><b>Promotion-corrected:</b> ${esc(m.name)} is divided out
          of the level, taking it from ${money(bare)} to ${money(p.level)} a day
          (${pct((p.level / bare - 1) * 100, 0)}). The direction is certain — the three weeks
          of August before that promotion ran x1.69 on last year, in line with May's x1.77 and
          June's x1.72, while the promotion fortnight ran x2.93. The size is less so: an
          independent pre-promotion estimate lands about 9% above this. Switch it off on the
          calendar to see the forecast without it.</div>`;
      })() : '') +
    /* Two caveats, one box. Three separate warnings crowded the panel until the
       accuracy rows behind them had nowhere to sit, and a caveat that pushes the
       evidence off the screen is self-defeating. */
    `<div class="bwarn"><b>Not validated:</b> no origin in the data has a horizon
       reaching October to December, so BFCM — the largest single claim here — is
       untested by backtest and rests on ${s.observations[11] || 0} observed November${(s.observations[11] || 0) === 1 ? '' : 's'}.${
       (s.observations[2] === 1 || s.observations[3] === 1)
         ? ' February to April 2025 were never filled into the workbook either, so those months are fitted on 2026 alone.' : ''}</div>`;

  document.getElementById('basisNote').textContent =
    'from ' + niceFull(p.from) + ' · ' + p.horizon + ' days';
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
  safe('events', () => renderEvents(p));
  safe('basis', () => renderBasis(p));
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
