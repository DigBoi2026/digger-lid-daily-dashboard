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
            mods: [], saleOff: [], saleEdit: {}, sale: [], ceiling: null,
            notesMode: 'simple', view: 'map', lens: 'total' };
/* Shopify-backed series, fetched only when a lens that needs them is selected.
   Keyed by dataset name: geo (AU/NZ/rest), customers (new/returning),
   productsDaily (top products). Each is { state: idle|loading|ready|failed, data }. */
const EXT = {};
const extState = name => (EXT[name] && EXT[name].state) || 'idle';
const extData = name => (EXT[name] && EXT[name].data) || null;
let DATA = window.DL_DATA || null;
const PRIOR = window.DL_PRIOR || null;
let CHART = null;
/* Accuracy is measured on the series that is actually on screen. Reusing
   revenue's backtest under another lens would put a measured-looking ±13%
   against a series that was never tested: the returning-customer count runs
   ±27% at 30 days and ±41% at 90, so revenue's figure would understate it by
   more than double — the exact shape of wrong this board exists to avoid. */
const BTS = {};                      // lens key -> folded backtest, or 'failed'
let BT = null;                       // the current lens's, filled in after first paint

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
/* A plain count, for the lenses whose measure is orders rather than dollars.
   Was used before it existed, which the safe() wrapper turned into the New vs
   Returning lens quietly falling back to the Total tiles — a silent wrong
   answer, which is the failure mode this whole board is built to avoid. */
const numf = n => n == null || isNaN(n) ? '—' : Math.round(n).toLocaleString('en-AU');
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
    S.sale = F.salePeriodModifiers(list, { years: [...years].sort(), overrides: S.saleEdit, modifiers: userMods() });
    if (S.ceiling == null) S.ceiling = F.observedCeiling(list);
  } catch (e) { S.sale = []; }
}

function activeSale() {
  return S.sale.filter(m => S.saleOff.indexOf(m.key) === -1);
}

/* Typed declarations as the engine sees them. Lifts arrive as percentages
   from the form; the engine wants fractions. */
function userMods() {
  return DECLARED.concat(S.mods).map((m, i) => ({
    key: 'user:' + i, kind: 'user', name: m.name,
    start: m.start, end: m.end, lift: m.lift / 100,
    payback: m.payback ? m.payback / 100 : 0,
    paybackEnd: m.payback ? F.addDays(m.end, 14) : null,
  }));
}

/* Everything project() should apply, seeded and typed together. */
function allMods() {
  return activeSale().concat(userMods());
}

function run(scen, hor) {
  const list = rows();
  const from = anchorOf(list);
  if (!from) return null;
  return F.projectPnl({ rows: list, from, horizon: hor || horizonDays(from),
                        scenario: scen || S.scen, modifiers: allMods(), observedCeiling: S.ceiling });
}

/* ------------------------------------------------------------------ lenses */

/* WHAT THE FORECAST IS OF.

   Three lenses over one engine. Each supplies its own series and its own units;
   nothing about the model changes, because a weekly rhythm and a November apply
   to an order count and a country as much as to a dollar.

   The three are NOT equally well founded, and the page says which is which
   rather than presenting them as peers:

     total       the P&L's own revenue. Everything ties, profit included.
     customers   ORDER COUNTS only. The sheet carries newOrders and orders daily
                 for every one of its 527 days, so the split is measured — but it
                 carries no revenue split, and Shopify has no customer_type
                 column either, so a revenue-per-group figure would rest on
                 assuming the two spend alike. That assumption cannot even be
                 tested against this data, so it is not made.
     countries   Shopify net sales on shipping address. A DIFFERENT MEASURE from
                 the P&L: it excludes GST and is recorded by destination, so the
                 totals do not tie to the rest of the board and there is no cost
                 data per country. Revenue and orders only, never profit. The
                 workbook's own Country 2/3/4 blocks would tie, and are $0.00 on
                 every day of every month. */
const LENSES = {
  total: {
    label: 'Total', unit: 'money', profit: true, ties: true,
    note: 'the P&L’s own revenue',
    build(list) { return [{ id: 'total', name: 'Revenue', rows: list, primary: true }]; },
  },
  customers: {
    label: 'New vs returning', unit: 'money', profit: false, ties: false, sparse: true,
    needs: 'customers',
    note: 'Shopify net sales by customer type · order counts tie to the sheet',
    brief: 'Shopify net sales. Orders tie to the sheet; dollars do not tie to the P&L.',
    warn: 'Net sales by new_or_returning_customer — ex GST and net of refunds, so the ' +
          'dollars do not tie to the board’s revenue and there is no cost side, so no ' +
          'profit. The ORDER counts match the sheet’s New Customer Orders day for day. ' +
          'Returning customers spend about 8% more per order than new ones, which is why ' +
          'the split is measured here rather than assumed from order counts.',
    build(list, ext) {
      if (!ext || !ext.daily) return null;
      const mk = key => F.asMetric(ext.daily, key);
      return [
        { id: 'new', name: 'New customers', rows: mk('newNet'), aux: mk('newOrders'), primary: true },
        { id: 'ret', name: 'Returning', rows: mk('retNet'), aux: mk('retOrders') },
      ];
    },
  },
  countries: {
    label: 'AU / NZ / rest', unit: 'money', profit: false, ties: false, sparse: true,
    needs: 'geo',
    note: 'Shopify net sales by shipping country',
    brief: 'Different measure from the P&L. Does not tie. No profit.',
    warn: 'Net sales on shipping address — excludes GST and is recorded by destination, ' +
          'so these totals do NOT tie to the board’s revenue, and there is no cost data ' +
          'per country, so no profit. Your workbook’s Country 2/3/4 blocks would tie; ' +
          'they are $0.00 on every day of every month. Australia is forecastable and ' +
          'measures ±24% at 30 days. New Zealand and the rest are not: they take orders ' +
          'on a third of days, they have swung between 1% and 6% of sales quarter to ' +
          'quarter, and the model’s measured error on them is larger than the figure ' +
          'itself — read them as scale, not as a forecast. “Rest of world” is also a ' +
          'residual (total less AU less NZ), so it carries any order with no country ' +
          'recorded against it.',
    build(list, ext) {
      if (!ext || !ext.daily) return null;
      const mk = key => F.asMetric(ext.daily, key);
      return [
        { id: 'au', name: 'Australia', rows: mk('au'), primary: true },
        { id: 'nz', name: 'New Zealand', rows: mk('nz') },
        { id: 'other', name: 'Rest of world', rows: mk('other') },
      ];
    },
  },
  products: {
    label: 'Top products', unit: 'money', profit: false, ties: false, sparse: true,
    needs: 'productsDaily',
    note: 'Shopify net sales by product · top sellers, then everything else',
    brief: 'Shopify net sales by product. Does not tie to the P&L. No profit.',
    warn: 'Net sales by product title — ex GST and net of refunds, so it does not tie to ' +
          'the board’s revenue, and there is no cost per product here, so no profit. The ' +
          'top sellers by trailing-year sales get their own line; “Everything else” is ' +
          'the residual and carries the long tail, gifts with purchase at $0, and refunds. ' +
          'A product launched inside the last year has no prior year to lean on, and its ' +
          'measured error says so.',
    build(list, ext) {
      if (!ext || !ext.daily || !ext.products) return null;
      const mk = key => F.asMetric(ext.daily, key);
      const out = ext.products.map((pr, i) => ({ id: pr.key, name: pr.title, rows: mk(pr.key), primary: i === 0 }));
      out.push({ id: 'other', name: 'Everything else', rows: mk('other') });
      return out;
    },
  },
};

const lens = () => LENSES[S.lens] || LENSES.total;

/* Shopify is only asked for when a lens that needs it is actually selected:
   each dataset is several queries against a rate-limited API, and nobody
   looking at the total forecast should pay for them. */
async function ensureExt(name, attempt) {
  attempt = attempt || 0;
  const st = extState(name);
  if (st === 'loading' || st === 'ready' || (st === 'waiting' && !attempt)) return;
  EXT[name] = { state: 'loading', data: null }; render();
  try {
    const r = await fetch('/api/shopify?dataset=' + encodeURIComponent(name));
    /* A 503 is Shopify's rate limit — transient by construction, and the route
       says how long. Wait it out and try again rather than leaving the reader
       with "unavailable" for a condition that clears itself in half a minute.
       Two retries, then it really is unavailable. */
    if (r.status === 503 && attempt < 2) {
      let wait = 30;
      try { const j = await r.json(); wait = +j.retry_after_seconds || 30; } catch (e) { /* body optional */ }
      EXT[name] = { state: 'waiting', data: null, retryIn: wait };
      render();
      const tick = setInterval(() => {
        if (extState(name) !== 'waiting') { clearInterval(tick); return; }
        EXT[name].retryIn = Math.max(0, EXT[name].retryIn - 1); render();
      }, 1000);
      setTimeout(() => { clearInterval(tick); if (extState(name) === 'waiting') ensureExt(name, attempt + 1); }, wait * 1000);
      return;
    }
    if (!r.ok) throw new Error('http-' + r.status);
    const j = await r.json();
    if (!(j.daily || []).length) throw new Error('no rows');
    EXT[name] = { state: 'ready', data: j };
  } catch (e) { EXT[name] = { state: 'failed', data: null }; }
  render(); measure();
}

/* Every lens's series, projected. The primary carries the fan and the rails. */
function runLens(list, hor) {
  const L = lens();
  const built = L.build(list, L.needs ? extData(L.needs) : null);
  if (!built) return null;
  return built.map(sr => {
    const out = { id: sr.id, name: sr.name, primary: !!sr.primary, rows: sr.rows };
    const from = anchorOf(sr.rows.length ? sr.rows : list);
    /* Sale periods are re-fitted per series rather than reused from revenue: a
       promotion lifts order counts and dollars by different amounts, and
       Australia by a different amount again. */
    let mods = activeSale();
    if (!(L.unit === 'money' && L.ties)) {
      try {
        const yrs = new Set(sr.rows.map(r => r.date.slice(0, 4)));
        yrs.add(String(+from.slice(0, 4) + 1));
        mods = F.salePeriodModifiers(sr.rows, { years: [...yrs].sort(), overrides: S.saleEdit, modifiers: userMods() })
          .filter(m => S.saleOff.indexOf(m.key) === -1);
      } catch (e) { mods = []; }
    }
    out.mods = mods;
    ['pessimistic', 'realistic', 'optimistic'].forEach(sc => {
      const o = { rows: sr.rows, from, horizon: hor, scenario: sc, sparse: !!L.sparse,
                  modifiers: mods, observedCeiling: S.ceiling };
      out[sc] = L.profit ? F.projectPnl(o) : F.project(o);
    });
    /* A companion count (orders) so a money tile can also say how many and at
       what average — realistic only; it is context, not a second forecast. */
    if (sr.aux && sr.aux.length) {
      try {
        const a = F.project({ rows: sr.aux, from, horizon: hor, scenario: 'realistic', sparse: true });
        out.auxTotal = a ? a.total : null;
      } catch (e) { out.auxTotal = null; }
    }
    return out;
  });
}

/* ------------------------------------------------------------------- KPIs */

function renderKpis(p, ctx) {
  const el = document.getElementById('kpis');
  /* A lens whose measure is not the P&L's revenue gets its own tiles: quoting a
     profit, a MER or a breakeven against an order count or a shipping-address
     net-sales figure would be inventing a relationship the data does not have. */
  if (ctx.L && ctx.L !== LENSES.total) return renderKpisLens(p, ctx);
  el.style.gridTemplateColumns = ''; el.classList.remove('dense');
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


/* Tiles for a lens the P&L cannot price: one per series, plus the mix and the
   caveat. No profit, no MER, no breakeven — none of those exist for an order
   count or for net sales by destination. */
function renderKpisLens(p, ctx) {
  const el = document.getElementById('kpis');
  const L = ctx.L, unit = L.unit;
  const fmt = v => unit === 'orders' ? numf(v) : money(v, true);
  const label = S.hor === 'EOY' ? 'to year end' : 'next ' + p.horizon + ' days';

  if (!ctx.series) {
    const st = L.needs ? extState(L.needs) : 'idle';
    const wait = L.needs && EXT[L.needs] ? EXT[L.needs].retryIn : 0;
    el.style.gridTemplateColumns = ''; el.classList.remove('dense');
    el.innerHTML = `<div class="kpi accent" style="grid-column:1/-1">
      <div class="k-lbl">${esc(L.label)}</div>
      <div class="k-val">${st === 'loading' ? 'Loading…'
        : st === 'waiting' ? 'Shopify is rate-limited · retrying in ' + wait + 's'
        : st === 'failed' ? 'Shopify unavailable' : '—'}</div>
      <div class="k-sub">${st === 'failed'
        ? 'This split comes from Shopify and the request did not come back after two retries. Try again in a minute.'
        : st === 'waiting'
          ? 'Another lens just used the API’s allowance. It refills in about half a minute and this will load itself.'
          : 'Fetching two years of daily net sales from Shopify.'}</div></div>`;
    return;
  }

  const tot = ctx.series.reduce((a, sr) => a + sr[S.scen].total, 0);
  const tiles = ctx.series.map((sr, i) => {
    const sp = sr[S.scen];
    const ly = priorSameDates(sr.rows, F.addDays(sp.from, 1), F.addDays(sp.from, sp.horizon));
    const yoy = ly.sum ? (sp.total / ly.sum - 1) * 100 : null;
    /* Each tile carries the error measured on ITS OWN series. It is the fact
       that decides whether the number above it means anything: Australia lands
       within 24%, while New Zealand — a third of days with no order at all —
       measures wider than 100%, at which point a year-on-year arrow is theatre.
       So past that line the tile drops the arrow and says what it is. */
    const eb = BT && BT.byName && BT.byName[sr.name] && BT.byName[sr.name][30];
    const em = eb ? (eb.mape != null ? eb.mape : eb.coldStart ? eb.coldStart.mape : null) : null;
    const err = em != null ? '±' + (em * 100).toFixed(0) + '%' + (eb.mape == null ? ' · no prior yr' : '') : null;
    const shaky = em != null && em > 0.5;
    const aux = sr.auxTotal ? ' · <b>' + numf(sr.auxTotal) + '</b> orders · AOV ' + money(sp.total / sr.auxTotal, true) : '';
    return { lbl: sr.name + ' · ' + label, val: fmt(sp.total), accent: !!sr.primary,
      sub: 'share <b>' + (tot ? (sp.total / tot * 100).toFixed(0) : '—') + '%</b>' +
           (aux || (ly.sum ? ' · last year ' + fmt(ly.sum) : '')),
      foot: shaky
        ? '<span class="delta down">' + err + ' measured error</span> scale, not a forecast'
        : yoy != null
          ? '<span class="delta ' + (yoy > 0 ? 'up' : 'down') + '">' + (yoy > 0 ? '▲' : '▼') + ' ' +
            Math.abs(yoy).toFixed(0) + '%</span> vs last year' + (err ? ' · ' + err : '')
          : (err ? err + ' measured error' : 'no prior year') };
  });
  tiles.push({ lbl: 'Combined · ' + label, val: fmt(tot),
    sub: ctx.series.length + ' series · ' + esc(L.note),
    foot: L.ties ? 'ties to the board' : '<span class="delta down">does not tie to the board</span>' });
  /* The caveat gets a tile of its own rather than a footnote, because the tile
     row is the only part of this page a passing glance takes in. */
  /* The caveat gets a tile, but a short one: the full sentence overflowed the
     box at every viewport, and a warning spilling out of its own border reads as
     a rendering fault rather than as a warning. Headline on the face, whole
     thing in the tooltip. */
  const brief = L.brief || (unit === 'orders'
    ? 'No revenue split exists, so none is shown.'
    : 'Different measure from the P&L. Does not tie. No profit.');
  tiles.push({ lbl: 'Read this first', val: unit === 'orders' ? 'Orders only' : 'Revenue only',
    sub: '', foot: brief, warn: true, title: L.warn || '' });

  /* Six tiles is the row's natural width; a lens with more series gets a denser
     row rather than losing its tail off the right-hand edge. */
  const shown = tiles.slice(0, 9);
  el.style.gridTemplateColumns = shown.length > 6 ? `repeat(${shown.length}, 1fr)` : '';
  el.classList.toggle('dense', shown.length > 6);
  el.innerHTML = shown.map(t => `<div class="kpi${t.accent ? ' accent' : ''}${t.warn ? ' warnkpi' : ''}"${
      t.title ? ` title="${esc(t.title)}"` : ''}>
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
  const U = ctx.L && ctx.L.unit === 'orders';
  const f = v => U ? numf(v) : money(v, true);
  const defs = [
    ['pessimistic', 'Growth stops dead, and the big months land 15% short.'],
    ['realistic',   'The current trajectory continues; events repeat as they have.'],
    ['optimistic',  'Growth holds at its year-on-year rate, events scale with it.'],
  ];
  el.innerHTML = defs.map(([k, why]) => {
    /* On a lens with several series the card totals them, and there is no
       profit figure to show because the measure has no cost side. */
    const tot = ctx.series ? ctx.series.reduce((a, sr) => a + sr[k].total, 0) : ctx.scen[k].total;
    const pr = (ctx.L && ctx.L.profit) ? ctx.scen[k].profit : null;
    const on = k === S.scen;
    return `<button class="scenrow${on ? ' on' : ''}" data-scen="${k}">
      <div class="sr-top"><span class="sr-name">${k}</span><span class="sr-rev">${f(tot)}</span></div>
      <div class="sr-bot"><span class="sr-why">${why}</span>${pr != null
        ? `<span class="sr-pr ${pr < 0 ? 'neg' : 'pos'}">${money(pr, true)}</span>` : ''}</div>
    </button>`;
  }).join('');
  el.querySelectorAll('.scenrow').forEach(b => b.onclick = () => { S.scen = b.dataset.scen; render(); });

  const p = ctx.scen[S.scen];
  const spread = ctx.series
    ? ctx.series.reduce((a, sr) => a + sr.optimistic.total, 0) -
      ctx.series.reduce((a, sr) => a + sr.pessimistic.total, 0)
    : ctx.scen.optimistic.total - ctx.scen.pessimistic.total;
  document.getElementById('scenNote').textContent = 'spread ' + f(spread);
  const onPnl = ctx.L && ctx.L.profit;
  document.getElementById('beVal').textContent =
    (onPnl && p.breakevenPerDay) ? money(p.breakevenPerDay, true) + '/d' : 'n/a';
  document.getElementById('beSub').textContent = onPnl && p.pnl
    ? 'to cover ads + ' + money(p.pnl.fcPerDay, true) + ' fixed'
    : 'no cost side to this measure';

  const b30 = BT && BT[30], b90 = BT && BT[90];
  /* The sub-line names the series the figure belongs to whenever the lens has
     more than one, because a tight Australia must not be allowed to hide a
     loose rest-of-world behind a number the reader takes as covering both. */
  const accVal = b => !b ? '…' : b.mape != null ? '±' + (b.mape * 100).toFixed(0) + '%'
                     : b.coldStart ? '±' + (b.coldStart.mape * 100).toFixed(0) + '%' : '—';
  const accSub = (b, h) => {
    if (!b) return 'measuring';
    const w = BT && BT['worst' + h];
    if (b.mape == null) return (b.coldStart ? b.coldStart.n : 0) + ' origins · no prior year' + (w && !w.only ? ' · ' + w.name : '');
    return b.n + (w && !w.only ? ' origins · worst: ' + w.name : ' past origins');
  };
  document.getElementById('acc30').textContent = accVal(b30);
  document.getElementById('acc30Sub').textContent = accSub(b30, 30);
  document.getElementById('acc90').textContent = accVal(b90);
  document.getElementById('acc90Sub').textContent = accSub(b90, 90);
}

/* ------------------------------------------------------------------ chart */

function smooth(vals, n) {
  return vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - n + 1), i + 1).filter(v => v != null);
    return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
}

/* THE MAP.

   All three scenarios at once, because the honest answer to "what will November
   be" is a range and drawing one line invites it to be read as a number. The
   filled fan between pessimistic and optimistic is the scenario spread — three
   assumptions about growth. The dotted envelope outside it is something
   different and worth keeping separate: the error this model actually made when
   walked forward through the same book. They are not the same claim, and on this
   business the measured error is the wider of the two, which is itself worth
   seeing.

   Sale-period windows are shaded and today is marked, so the shape reads as a
   map of the year ahead rather than a line that happens to bend. */
/* Distinct hues for a multi-series lens. Yellow stays the brand's primary and
   the other two are chosen to survive being drawn over the sale-period wash. */
const SERIES_COLOR = ['rgba(245,235,25,0.95)', 'rgba(57,217,138,0.95)', 'rgba(120,190,255,0.95)',
                      'rgba(255,146,72,0.95)', 'rgba(232,110,200,0.95)', 'rgba(170,140,255,0.95)',
                      'rgba(179,171,172,0.85)'];

function renderChart(p, ctx) {
  const wrap = document.getElementById('chartWrap');
  const cv = document.getElementById('fcChart');
  if (!cv || !wrap.clientHeight) return;
  if (typeof Chart === 'undefined') {
    document.getElementById('chartKey').textContent = 'chart library unavailable — the numbers around it are unaffected';
    return;
  }
  const HIST = 70, SM = 7;
  if (!ctx.series) { document.getElementById('chartKey').textContent = ''; }
  /* The axis speaks the lens's unit. It read "$160" against an order count
     until this existed — a dollar sign on a number of orders is not a cosmetic
     slip, it is the chart asserting something false. */
  const isOrders = !!(ctx.L && ctx.L.unit === 'orders');
  const axf = v => isOrders ? numf(v) : money(v, true);
  const hist = ctx.list.filter(r => r.date <= p.from).slice(-HIST);
  const labels = hist.map(r => r.date).concat(p.days.map(d => d.date));
  const actual = smooth(hist.map(r => r.revenue), SM);
  const join = actual[actual.length - 1];
  const pad = new Array(hist.length - 1).fill(null);

  /* Each forecast line is smoothed with the last six ACTUAL days in front of
     it, then those are dropped — otherwise the first week of the forecast is
     averaged over a short window and starts with a step. */
  const tail = hist.slice(-(SM - 1)).map(r => r.revenue);
  const line = days => smooth(tail.concat(days.map(d => d.revenue)), SM).slice(SM - 1);
  const real = line(p.days);
  const opt = line(ctx.scen.optimistic.days);
  const pess = line(ctx.scen.pessimistic.days);

  const b = BT && BT[nearestHorizon(p.horizon)];
  const single = !ctx.series || ctx.series.length < 2;
  const lo = (b && single) ? real.map(v => v * (1 + b.p10)) : null;
  const hi = (b && single) ? real.map(v => v * (1 + b.p90)) : null;
  const fwd = a => pad.concat([join], a);

  const Y = 'rgba(245,235,25,';
  const ds = [];
  /* One series: the scenario fan and the measured envelope, as before. Several:
     a line per series instead, because three fans over each other is a
     colour-mixing puzzle rather than a chart — the spread for the selected
     scenario is in the KPI tiles and the rail. */
  if (single) {
    ds.push({ label: 'Pessimistic', data: fwd(pess), borderColor: Y + '0.45)',
              borderWidth: 1.4, pointRadius: 0, tension: .3, fill: '+1',
              backgroundColor: Y + '0.13)' });
    ds.push({ label: 'Optimistic', data: fwd(opt), borderColor: Y + '0.45)',
              borderWidth: 1.4, pointRadius: 0, tension: .3, fill: false });
    if (lo) {
      ds.push({ label: 'Measured low', data: fwd(lo), borderColor: 'rgba(179,171,172,0.42)',
                borderWidth: 1, borderDash: [2, 3], pointRadius: 0, tension: .3, fill: false });
      ds.push({ label: 'Measured high', data: fwd(hi), borderColor: 'rgba(179,171,172,0.42)',
                borderWidth: 1, borderDash: [2, 3], pointRadius: 0, tension: .3, fill: false });
    }
    ds.push({ label: 'Actual', data: actual.concat(new Array(p.days.length).fill(null)),
              borderColor: Y + '0.95)', borderWidth: 2.6, pointRadius: 0, tension: .3, fill: false });
    ds.push({ label: 'Realistic', data: fwd(real), borderColor: Y + '0.95)',
              borderDash: [6, 4], borderWidth: 2.6, pointRadius: 0, tension: .3, fill: false });
  } else {
    ctx.series.forEach((sr, i) => {
      const c = SERIES_COLOR[i % SERIES_COLOR.length];
      const sp = sr[S.scen] || sr.realistic;
      const h2 = sr.rows.filter(r => r.date <= p.from).slice(-HIST);
      const av = smooth(h2.map(r => r.revenue), SM);
      const t2 = h2.slice(-(SM - 1)).map(r => r.revenue);
      const fl = smooth(t2.concat(sp.days.map(d => d.revenue)), SM).slice(SM - 1);
      ds.push({ label: sr.name, data: av.concat(new Array(sp.days.length).fill(null)),
                borderColor: c, borderWidth: 2.4, pointRadius: 0, tension: .3, fill: false });
      ds.push({ label: sr.name + ' · forecast',
                data: new Array(h2.length - 1).fill(null).concat([av[av.length - 1]], fl),
                borderColor: c, borderDash: [6, 4], borderWidth: 2.4, pointRadius: 0,
                tension: .3, fill: false });
    });
  }

  /* Shading and markers, drawn straight onto the canvas rather than pulled in
     as an annotation plugin — three shapes do not justify another dependency. */
  const bands = activeSale()
    .filter(m => m.start <= labels[labels.length - 1] && (m.paybackEnd || m.end) >= labels[0])
    .map(m => ({ name: m.name, start: m.start, end: m.end, pbEnd: m.paybackEnd }));
  const marker = {
    id: 'dlmarks',
    beforeDatasetsDraw(ch) {
      const { ctx: c, chartArea: ar, scales } = ch;
      const at = d => { const i = labels.indexOf(d); return i < 0 ? null : scales.x.getPixelForValue(i); };
      c.save();
      bands.forEach(bd => {
        const x1 = at(bd.start), x2 = at(bd.end);
        if (x1 != null && x2 != null) {
          c.fillStyle = 'rgba(245,235,25,0.07)';
          c.fillRect(x1, ar.top, x2 - x1, ar.bottom - ar.top);
          c.fillStyle = 'rgba(245,235,25,0.55)';
          c.font = '600 9px system-ui, sans-serif';
          c.fillText(bd.name.replace(/ \d{4}$/, '') + ' sale', x1 + 3, ar.top + 10);
        }
        const x3 = at(bd.pbEnd);
        if (x2 != null && x3 != null) {
          /* On a long window the run-up is a sliver, and "payback" would print
             on top of the sale's own label; it takes the next line instead. */
          const nameW = x1 != null ? c.measureText(bd.name.replace(/ \d{4}$/, '') + ' sale').width + 6 : 0;
          const pbY = (x1 != null && x2 - x1 < nameW) ? ar.top + 21 : ar.top + 10;
          /* Lighter than the run-up, and labelled: an unlabelled red wash over
             three weeks of the chart reads as an error region rather than as
             the demand that was pulled forward out of it. */
          c.fillStyle = 'rgba(255,90,82,0.045)';
          c.fillRect(x2, ar.top, x3 - x2, ar.bottom - ar.top);
          c.fillStyle = 'rgba(255,90,82,0.5)';
          c.font = '600 9px system-ui, sans-serif';
          c.fillText('payback', x2 + 3, pbY);
        }
      });
      const xt = at(p.from);
      if (xt != null) {
        c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1; c.setLineDash([4, 3]);
        c.beginPath(); c.moveTo(xt, ar.top); c.lineTo(xt, ar.bottom); c.stroke();
        c.setLineDash([]);
        c.fillStyle = 'rgba(255,255,255,0.55)';
        c.font = '600 9px system-ui, sans-serif';
        c.fillText('today', xt + 4, ar.bottom - 4);
      }
      c.restore();
    },
  };

  if (CHART) CHART.destroy();
  const grid = 'rgba(255,255,255,0.06)', tick = 'rgba(179,171,172,0.8)';
  CHART = new Chart(cv.getContext('2d'), {
    type: 'line',
    data: { labels, datasets: ds },
    plugins: [marker],
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: i => i.dataset.label !== 'Measured low' && i.dataset.label !== 'Measured high',
          itemSort: (a, z) => z.parsed.y - a.parsed.y,
          callbacks: {
            title: it => niceFull(it[0].label),
            label: i => i.dataset.label + ': ' + axf(i.parsed.y) + (isOrders ? ' orders/day' : '/day'),
          },
        },
      },
      scales: {
        x: { grid: { color: grid }, ticks: { color: tick, maxTicksLimit: 10,
             callback(v) { const d = this.getLabelForValue(v); return d ? isoToNice(d) : ''; } } },
        y: { grid: { color: grid }, ticks: { color: tick, callback: v => axf(v) }, beginAtZero: true },
      },
    },
  });

  document.getElementById('chartSpan').textContent =
    'Map · ' + isoToNice(hist[0].date) + ' → ' + isoToNice(p.days[p.days.length - 1].date);
  document.getElementById('chartKey').innerHTML = single
    ? `<span class="k act">Actual</span><span class="k real">Realistic</span>
       <span class="k fan">Scenario range</span>
       ${b ? '<span class="k env">Measured error at ' + nearestHorizon(p.horizon) + 'd</span>' : ''}
       ${bands.length ? '<span class="k sale">Sale period</span>' : ''}`
    : ctx.series.map((sr, i) => `<span class="k ser" style="--sc:${SERIES_COLOR[i % SERIES_COLOR.length]}">${esc(sr.name)}</span>`).join('') +
      '<span class="k real">solid actual · dashed forecast</span>' +
      (bands.length ? '<span class="k sale">Sale period</span>' : '');
}

/* ------------------------------------------------------- the timeline strip */

/* What is happening, under the days it happens on.

   This replaced a row of four panels below the chart. The numbers were all
   correct there and all in the wrong place: a table of months cannot tell you
   that the September dip IS the Father's Day payback, because the two facts sat
   two feet apart with no line drawn between them. Here a month, the event that
   explains it and the multiple applied to it occupy the same column of pixels.

   Aligned to the chart's OWN plot area rather than to the panel — read from
   CHART.chartArea after it renders, because the y-axis labels take a variable
   amount of the left edge and a strip laid out on the panel's width is wrong by
   however wide "$70K" happens to be. */
function renderTimeline(p, ctx) {
  const el = document.getElementById('tline');
  if (!el) return;
  if (typeof Chart === 'undefined' || !CHART || !CHART.scales || !CHART.scales.x) {
    el.innerHTML = ''; return;
  }
  const labels = CHART.data.labels;
  const first = labels[0], last = labels[labels.length - 1];
  const span = Math.max(1, dayDiff(first, last));
  const pos = d => Math.max(0, Math.min(100, dayDiff(first, d) / span * 100));
  const seg = (a, b) => ({ left: pos(a), width: Math.max(0.4, pos(b) - pos(a)) });

  const ar = CHART.chartArea;
  const total = CHART.width || 1;
  const plotW = Math.max(1, ar.right - ar.left);
  const padL = (ar.left / total * 100).toFixed(3);
  const padR = ((total - ar.right) / total * 100).toFixed(3);

  /* ---- lane 1: months, with the numbers that used to be in the table ---- */
  const byMonth = {};
  /* The lens's own rows, so a country lane sums Australian net sales rather
     than the whole book's revenue. */
  const srcRows = (ctx.pri && ctx.pri.rows) || ctx.list;
  srcRows.forEach(r => {
    if (r.date < first || r.date > last || !(r.revenue > 0)) return;
    const k = r.date.slice(0, 7);
    (byMonth[k] = byMonth[k] || { actual: 0, days: 0 });
    byMonth[k].actual += r.revenue; byMonth[k].days++;
  });
  p.months.forEach(m => {
    (byMonth[m.month] = byMonth[m.month] || { actual: 0, days: 0 });
    byMonth[m.month].fc = m;
  });

  const monthCells = Object.keys(byMonth).sort().map(k => {
    const b = byMonth[k], m = b.fc;
    const dim = F.daysInMonth(+k.slice(0, 4), +k.slice(5, 7));
    const a = k + '-01' < first ? first : k + '-01';
    const z = k + '-' + String(dim).padStart(2, '0');
    const g = seg(a, z > last ? last : z);
    const idx = p.basis.season.index[+k.slice(5, 7)];
    const n = p.basis.season.observations[+k.slice(5, 7)] || 0;
    /* A forecast month shows the forecast and what the same dates did last
       year; a month already banked shows what it actually took. Never mixed —
       labelling a projection and a result the same way is how a forecast gets
       quoted back as a fact. */
    const fmtv = (ctx.L && ctx.L.unit === 'orders') ? (v => numf(v)) : (v => money(v, true));
    let head, sub;
    if (m) {
      const ds = p.days.filter(d => d.month === k);
      const ly = priorSameDates(srcRows, ds[0].date, ds[ds.length - 1].date);
      head = fmtv(m.revenue);
      /* The day count leads on a part month. $197K for the 22 days left of
         September is not September, and the figure is quoted against the same
         22 days last year, so both halves of the comparison need saying. */
      sub = (ds.length < dim ? ds.length + ' days left · ' : '') +
            (ly.sum ? 'x' + (m.revenue / ly.sum).toFixed(2) + ' on same dates last yr' : 'no prior year to compare');
    } else {
      head = fmtv(b.actual);
      /* A banked month reports the same measure as a forecast one — its
         year-on-year — so the two lanes read as one series rather than as two
         different kinds of number that happen to sit side by side. */
      const a2 = k + '-01' < first ? first : k + '-01';
      const z2 = k + '-' + String(b.days).padStart(2, '0');
      const ly = priorSameDates(srcRows, a2, z2 > last ? last : z2);
      sub = (b.days < dim ? b.days + ' of ' + dim + ' days · ' : '') +
            (ly.sum ? 'x' + (b.actual / ly.sum).toFixed(2) + ' on same dates last yr' : 'no prior year to compare');
    }
    /* HOW MUCH FITS IS DECIDED HERE, not by the browser cutting text off.

       A month's cell is as wide as the month is long, and at a 90-day horizon
       the 22 remaining days of September get a narrow column — too narrow for
       four lines of text, which the first cut simply sliced through mid-word.
       The pixel width is known (the share of the plot area), so the cell drops
       the least important line at each threshold and keeps everything in the
       tooltip. Degrading on purpose beats clipping by accident. */
    const px = g.width / 100 * plotW;
    /* Every line says what kind of number it is. "season x0.73 · 1 yr" was
       three abbreviations deep; "month index x0.73 · 1 yr of data" is the same
       fact in words a reader who has not seen the maths can follow. */
    const idxLine = n ? 'month index x' + idx.toFixed(2) + (n <= 1 ? ' · 1 yr of data' : '') : 'no history for this month';
    const kind = m ? 'forecast' : 'actual';
    const full = [monthLabel(k), kind, head, sub, idxLine].filter(Boolean).join(' · ');
    const name = px < 64 ? MONTH_ABBR[+k.slice(5, 7) - 1] : monthLabel(k);
    return `<div class="tl-m${m ? '' : ' past'}${px < 64 ? ' narrow' : ''}" style="left:${g.left}%;width:${g.width}%"
        title="${esc(full)}">
      <div class="tl-m-name">${name}${px < 118 ? '' : ' <i>' + kind + '</i>'}</div>
      ${px >= 52 ? `<div class="tl-m-val">${head}</div>` : ''}
      ${px >= 96 ? `<div class="tl-m-sub">${sub}</div>` : ''}
      ${px >= 96 ? `<div class="tl-m-idx">${idxLine}</div>` : ''}
    </div>`;
  }).join('');

  /* ---- lane 2: multipliers applied on top of the seasonality --------------
     Each band is one modifier, quoted at its PEAK day: "+47% on average" says
     nothing about the day it mattered most. The label is allowed to run past a
     narrow band — a fortnight is 6% of a six-month window — but never past the
     lane's right edge. */
  const laneRight = pctLeft => Math.max(40, (100 - pctLeft) / 100 * plotW - 6);
  const bars = [];
  allMods().forEach(m => {
    if ((m.paybackEnd || m.end) < first || m.start > last) return;
    const mine = m.kind === 'user';
    const peak = (m.profile && m.profile.length)
      ? Math.max.apply(null, m.profile.map(o => o.lift)) : (m.lift || 0);
    const g = seg(m.start < first ? first : m.start, m.end > last ? last : m.end);
    const nm = m.name.replace(/ \d{4}$/, '');
    const what = mine ? 'declared' : (m.measured && m.measured.own ? 'sale period · measured' : 'sale period · carried fwd');
    const span = isoToNice(m.start) + '–' + isoToNice(m.end);
    bars.push(`<div class="tl-b${mine ? ' mine' : ''}" style="left:${g.left}%;width:${g.width}%"
        title="${esc(nm)} · ${what} · ${span} · peak x${(1 + peak).toFixed(2)} on the forecast">
        <div class="tl-bl" style="max-width:${laneRight(g.left).toFixed(0)}px"><b>x${(1 + peak).toFixed(2)}</b>
        <span>${esc(nm)} · ${esc(what)} · ${span}</span></div></div>`);
    if (m.payback && m.paybackEnd) {
      const gp = seg(m.end, m.paybackEnd > last ? last : m.paybackEnd);
      bars.push(`<div class="tl-b pb" style="left:${gp.left}%;width:${gp.width}%"
        title="payback after ${esc(nm)} · demand pulled forward · ${isoToNice(m.end)}–${isoToNice(m.paybackEnd)} · x${(1 + m.payback).toFixed(2)}">
        <div class="tl-bl" style="max-width:${laneRight(gp.left).toFixed(0)}px"><b>x${(1 + m.payback).toFixed(2)}</b>
        <span>payback after ${esc(nm)} · to ${isoToNice(m.paybackEnd)}</span></div></div>`);
    }
  });
  /* Recurring events get a marker, not a band: they are already inside the
     month index above, and a band would read as a second multiplier on top of
     it. The marker quotes the index so the reader can see where the event's
     effect actually lives. */
  const evList = F.EVENTS.filter(e => e.via === 'index').map(e => {
    const k = Object.keys(byMonth).find(x => +x.slice(5, 7) === e.month);
    if (!k) return null;
    const dim = F.daysInMonth(+k.slice(0, 4), e.month);
    const mid = k + '-' + String(Math.round(dim / 2)).padStart(2, '0');
    if (mid < first || mid > last) return null;
    return { e, x: pos(mid), idx: p.basis.season.index[e.month] };
  }).filter(Boolean).sort((a, b) => a.x - b.x);
  /* A marker's text may not run into its neighbour's: on a six-month window
     BFCM and its December payback sit 16% apart, and two lines of small print
     printed over each other read as neither. */
  const isRight = o => o.x > 88;
  const evs = evList.map((o, i) => {
    const right = isRight(o);
    /* The room on the side the text grows into. A neighbour whose text grows
       towards this one shares the gap, so each takes half. */
    let gapPct;
    if (right) { const pv = evList[i - 1]; gapPct = pv ? (o.x - pv.x) * (isRight(pv) ? 1 : 0.5) : o.x; }
    else { const nx = evList[i + 1]; gapPct = nx ? (nx.x - o.x) * (isRight(nx) ? 0.5 : 1) : 100 - o.x; }
    const maxW = Math.max(40, Math.min(plotW * 0.16, gapPct / 100 * plotW - 6));
    const at = right ? `right:${(100 - o.x).toFixed(2)}%` : `left:${o.x.toFixed(2)}%`;
    return `<div class="tl-e${right ? ' r' : o.x < 8 ? ' l' : ''}" style="${at};max-width:${maxW.toFixed(0)}px" title="${esc(o.e.name)} · ${esc(o.e.note)}">
        ${esc(o.e.name)}<small>${MONTH_ABBR[o.e.month - 1]} index x${o.idx ? o.idx.toFixed(2) : '—'}</small></div>`;
  }).join('');

  const today = pos(p.from);
  const key = `<div class="tl-key">
      <span class="tk-h">Timeline</span>
      <span class="tk months" title="Each month: the forecast (or the actual once it is banked), its multiple on the same dates last year, and its month index">months: forecast or actual · x on same dates last yr · month index</span>
      <span class="tk band" title="A sale period or declaration, multiplied onto the forecast for those days; quoted at its peak">multiplier applied</span>
      <span class="tk band pb" title="Demand pulled forward by the sale: the days after it run below trend">payback</span>
      <span class="tk band mine" title="Declared by the business, not measured from the book">declared</span>
      <span class="tk ev" title="Recurring event already inside the month index — shown so you know where it lives, not added again">event in the month index</span>
      <span class="tk now">today</span>
    </div>`;
  el.innerHTML = `<div class="tl-inner" style="padding-left:${padL}%;padding-right:${padR}%">
      <div class="tl-rel">
        ${key}
        <div class="tl-now" style="left:${today}%"></div>
        <div class="tl-lane tl-months">${monthCells}</div>
        <div class="tl-lane tl-drivers">${evs}${bars.join('') ||
          '<div class="tl-none">No sale period or declaration falls in this window — the forecast is the seasonality and trend alone.</div>'}</div>
      </div>
    </div>`;
}

const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/* ------------------------------------------------------ trends, in the rail */

/* Three small bar charts rather than three tables. They answer "when is the
   business big", "is it still growing" and "which days matter" at a glance, and
   at a glance is what a rail is for. Plain divs: a bar chart of twelve values
   does not need a charting library. */
function miniBars(el, rows, opts) {
  opts = opts || {};
  const vals = rows.map(r => r.value).filter(v => v != null);
  if (!vals.length) { el.innerHTML = ''; return; }
  const max = Math.max.apply(null, vals.concat(opts.floor != null ? [opts.floor] : []));
  const base = opts.base != null ? opts.base : 0;
  el.innerHTML = rows.map(r => {
    if (r.value == null) {
      return `<div class="mb none" title="${esc(r.label)}: no history">
        <div class="mb-l">${esc(r.label)}</div><div class="mb-t"><i style="width:0"></i></div>
        <div class="mb-v">—</div></div>`;
    }
    const w = Math.max(1.5, (r.value - base) / (max - base) * 100);
    return `<div class="mb${r.hi ? ' hi' : ''}${r.thin ? ' thin' : ''}" title="${esc(r.title || r.label)}">
      <div class="mb-l">${esc(r.label)}</div>
      <div class="mb-t"><i style="width:${w.toFixed(1)}%"></i>${
        /* Clamped: the reference marker is a value on the same scale, and on the
           order-count lens the year-on-year figures run past the bar scale's
           top, which put left at 130% and pushed the track's own width out. */
        opts.mark != null ? `<u style="left:${Math.max(0, Math.min(100,
          (opts.mark - base) / (max - base) * 100)).toFixed(1)}%"></u>` : ''}</div>
      <div class="mb-v">${esc(r.text)}</div></div>`;
  }).join('');
}

function renderTrends(p, ctx) {
  const b = p.basis;
  const inHor = new Set(p.months.map(m => +m.month.slice(5, 7)));

  /* Shape of the year. Thin bars are the months fitted on a single year — the
     sample size travels with the figure rather than in a footnote. */
  const srows = [];
  let thin = 0;
  for (let m = 1; m <= 12; m++) {
    const n = b.season.observations[m] || 0;
    if (n <= 1) thin++;
    srows.push({ label: MONTH_ABBR[m - 1], value: n ? b.season.index[m] : null,
                 text: n ? b.season.index[m].toFixed(2) : '—', hi: inHor.has(m), thin: n <= 1,
                 title: MONTH_ABBR[m - 1] + ': ' + (n ? b.season.index[m].toFixed(2) + 'x an average month' : 'no history') +
                        ' · ' + n + ' year' + (n === 1 ? '' : 's') + ' observed' });
  }
  miniBars(document.getElementById('seasonBars'), srows, { mark: 1 });
  document.getElementById('seasonNote').textContent =
    thin + ' of 12 on one year' + (inHor.size ? ' · ' + inHor.size + ' in horizon' : '');

  /* Growth. Whole months only, like for like.

     These are the REPORTED figures — what the sheet says each month did — and a
     month a sale period ran in will read higher than the growth the forecast
     uses, because the forecast measures growth on the promotion-corrected
     series. August 2026 reports x2.02 and the model's range tops out at x1.77
     for exactly that reason. Rather than quietly show one number and use the
     other, the affected months are marked and the note names them. */
  const g = b.growth;
  const lifted = {};
  activeSale().forEach(m => {
    for (let d = m.start; d <= (m.paybackEnd || m.end); d = F.addDays(d, 1)) lifted[d.slice(0, 7)] = m.name;
  });
  const liftedMonths = [];
  const grows = ctx.yoy.filter(r => r.yoy != null).slice(-8).map(r => {
    const sale = lifted[r.month];
    if (sale) liftedMonths.push(MONTH_ABBR[+r.month.slice(5, 7) - 1]);
    return { label: monthLabel(r.month), value: r.yoy, text: 'x' + r.yoy.toFixed(2),
             thin: !!sale,
             title: monthLabel(r.month) + ': ' + money(r.revenue, true) + ' vs ' +
                    money(r.priorYear, true) + ' last year' +
                    (sale ? ' · lifted by ' + sale + ', so the model reads it lower' : '') };
  });
  miniBars(document.getElementById('growthBars'), grows, { base: 1, mark: g.yoy || 1 });
  document.getElementById('growthNote').textContent = g.yoy
    ? 'model uses x' + g.yoy.toFixed(2) +
      (liftedMonths.length ? ' · ' + liftedMonths.join(', ') + ' sale-lifted' : ' · ' + g.n + ' months')
    : 'not enough history';

  const dn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const drows = [1, 2, 3, 4, 5, 6, 0].map(i => ({
    label: dn[i], value: b.dowIdx[i], text: b.dowIdx[i].toFixed(2),
    title: dn[i] + ': ' + b.dowIdx[i].toFixed(2) + 'x an average day' }));
  miniBars(document.getElementById('dowBars'), drows, { mark: 1 });
  const vals = Object.keys(b.dowIdx).map(k => b.dowIdx[k]);
  document.getElementById('dowNote').textContent =
    'spread ' + Math.min.apply(null, vals).toFixed(2) + '–' + Math.max.apply(null, vals).toFixed(2);
}

/* ------------------------------------------------- where every $100 goes */

/* Five costs as shares of a hundred dollars of sales. Drawn under the profit
   forecast for the horizon, and in the explanation for the last 30 days.

   Computed from ACTUAL rows, not the forecast. Pending days are excluded — a
   day with revenue typed but ad spend not yet would show ads at zero and
   flatter the whole bar, which is the same trap that once produced an 18%
   margin on a day whose real margin was about -25%.

   Fixed cost is the one segment that does not scale, so its share is the whole
   story: it takes 16c of a dollar on a quiet day and 6c in November, and that
   is why this business makes its year in two months. */
function hundredOf(rows) {
  const usable = rows.filter(r => r.revenue > 0 && !r.pending && r.totalFC != null);
  if (!usable.length) return null;
  const S = k => usable.reduce((a, r) => a + (+r[k] || 0), 0);
  const rev = S('revenue');
  if (!rev) return null;
  const gst = (rev - S('revExGst')) / rev * 100;
  const variable = S('totalVC') / rev * 100;
  const ads = S('totalAds') / rev * 100;
  const fixed = S('totalFC') / rev * 100;
  return { gst, variable, ads, fixed, profit: 100 - gst - variable - ads - fixed,
           days: usable.length, revenue: rev, perDay: rev / usable.length,
           from: usable[0].date, to: usable[usable.length - 1].date };
}

/* And the same shape from a forecast month, so the explanation can put a
   November beside a quiet week. */
function hundredOfMonth(mo, pnl) {
  if (!mo || !mo.revenue) return null;
  const gst = (1 - pnl.exGstRate) * 100;
  const variable = pnl.vcRate * 100;
  const ads = mo.adSpend / mo.revenue * 100;
  const fixed = mo.fixed / mo.revenue * 100;
  return { gst, variable, ads, fixed, profit: 100 - gst - variable - ads - fixed,
           days: mo.days, revenue: mo.revenue, perDay: mo.revenue / mo.days };
}

const H100_SEG = [
  ['gst', 'GST'], ['vc', 'Product, shipping, fees'], ['ads', 'Ads'],
  ['fc', 'Wages and overheads'], ['pf', 'Profit'],
];
function hundredBar(h, label, sub, compact) {
  if (!h) return '';
  const seg = [h.gst, h.variable, h.ads, h.fixed, Math.max(0, h.profit)];
  const total = seg.reduce((a, x) => a + x, 0) || 100;
  const cls = i => (i === 4 && h.profit < 0) ? 'loss' : H100_SEG[i][0];
  return `<div class="h100${compact ? ' compact' : ''}">
    <div class="h100-h">${esc(label)} <small>${esc(sub)}</small></div>
    <div class="h100-bar">${seg.map((v, i) =>
      `<i class="${cls(i)}" style="width:${(v / total * 100).toFixed(2)}%"
          title="${H100_SEG[i][1]}: $${v.toFixed(2)} of every $100"></i>`).join('')}</div>
    <div class="h100-key">${seg.map((v, i) =>
      `<span class="${cls(i)}"><b>$${(i === 4 && h.profit < 0 ? h.profit : v).toFixed(0)}</b> ${H100_SEG[i][1]}</span>`).join('')}</div>
  </div>`;
}

/* ------------------------------------------------------ profit forecast */

/* Month by month, under the scenario on screen. Revenue is the headline on the
   rest of the page; this is the panel that says what is left of it, and it
   exists because the answer changes sign: a September at $197K loses money and
   a November at $1.3M makes the year, on the same cost base.

   Bars are drawn from a zero line — a loss goes left in red, a profit right in
   green — so the sign is visible before the number is read. Each row's tooltip
   carries the pessimistic-to-optimistic spread for that month. The $100 bar
   beneath is the horizon's own cost structure: how the forecast revenue splits
   into GST, variable cost, ads, fixed cost and profit. */
function renderProfit(p, ctx) {
  const bars = document.getElementById('profitBars');
  const h100 = document.getElementById('profitH100');
  const note = document.getElementById('profitNote');
  if (!bars) return;
  if (ctx.L && !ctx.L.profit) {
    bars.innerHTML = `<div class="empty">Costs are recorded for the business as a whole —
      not per customer group, destination or product — so profit is forecast on the
      <b>Total</b> lens only.</div>`;
    h100.innerHTML = '';
    note.textContent = 'Total lens only';
    return;
  }
  const months = p.months || [];
  const per = k => {
    const by = {}; ((ctx.scen[k] && ctx.scen[k].months) || []).forEach(m => by[m.month] = m); return by;
  };
  const lo = per('pessimistic'), hi = per('optimistic');
  const maxAbs = Math.max(1, ...months.map(m => Math.abs(m.profit || 0)),
                          ...months.map(m => Math.abs((lo[m.month] || {}).profit || 0)),
                          ...months.map(m => Math.abs((hi[m.month] || {}).profit || 0)));
  const dim = k => F.daysInMonth(+k.slice(0, 4), +k.slice(5, 7));
  bars.innerHTML = months.map(m => {
    const pr = m.profit || 0, neg = pr < 0;
    const w = Math.abs(pr) / maxAbs * 50;
    const l = (lo[m.month] || {}).profit, h = (hi[m.month] || {}).profit;
    const part = m.days < dim(m.month);
    const label = MONTH_ABBR[+m.month.slice(5, 7) - 1] + (part ? ' <i>' + m.days + 'd</i>' : '');
    const range = (l != null && h != null) ? ' · pessimistic ' + money(l, true) + ' to optimistic ' + money(h, true) : '';
    const title = monthLabel(m.month) + (part ? ' (' + m.days + ' days)' : '') + ': ' + money(pr, true) +
      ' profit on ' + money(m.revenue, true) + ' revenue, margin ' + (m.margin != null ? (m.margin * 100).toFixed(1) + '%' : '—') +
      ' · ads ' + money(m.adSpend, true) + ' · fixed ' + money(m.fixed, true) + range;
    /* The spread as a faint whisker on the same scale, so a month whose sign is
       not settled between the scenarios looks unsettled. */
    const wl = l != null ? l / maxAbs * 50 : null, wh = h != null ? h / maxAbs * 50 : null;
    const whisker = (wl != null && wh != null)
      ? `<u style="left:${(50 + Math.min(wl, wh)).toFixed(1)}%;width:${Math.max(0.4, Math.abs(wh - wl)).toFixed(1)}%"></u>` : '';
    return `<div class="pr${neg ? ' neg' : ' pos'}" title="${esc(title)}">
      <div class="pr-l">${label}</div>
      <div class="pr-t"><s></s>${whisker}<i style="left:${(neg ? 50 - w : 50).toFixed(1)}%;width:${w.toFixed(1)}%"></i></div>
      <div class="pr-v">${money(pr, true)}<small>${m.margin != null ? (m.margin * 100).toFixed(0) + '% margin' : '—'}</small></div>
    </div>`;
  }).join('');

  /* The horizon's own $100. GST and variable cost are rates; ads and fixed are
     what the projection actually applied, so a horizon that crosses November
     shows fixed cost's share shrinking as it should. */
  const pnl = p.pnl;
  if (pnl && p.total) {
    const fixed = months.reduce((a, m) => a + (m.fixed || 0), 0);
    const hh = { gst: (1 - pnl.exGstRate) * 100, variable: pnl.vcRate * 100,
                 ads: p.adSpend / p.total * 100, fixed: fixed / p.total * 100 };
    hh.profit = 100 - hh.gst - hh.variable - hh.ads - hh.fixed;
    const complete = ctx.list.filter(r => r.revenue > 0 && !r.pending && r.totalFC != null);
    const now = hundredOf(complete.slice(-30));
    h100.innerHTML = hundredBar(hh, 'Every $100 of forecast sales',
      now ? 'last ' + now.days + 'd actual: $' + now.profit.toFixed(0) : '', true);
  } else h100.innerHTML = '';

  const label = S.hor === 'EOY' ? 'to year end' : 'next ' + p.horizon + ' days';
  const lo_t = ctx.scen.pessimistic && ctx.scen.pessimistic.profit, hi_t = ctx.scen.optimistic && ctx.scen.optimistic.profit;
  note.textContent = S.scen + ' · ' + money(p.profit, true) + ' ' + label +
    (lo_t != null && hi_t != null ? ' · ' + money(lo_t, true) + ' to ' + money(hi_t, true) : '');
}

/* Declarations the page cannot measure from the book, and the reader once typed
   into a form. The form is gone: a modifier typed into one browser's storage
   applied to that browser only, and the board is read in several. Anything the
   business knows that the book does not — a launch, a price rise, a sale being
   planned — is declared HERE, ships with the page, and shows on the timeline
   in green as "declared" so nobody mistakes it for something measured.

     { name: 'Pro Mat Plus launch', start: '2026-08-06', end: '2026-08-22', lift: 26, payback: 0 }

   lift and payback are percentages. A browser that still carries an older
   typed declaration keeps applying it, so that nothing silently changes on a
   page that has been trusted. */
const DECLARED = [];

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
  L: 'run rate', g: 'growth trend', D: 'weekday', S: 'month',
  Y: 'year on year', M: 'modifiers', w: 'blend',
  c: 'contribution', a: 'ad rate', F: 'fixed cost',
};

function renderNotes(p) {
  document.getElementById('notesBody').className =
    'notes-body ' + (S.notesMode === 'simple' ? 'plain' : 'maths');
  return S.notesMode === 'simple' ? renderNotesPlain(p) : renderNotesMaths(p);
}

/* PLAIN ENGLISH — the default, because most of the people who open this want to
   know whether to trust the number, not how it was derived.

   Five steps, no symbols, and one picture that does more work than the rest of
   the page put together: where $100 of sales goes on an ordinary day, next to
   the same $100 in November. Fixed cost is the same $2,700 either way, so it
   eats 16c of every dollar now and 6c in November — which is the entire reason
   the year is made in two months, said in a way nobody has to be talked
   through. */
function renderNotesPlain(p) {
  const el = document.getElementById('notesBody');
  const pnl = p.pnl, b = p.basis, g = b.growth;
  const _btT = btTotal(), b30 = _btT && _btT[30], b90 = _btT && _btT[90];
  const nov = p.months.find(m => m.month.slice(5) === '11');
  const dow = b.dowIdx;
  const dnames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  let best = 0, worst = 0;
  for (let i = 1; i < 7; i++) { if (dow[i] > dow[best]) best = i; if (dow[i] < dow[worst]) worst = i; }
  let bigM = 1, smallM = 1;
  for (let m = 2; m <= 12; m++) {
    if (b.season.observations[m] && b.season.index[m] > b.season.index[bigM]) bigM = m;
    if (b.season.observations[m] && b.season.index[m] < b.season.index[smallM]) smallM = m;
  }

  /* Where $100 goes: the last 30 complete days of ACTUAL trade, beside a
     forecast November. Fixed cost is the same dollar amount in both, so the
     only segment that visibly moves is the one that explains the business. */
  const complete = (rows() || []).filter(r => r.revenue > 0 && !r.pending && r.totalFC != null);
  const now = hundredOf(complete.slice(-30));
  const big = nov ? hundredOfMonth(nov, pnl) : null;

  const steps = [
    ['We look at what you actually sold',
     `Every single day of 2025 and 2026, out of your own P&amp;L sheet. Nothing here is an
      industry average or a rule of thumb.`],
    ['We take your sales promotions out first',
     `If you ran a Father&rsquo;s Day promo, we pull that bump out before we learn anything —
      otherwise the model decides a discount fortnight is your new normal, and then expects
      it every week for the rest of the year.`],
    ['We learn four of your habits',
     `<b>Busy days:</b> ${dnames[best]} is your strongest, ${dnames[worst]} your weakest.<br>
      <b>Big months:</b> ${MONTH_ABBR[bigM - 1]} is about
      ${(b.season.index[bigM] / (b.season.index[smallM] || 1)).toFixed(1)}x
      ${MONTH_ABBR[smallM - 1]}.<br>
      <b>Growth:</b> you are running about <b>${(g.yoy || 1).toFixed(1)}x</b> last year.<br>
      <b>Today&rsquo;s pace:</b> about <b>${money(p.level)}</b> a day once the season and the
      day of the week are stripped out.`],
    ['We guess every future day twice, then split the difference',
     `Once from <b>today&rsquo;s pace</b>, adjusted for what day and what month it is. Once
      from <b>the same days last year</b>, scaled up by your growth. The second guess is
      worth more next week than next quarter, so its share shrinks the further out we look.`],
    ['We add your promotions back on, then take the costs off',
     `Whatever you have declared goes back on, and then your sheet&rsquo;s own cost lines turn
      sales into profit. That is the picture below.`],
  ];

  el.innerHTML = `
    <div class="ncol">
      <ol class="plainsteps">${steps.map(st =>
        `<li><h4>${st[0]}</h4><p>${st[1]}</p></li>`).join('')}</ol>
    </div>
    <div class="ncol">
      <div class="plainbox">
        <h4>Where every $100 of sales goes</h4>
        ${hundredBar(now, 'The last ' + (now ? now.days : 0) + ' days', money(now ? now.perDay : 0) + '/day, actual')}
        ${big ? hundredBar(big, 'A day in November', money(big.perDay) + '/day, forecast') : ''}
        <p class="plainnote">The wages and overheads bar is the same
          <b>${money(pnl.fcPerDay)} a day</b> in both — it does not care how much you sell. That
          is the whole business in one line: it eats <b>${now ? now.fixed.toFixed(0) : '—'}c</b> of
          every dollar right now and only <b>${big ? big.fixed.toFixed(0) : '—'}c</b> in
          November, which is why the year is made in two months.</p>
        <p class="plainbig">You need about <b>${money(p.breakevenPerDay)} a day</b>
          — ${money(p.breakevenPerDay * 30, true)} a month — before you make a cent.</p>
      </div>
      <div class="plainbox">
        <h4>How right has it been?</h4>
        <p>We rewind to a date in your own history, forget everything after it, forecast, and
          check. Doing that over and over:</p>
        <p class="plainbig">Usually within
          <b>${b30 ? (b30.mape * 100).toFixed(0) : '—'}%</b> a month out, and
          <b>${b90 ? (b90.mape * 100).toFixed(0) : '—'}%</b> three months out.</p>
      </div>
      <div class="plainbox warn">
        <h4>Where to be careful</h4>
        <p><b>November is the biggest guess and the thinnest evidence.</b> You have only had
          one Black Friday on the books, so nothing in your history can check it. When we
          tested the model on a year that had never seen one, it under-guessed by more than
          half.</p>
        <p><b>It cannot know what you have not told it.</b> A new product, a price rise, a
          sale you are planning — declare those and it will. They show on the timeline in green.</p>
      </div>
    </div>`;
}

/* THE MATHS — the same thing again, for when the plain version raises a question
   it cannot answer. */
function renderNotesMaths(p) {
  const el = document.getElementById('notesBody');
  const b = p.basis, pnl = p.pnl, g = b.growth;
  const dowVals = Object.keys(b.dowIdx).map(k => b.dowIdx[k]);
  const seaVals = [];
  for (let m = 1; m <= 12; m++) if (b.season.observations[m]) seaVals.push(b.season.index[m]);
  const rng = a => Math.min.apply(null, a).toFixed(2) + '–' + Math.max.apply(null, a).toFixed(2);
  const _btT = btTotal(), b30 = _btT && _btT[30], b90 = _btT && _btT[90];
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
         a fifth arrow from Y into A (g is the same rate as Y) would be true but
         would cost more legibility than it buys — the symbol table carries it. -->
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
       ' a year — your measured year-on-year rate, applied as a trend'],
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

  /* Like-for-like year on year, whole months only, for the growth rail. */
  const byM = {};
  list.forEach(r => { const k = r.date.slice(0, 7); (byM[k] = byM[k] || { s: 0, n: 0 }); byM[k].s += r.revenue; byM[k].n++; });
  const dim = k => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7), 0)).getUTCDate();
  const yoy = Object.keys(byM).sort().map(k => {
    const pv = (+k.slice(0, 4) - 1) + k.slice(4);
    const whole = byM[k].n >= dim(k) && byM[pv] && byM[pv].n >= dim(pv);
    return { month: k, revenue: byM[k].s, priorYear: byM[pv] ? byM[pv].s : null,
             yoy: whole ? byM[k].s / byM[pv].s : null };
  });

  /* Every lens's series, projected once and shared by every renderer. */
  const L = lens();
  const series = runLens(list, hor);
  const ctx = { list, scen, eoy, yoy, L, series,
                pri: series && series.find(x => x.primary) };
  /* The header shows the forecast ORIGIN, which is the last complete day — not
     the newest row. The newest row can be a day the sheet has not finished, and
     the forecast does not start from one. */
  document.getElementById('navDate').textContent = niceFull(from);
  const pend = pendingOf(list.slice(-3));
  const note = document.getElementById('pendNote');
  if (pend && pend.groups && pend.groups.length) {
    note.hidden = false; note.textContent = pendingLabel(list[list.length - 1]) || 'partly pending';
  } else note.hidden = true;

  /* One section failing must not take the rest of the page with it. */
  const safe = (name, fn) => { try { fn(); } catch (e) { console.error('forecast: ' + name + ' failed', e); } };
  if (S.view === 'map') {
    /* Everything but the KPI tiles reads the PRIMARY series, so the rails and
       the timeline describe whatever the lens is actually forecasting. */
    const pv = (ctx.pri && ctx.pri[S.scen]) || p;
    safe('kpis', () => renderKpis(p, ctx));
    safe('scenarios', () => renderScenarios(ctx));
    safe('chart', () => renderChart(pv, ctx));
    safe('timeline', () => renderTimeline(pv, ctx));
    safe('trends', () => renderTrends(pv, ctx));
    safe('profit', () => renderProfit(p, ctx));
  } else {
    safe('notes', () => renderNotes(p));
  }
  document.getElementById('footSource').textContent =
    'Forecast from ' + niceFull(p.from) + ' · 2026 book' + (PRIOR ? ' + 2025 book' : ' only') +
    ' · ' + (S.live === 'live' ? 'live' : 'snapshot');
}

const horizonOf = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);

/* The band is measured, not assumed, so it has to be computed — about half a
   second of walk-forward. Deferred past first paint so the board draws
   immediately and the band fills in behind it. */
/* Keyed by lens — and for countries by whether Shopify has answered yet — so
   returning to a lens does not re-walk the whole book. */
const btKey = () => { const L = lens(); return L.needs ? S.lens + ':' + extState(L.needs) : S.lens; };
const btTotal = () => (BTS.total && BTS.total !== 'failed') ? BTS.total : null;

/* One number goes in the cell, so it is the WORST series', named. An average
   would read as covering every series while describing none of them. */
function foldBt(per) {
  const out = { series: per, byName: {} };
  per.forEach(x => out.byName[x.name] = x.bt);
  [30, 90].forEach(h => {
    const got = per.map(x => ({ name: x.name, r: x.bt && x.bt[h] })).filter(x => x.r);
    if (!got.length) return;
    const errOf = r => r.mape != null ? r.mape : (r.coldStart ? r.coldStart.mape : -1);
    const worst = got.reduce((a, b) => errOf(b.r) > errOf(a.r) ? b : a);
    out[h] = worst.r;
    out['worst' + h] = { name: worst.name, only: got.length === 1 };
  });
  return out;
}

function measureLens(key) {
  if (BTS[key]) return;
  let res = 'failed';
  try {
    const L = key === 'total' ? LENSES.total : lens();
    const built = L.build(rows(), L.needs ? extData(L.needs) : null);
    if (built) res = foldBt(built.map(sr => ({
      name: sr.name,
      bt: F.backtest(sr.rows, { sparse: !!L.sparse, model: { scenario: 'realistic' } }),
    })));
  } catch (e) { res = 'failed'; }
  BTS[key] = res;
}

function measure() {
  const key = btKey();
  /* Already measured: adopt it and REPAINT. The caller renders before calling
     here, so returning without a repaint left the previous lens's error figures
     standing under the new one — Total wearing "worst: New Zealand". */
  if (BTS[key]) {
    const was = BT;
    BT = BTS[key] === 'failed' ? null : BTS[key];
    if (was !== BT) render();
    return;
  }
  BT = null;
  setTimeout(() => {
    measureLens('total');                  // the notes always describe revenue
    if (key !== 'total') measureLens(key);
    if (btKey() === key) BT = BTS[key] === 'failed' ? null : BTS[key];
    render();
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

/* Two views of one page, not a page and an overlay. Switching hides the map's
   three rows and gives the explanation the whole middle. */
function setView(v) {
  S.view = v;
  document.getElementById('stage').classList.toggle('view-explain', v === 'explain');
  document.getElementById('explain').hidden = v !== 'explain';
  document.querySelectorAll('#viewSeg button').forEach(x =>
    x.classList.toggle('active', x.dataset.view === v));
}

function wire() {
  document.querySelectorAll('#viewSeg button').forEach(bt => bt.onclick = () => {
    setView(bt.dataset.view); render();
  });

  document.querySelectorAll('#notesSeg button').forEach(bt => bt.onclick = () => {
    document.querySelectorAll('#notesSeg button').forEach(x => x.classList.remove('active'));
    bt.classList.add('active'); S.notesMode = bt.dataset.mode; render();
  });
  /* Escape returns to the map, since that is where the page starts. */
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (S.view !== 'map') { setView('map'); render(); }
  });
  document.querySelectorAll('#lensSeg button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#lensSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); S.lens = b.dataset.lens;
    render(); measure();
    if (lens().needs) ensureExt(lens().needs);
  });
  document.querySelectorAll('#horSeg button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#horSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); S.hor = b.dataset.hor === 'EOY' ? 'EOY' : parseInt(b.dataset.hor, 10); render();
  });
  window.addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(render, 200); });
  /* Coming back to the map means the canvas has just regained its height, so
     the chart has to be rebuilt against real dimensions. */
}

(function init() {
  if (!DATA || !F) { document.getElementById('errBox').classList.add('show'); return; }
  loadMods(); setLive('snap'); wire(); render();
  if (window.DLmotion) DLmotion.entrance();
  measure();
  tryLiveRefresh();
  setInterval(tryLiveRefresh, REFRESH_MINUTES * 60 * 1000);
})();
