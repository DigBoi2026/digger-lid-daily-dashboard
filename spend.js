/* =========================================================================
   DiggerLid — Meta Spend vs Revenue.

   The board already shows spend (Performance), the ad account (Meta Ads) and
   the margin ladder (GPAM). What none of them answers is the question the
   spend decision actually turns on: how tightly are spend, revenue, MER and
   profit tied to each other, and does the next dollar clear the bar?

   This page answers that one question four ways — the two series side by side,
   the week-by-week link, MER against the break-even the P&L implies, and the
   same weeks sorted by how much was spent in them.

   Two things it refuses to do:

     · plot a dollar series against a ratio on two axes. A dual axis lets the
       author slide one series up or down against the other until the story
       looks right; spend and revenue share ONE dollar axis here, and MER gets
       a chart of its own.

     · call a correlation a lever. Every number on this page comes from weeks
       the business actually ran, in which spend and demand both rose into
       peak. The copy says so, in the panel notes and the footer, rather than
       in a disclaimer nobody reads.

   Math lives in lib/spend.js (pure, unit-tested by source/test_spend.js).
   ========================================================================= */
const { isoToNice, fmtRange, weeklyBuckets } = DLcore;
/* fmtRange drops the year, which reads fine for a 13-week window and lies for
   ALL: "3 Jan – 8 Sep" over a span that starts in 2025 and ends in 2026. */
const rangeLabel = (a, b) => a.slice(0, 4) === b.slice(0, 4) ? fmtRange(a, b)
  : `${isoToNice(a)} ${a.slice(2, 4)} – ${isoToNice(b)} ${b.slice(2, 4)}`;
const money = (n, c = true) => DLcore.money(n, c);
const pct = (n, d = 1) => DLcore.pct(n, d);
const numf = n => DLcore.numf(n);
const esc = s => DLcore.esc(s);
const xm = n => n == null || isNaN(n) ? '—' : n.toFixed(2) + '×';

const S = { win: 26, view: 'read', live: 'snap' };
const API_URL = '/api/data';
const REFRESH_MINUTES = 30;
let DATA = window.DL_DATA || null;
const PRIOR = window.DL_PRIOR || null;
let charts = { series: null, scatter: null, mer: null };

/* The two-series palette.

   Revenue keeps the brand yellow it carries on every other page — changing it
   here to satisfy a lightness band would cost more in cross-page consistency
   than it buys. Spend is #5ec8ff, checked against it on this panel background:
   ΔE 31.3 normal vision, 28.3 under protanopia, both far above the 8-point
   separation target. Both run bright for the dark-mode band by design, which is
   the board's house style, so every chart that uses the pair also carries a
   legend and the series are labelled in the tooltip — colour is never the only
   thing telling them apart. */
const C_REV = '#f5eb19', C_SPEND = '#5ec8ff', C_BE = '#ff8a4a',
      C_GOOD = '#39d98a', C_BAD = '#ff5a52', C_MUTE = '#9a9193', C_INK = '#c9c1c2';
const GRID = 'rgba(255,255,255,.05)';

/* ---------------------------------------------------------------- data ---

   One book: the 2025 file and the live 2026 rows merged by date, newest wins.
   The link is measured over whole weeks, and 52 of them reach back past the
   turn of the year, so a page that read only data.js could not offer its own
   longest window. */
function book() {
  const map = new Map();
  ((PRIOR && PRIOR.daily) || []).forEach(d => { if (d && d.date) map.set(d.date, d); });
  ((DATA && DATA.daily) || []).forEach(d => { if (d && d.date) map.set(d.date, d); });
  /* A day still waiting on its ad spend enters the fit as a day that sold well
     on nothing, which is exactly the shape of a strong correlation. Dropped
     rather than zero-filled. */
  return [...map.values()]
    .filter(d => d && d.revenue > 0 && d.totalAds != null && !d.pending)
    .sort((a, b) => a.date < b.date ? -1 : 1);
}

/* Trim to whole weeks from the NEWEST day backwards.

   core.weeklyBuckets chunks forward from the first day, so a window whose
   length is not a multiple of seven leaves its stub at the END — the freshest
   days, the ones most worth seeing. Cutting the odd days off the front instead
   puts the stub where nobody misses it and keeps every bucket a real week. */
function trimToWeeks(rows, weeks) {
  const want = weeks === 'ALL' ? Math.floor(rows.length / 7) : weeks;
  const n = Math.min(want, Math.floor(rows.length / 7)) * 7;
  /* Under one whole week there is no window, and handing back the stub is how
     the ALL comparison ended up measuring 525 weeks against the two leftover
     days and reporting revenue up 53,720%. */
  return n > 0 ? rows.slice(rows.length - n) : [];
}

function ctx() {
  const all = book();
  const cur = trimToWeeks(all, S.win);
  /* ALL already reaches the start of the book, so there is nothing before it to
     compare against — and whatever days are left over are not a period. */
  const prev = cur.length && S.win !== 'ALL'
    ? trimToWeeks(all.slice(0, all.length - cur.length), S.win) : [];
  const weeks = weeklyBuckets(cur);
  const econ = DLspend.economics(cur);
  return {
    rows: cur, weeks, econ,
    prevEcon: prev.length ? DLspend.economics(prev) : null,
    link: DLspend.link(cur, weeks),
    lags: DLspend.lagProfile(cur, 3),
    bands: DLspend.bands(weeks),
    nWeeks: Math.round(cur.length / 7),
    periodLabel: S.win === 'ALL' ? 'vs nothing earlier' : `vs prior ${S.win}W`,
  };
}

/* ------------------------------------------------------------- rendering */
/* Spending more is not, on its own, better or worse — it is the decision this
   page exists to inform. Painting it green would answer the question in the
   KPI strip before the reader has reached the charts. */
const BETTER = { meta: 'neutral', revenue: 'high', mer: 'high', adPct: 'low', profit: 'high' };
function deltaEl(cur, prev, key) {
  if (cur == null || prev == null || !prev) return '<span class="delta flat">—</span>';
  const chg = (cur - prev) / Math.abs(prev) * 100, dir = BETTER[key] || 'high';
  const cls = Math.abs(chg) < 0.05 || dir === 'neutral' ? 'flat'
    : (dir === 'high' ? chg > 0 : chg < 0) ? 'up' : 'down';
  const ar = chg > 0.05 ? '▲' : chg < -0.05 ? '▼' : '—';
  return `<span class="delta ${cls}">${ar} ${Math.abs(chg).toFixed(1)}%</span>`;
}

function render() {
  const rows = book();
  const c = rows.length ? ctx() : null;
  /* Fewer than seven complete days anywhere is not a short window, it is no
     window: every statistic on this page is measured over whole weeks. */
  if (!c || !c.rows.length) { document.getElementById('errBox').classList.add('show'); return; }
  renderHeader(c); renderKPIs(c); renderSeries(c); renderScatter(c); renderMer(c);
  renderBands(c); renderReadout(c); renderFooter(c);
  if (window.DLmotion) DLmotion.countUpAll();
}

function renderHeader(c) {
  const r = c.rows;
  document.getElementById('winLabel').textContent =
    S.win === 'ALL' ? `ALL ${c.nWeeks} WEEKS` : `LAST ${c.nWeeks} WEEKS`;
  document.getElementById('winDates').textContent = r.length ? rangeLabel(r[0].date, r[r.length - 1].date) : '—';
  const last = r.length ? r[r.length - 1].date : null;
  document.getElementById('throughVal').textContent = last ? isoToNice(last) + ' ' + last.slice(0, 4) : '—';
  /* The window asked for and the window drawn are not always the same: 52W of a
     book that only holds 40 is 40, and saying nothing would make the shortfall
     look like a data error. */
  const want = S.win === 'ALL' ? c.nWeeks : S.win;
  const pend = document.getElementById('throughPend');
  pend.textContent = c.nWeeks < want ? `only ${c.nWeeks}W of history` : '';
}

function kpiTile(lbl, val, sub, foot, cls) {
  return `<div class="kpi ${cls || ''}"><div class="k-head"><div class="k-lbl">${lbl}</div>
    <div class="k-val">${val}</div><div class="k-sub">${sub || ''}</div></div>
    <div class="k-foot">${foot || ''}</div></div>`;
}
function renderKPIs(c) {
  const e = c.econ, p = c.prevEcon, L = c.link;
  const per = `<span class="k-per">${c.periodLabel}</span>`;
  const foot = (a, b, k) => deltaEl(a, b, k) + per;
  const w = L.weekly;
  /* An r over four weeks is four points and swings on any one of them. Shown
     with its n either way, and marked when the n is too small to lean on. */
  const thin = L.weeks < DLspend.MIN_ELASTIC;
  const el = L.elastic;
  document.getElementById('kpis').innerHTML = [
    kpiTile('Meta Spend', money(e.meta),
      `<b>${pct(e.metaShare, 1)}</b> of all ad spend · ${money(e.ads)}`,
      foot(e.meta, p && p.meta, 'meta'), 'accent'),
    kpiTile('Revenue', money(e.revenue),
      `ex GST <b>${money(e.exGst)}</b>`, foot(e.revenue, p && p.revenue, 'revenue')),
    kpiTile('MER', xm(e.mer),
      `break-even <b class="${e.zone}-t">${xm(e.beMer)}</b>`,
      foot(e.mer, p && p.mer, 'mer'), e.zone === 'g' ? 'good' : e.zone === 'a' ? 'warn' : 'bad'),
    kpiTile('Ad Cost Ratio', pct(e.adPct),
      'the sheet’s “MER” column', foot(e.adPct, p && p.adPct, 'adPct')),
    kpiTile('Profit', money(e.profit),
      `<b>${pct(e.profitPct)}</b> of revenue`, foot(e.profit, p && p.profit, 'profit')),
    kpiTile('Spend ↔ Revenue', w ? 'r ' + w.r.toFixed(2) : '—',
      `weekly · <b>${L.weeks}</b> week${L.weeks === 1 ? '' : 's'}${thin ? ' · thin' : ''}`,
      el ? `<span class="k-per">+1% spend → ${el.slope >= 0 ? '+' : ''}${el.slope.toFixed(2)}% revenue</span>`
         : `<span class="k-per">needs ${DLspend.MIN_ELASTIC} weeks for an elasticity</span>`),
  ].join('');
}

/* ---- the two series, on one dollar axis ---- */
function renderSeries(c) {
  const w = DLspend.wholeWeeks(c.weeks), e = c.econ;
  const labels = w.map(x => x.label.replace('w/c ', ''));
  /* What each week had to sell to break even, at THIS window's cost structure.
     The gap between the revenue bar and this line is the week's profit, which
     is the whole page in one shape. */
  const beLine = e.beMer ? w.map(x => x.totalAds * e.beMer) : w.map(() => null);
  const ds = [
    { type: 'bar', label: 'Revenue', data: w.map(x => x.revenue), backgroundColor: C_REV + 'd9', borderRadius: 3, order: 3 },
    { type: 'bar', label: 'Ad spend', data: w.map(x => x.totalAds), backgroundColor: C_SPEND + 'd9', borderRadius: 3, order: 3 },
    { type: 'line', label: 'Revenue needed to break even', data: beLine, borderColor: C_BE, borderDash: [5, 4],
      borderWidth: 2, pointRadius: 0, tension: .25, order: 1 },
  ];
  document.getElementById('seriesNote').textContent =
    `${w.length} week${w.length === 1 ? '' : 's'} · Meta is ${pct(e.metaShare, 1)} of this spend`;
  const cfg = { data: { labels, datasets: ds }, options: {
    responsive: true, maintainAspectRatio: false, animation: { duration: 450 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, labels: { color: C_INK, boxWidth: 10, font: { size: 10 } } },
      tooltip: { callbacks: {
        label: i => i.dataset.label + ': ' + money(i.raw),
        afterBody: it => { const x = w[it[0].dataIndex]; if (!x || !x.totalAds) return ''; 
          return 'MER ' + xm(x.revenue / x.totalAds) + ' · profit ' + money(x.profit); } } },
    },
    scales: {
      y: { beginAtZero: true, grid: { color: GRID }, ticks: { color: C_MUTE, font: { size: 9 }, callback: v => money(v) } },
      x: { grid: { display: false }, ticks: { color: C_MUTE, font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
    } } };
  if (charts.series) charts.series.destroy();
  charts.series = new Chart(document.getElementById('seriesChart'), cfg);
}

/* ---- the scatter: one point per week ---- */
function renderScatter(c) {
  const w = DLspend.wholeWeeks(c.weeks), e = c.econ, fit = c.link.weekly;
  const pt = x => ({ x: x.totalAds, y: x.revenue, w: x });
  /* Profitable and loss-making weeks are split into two datasets so the legend
     names them and the marker shape carries the same information the colour
     does — a circle and a triangle stay apart for a reader who cannot separate
     the green from the red. */
  const good = w.filter(x => x.profit >= 0).map(pt), bad = w.filter(x => x.profit < 0).map(pt);
  const xs = w.map(x => x.totalAds), lo = Math.min(...xs), hi = Math.max(...xs);
  const ds = [
    { label: 'Profitable week', data: good, backgroundColor: C_GOOD + 'cc', borderColor: C_GOOD,
      pointStyle: 'circle', pointRadius: 4.5, borderWidth: 1 },
    { label: 'Loss-making week', data: bad, backgroundColor: C_BAD + 'cc', borderColor: C_BAD,
      pointStyle: 'triangle', pointRadius: 6, borderWidth: 1 },
  ];
  if (e.beMer) ds.push({ label: 'Break-even ' + xm(e.beMer), data: [{ x: 0, y: 0 }, { x: hi, y: hi * e.beMer }],
    showLine: true, borderColor: C_BE, borderDash: [5, 4], borderWidth: 2, pointRadius: 0, fill: false, pointStyle: 'line' });
  if (fit) ds.push({ label: 'Fitted trend', data: [{ x: lo, y: fit.intercept + fit.slope * lo }, { x: hi, y: fit.intercept + fit.slope * hi }],
    showLine: true, borderColor: C_INK, borderWidth: 2, pointRadius: 0, fill: false, pointStyle: 'line' });
  document.getElementById('scatterNote').textContent = `one point per week · n = ${w.length}`;
  document.getElementById('scatterFoot').innerHTML = fit
    ? `r <b>${fit.r.toFixed(2)}</b> · R² ${fit.r2.toFixed(2)} · the trend adds <b>$${fit.slope.toFixed(2)}</b> of revenue per extra $1 of weekly spend`
    : 'not enough whole weeks to fit a trend';
  const cfg = { type: 'scatter', data: { datasets: ds }, options: {
    responsive: true, maintainAspectRatio: false, animation: { duration: 450 },
    plugins: {
      legend: { display: true, labels: { color: C_INK, boxWidth: 10, usePointStyle: true, font: { size: 10 } } },
      tooltip: { callbacks: { label: i => {
        const x = i.raw && i.raw.w; if (!x) return money(i.parsed.x) + ' → ' + money(i.parsed.y);
        return `${x.label}: spend ${money(x.totalAds)} → revenue ${money(x.revenue)} · MER ${xm(x.revenue / x.totalAds)} · profit ${money(x.profit)}`; } } },
    },
    scales: {
      x: { title: { display: true, text: 'ad spend per week', color: C_MUTE, font: { size: 9 } },
        beginAtZero: true, grid: { color: GRID }, ticks: { color: C_MUTE, font: { size: 9 }, callback: v => money(v) } },
      y: { title: { display: true, text: 'revenue per week', color: C_MUTE, font: { size: 9 } },
        beginAtZero: true, grid: { color: GRID }, ticks: { color: C_MUTE, font: { size: 9 }, callback: v => money(v) } },
    } } };
  if (charts.scatter) charts.scatter.destroy();
  charts.scatter = new Chart(document.getElementById('scatterChart'), cfg);
}

/* ---- MER against the two break-evens ---- */
function renderMer(c) {
  const w = DLspend.wholeWeeks(c.weeks), e = c.econ;
  const labels = w.map(x => x.label.replace('w/c ', ''));
  const mer = w.map(x => x.totalAds ? x.revenue / x.totalAds : null);
  const above = mer.filter(v => v != null && e.beMer != null && v >= e.beMer).length;
  const ds = [
    { label: 'MER', data: mer, borderColor: C_REV, borderWidth: 2.5, pointRadius: 0, tension: .3, order: 1 },
    { label: 'Profit break-even', data: w.map(() => e.beMer), borderColor: C_GOOD, borderDash: [5, 3],
      borderWidth: 1.6, pointRadius: 0, order: 9 },
    { label: 'Cash break-even', data: w.map(() => e.beCashMer), borderColor: C_BE, borderDash: [5, 3],
      borderWidth: 1.6, pointRadius: 0, order: 9 },
  ];
  document.getElementById('merNote').textContent = 'revenue ÷ ad spend, week by week';
  document.getElementById('merFoot').innerHTML = e.beMer
    ? `<b>${above}</b> of ${mer.length} weeks cleared ${xm(e.beMer)} · below ${xm(e.beCashMer)} the spend does not even cover variable costs`
    : 'variable costs exceed ex-GST revenue in this window — no MER breaks even';
  const cfg = { type: 'line', data: { labels, datasets: ds }, options: {
    responsive: true, maintainAspectRatio: false, animation: { duration: 450 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, labels: { color: C_INK, boxWidth: 10, font: { size: 10 } } },
      tooltip: { callbacks: { label: i => i.dataset.label + ': ' + xm(i.raw) } },
    },
    scales: {
      y: { beginAtZero: true, grid: { color: GRID }, ticks: { color: C_MUTE, font: { size: 9 }, callback: v => v + '×' } },
      x: { grid: { display: false }, ticks: { color: C_MUTE, font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
    } } };
  if (charts.mer) charts.mer.destroy();
  charts.mer = new Chart(document.getElementById('merChart'), cfg);
}

/* ---- the same weeks, sorted by what was spent in them ---- */
function renderBands(c) {
  const el = document.getElementById('bands'), b = c.bands;
  const note = document.getElementById('bandNote'), foot = document.getElementById('bandFoot');
  if (!b) {
    note.textContent = '—';
    el.innerHTML = `<div class="rdrow empty"><div class="rd-b">Not enough weeks.</div>
      <div class="rd-t">Sorting into bands needs at least ${DLspend.MIN_BAND_WEEKS} whole weeks; this window has ${DLspend.wholeWeeks(c.weeks).length}.
      Choose a longer period.</div></div>`;
    foot.textContent = '';
    return;
  }
  note.textContent = `${b.weeks} weeks sorted by spend, cut into ${b.q}`;
  const head = `<div class="thead"><div>Band</div><div class="num">Wks</div><div class="num">Spend/wk</div>
    <div class="num">Revenue/wk</div><div class="num">MER</div><div class="num">Profit/wk</div><div class="num">Margin</div></div>`;
  el.innerHTML = head + b.bands.map(x => `<div class="trow">
      <div class="pname">${esc(x.name)}<i>${money(x.from)}–${money(x.to)}</i></div>
      <div class="num">${x.n}</div>
      <div class="num">${money(x.spendPerWeek)}</div>
      <div class="num">${money(x.revenuePerWeek)}</div>
      <div class="num ${c.econ.beMer != null && x.mer >= c.econ.beMer ? 'g-t' : 'b-t'}">${xm(x.mer)}</div>
      <div class="num ${x.profitPerWeek >= 0 ? 'g-t' : 'b-t'}">${money(x.profitPerWeek)}</div>
      <div class="num ${x.marginPct >= 0 ? 'g-t' : 'b-t'}">${pct(x.marginPct)}</div>
    </div>`).join('');
  /* The finding this table exists for, stated rather than left to be spotted —
     and immediately qualified, because the same weeks that carry the most spend
     are the weeks that carry the most demand. */
  const lo = b.bands[0], hi = b.bands[b.bands.length - 1];
  const merDown = hi.mer < lo.mer, marginUp = hi.marginPct > lo.marginPct;
  foot.innerHTML = merDown && marginUp
    ? `Spending more bought <b>less</b> efficiency (${xm(hi.mer)} vs ${xm(lo.mer)}) and <b>more</b> margin (${pct(hi.marginPct)} vs ${pct(lo.marginPct)}) — fixed costs spread. High-spend weeks are also peak-demand weeks: description, not a lever.`
    : `Highest band ${xm(hi.mer)} MER and ${pct(hi.marginPct)} margin, against ${xm(lo.mer)} and ${pct(lo.marginPct)} in the lowest. High-spend weeks are also peak-demand weeks: description, not a lever.`;
}

/* ---- the right-hand panel: three ways of saying the same thing ---- */
const READ_TITLE = { read: 'What the numbers <span>say</span>', lag: 'Does it land <span>same day</span>?', econ: 'The break-even <span>build-up</span>' };
const READ_NOTE = { read: 'generated from this window', lag: 'revenue N days after the spend', econ: 'per dollar of gross revenue' };

function renderReadout(c) {
  document.querySelectorAll('#readSeg button').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));
  document.getElementById('readTitle').innerHTML = READ_TITLE[S.view];
  document.getElementById('readNote').textContent = READ_NOTE[S.view];
  const el = document.getElementById('readout');
  el.innerHTML = S.view === 'lag' ? lagHtml(c) : S.view === 'econ' ? econHtml(c) : readHtml(c);
}

const rdrow = (big, text, cls) => `<div class="rdrow ${cls || ''}"><div class="rd-b">${big}</div><div class="rd-t">${text}</div></div>`;

function readHtml(c) {
  const e = c.econ, L = c.link, out = [];
  const w = L.weekly, d = L.daily, el = L.elastic;

  if (w && d) {
    out.push(rdrow('r ' + w.r.toFixed(2),
      `Week by week, spend and revenue move together — ${(w.r2 * 100).toFixed(0)}% of the variation in weekly revenue sits on the spend line.
       Day by day it is only <b>${d.r.toFixed(2)}</b>: most of a single day’s swing is which day it is, not what was spent.`));
  }
  if (el) {
    const dim = el.slope < 1;
    out.push(rdrow((el.slope >= 0 ? '+' : '') + el.slope.toFixed(2) + '%',
      `what a <b>1%</b> lift in weekly spend came with in revenue. ${dim
        ? 'Under 1% means diminishing returns — each extra dollar bought less than the one before it.'
        : 'Above 1% over this window, which is unusual and worth distrusting before acting on: ' + L.weeks + ' weeks is a short read.'}`));
    /* Elasticity times the blended MER is what the NEXT dollar is estimated to
       return, which is the number the spend decision needs — and it belongs
       against the CASH break-even, because fixed costs do not move when spend
       does. */
    const marg = e.mer != null ? el.slope * e.mer : null;
    if (marg != null && e.beCashMer != null) {
      const clears = marg >= e.beCashMer;
      out.push(rdrow(xm(marg),
        `the marginal dollar’s estimated return (elasticity × blended MER of ${xm(e.mer)}), against a cash break-even of
         <b class="${clears ? 'g-t' : 'b-t'}">${xm(e.beCashMer)}</b>. ${clears
          ? 'Still above water at the margin.' : 'The next dollar does not cover its own variable costs.'}
         Observational — only a spend test can settle it.`));
    }
  } else {
    out.push(rdrow(L.weeks + 'W', `too few whole weeks for an elasticity — it needs <b>${DLspend.MIN_ELASTIC}</b>. Pick a longer period.`));
  }
  if (e.beMer != null) {
    const gap = e.mer - e.beMer, over = gap >= 0;
    out.push(rdrow(xm(e.mer),
      `blended MER against the <b>${xm(e.beMer)}</b> that covers variable and fixed costs — ${over ? 'above' : 'below'} it by
       <b class="${over ? 'g-t' : 'b-t'}">${Math.abs(gap).toFixed(2)}×</b>, and that distance is where the
       ${money(Math.abs(e.profit))} of ${over ? 'profit' : 'loss'} comes from.`));
  }
  if (L.profit && w) {
    out.push(rdrow('r ' + L.profit.r.toFixed(2),
      `how tightly <b>profit</b> follows spend, against ${w.r.toFixed(2)} for revenue. Revenue answers to spend far more readily than profit does —
       everything between the two is cost structure, and that is a ${L.profit.r >= 0.6 ? 'strong' : L.profit.r >= 0.3 ? 'loose' : 'weak'} link at this window.`));
  }
  return out.join('');
}

function lagHtml(c) {
  const lags = c.lags.filter(x => x.r != null);
  if (!lags.length) return rdrow('—', 'not enough days to test a lag.');
  const max = Math.max(...lags.map(x => Math.abs(x.r)), 0.01);
  const rows = lags.map(x => {
    const wpc = Math.max(Math.abs(x.r) / max * 100, 2);
    return `<div class="momrow ${x.lag === 0 ? 'up' : ''}">
      <div class="mom-n">${x.lag === 0 ? 'Same day' : '+' + x.lag + ' day' + (x.lag === 1 ? '' : 's')}<i>n = ${x.n}</i></div>
      <div class="mom-t"><i style="left:0;width:${wpc}%"></i></div>
      <div class="mom-v">${x.r.toFixed(3)}<small>correlation</small></div>
    </div>`;
  }).join('');
  const best = lags.reduce((a, b) => Math.abs(b.r) > Math.abs(a.r) ? b : a);
  const note = best.lag === 0
    ? `Strongest on the <b>same day</b>, then decaying. Nothing is waiting a day to arrive, so a same-day MER — which is what every MER on this board is — is measuring the right pair.`
    : `Strongest at <b>+${best.lag} day${best.lag === 1 ? '' : 's'}</b>, not the same day. Every same-day MER on this board would be pairing spend with the wrong revenue, which is worth chasing down.`;
  return `<div class="momlist">${rows}</div><div class="p-note chartfoot">${note}</div>`;
}

function econHtml(c) {
  const e = c.econ;
  const line = (l, v, s, cls) => `<div class="erow ${cls || ''}"><div class="e-l">${l}</div>
    <div class="e-v">${v}</div><div class="e-s">${s || ''}</div></div>`;
  const out = [
    line('Gross revenue', pct(100, 0), money(e.revenue)),
    line('less GST', '−' + pct(e.gstPct), money(e.revenue - e.exGst)),
    line('less variable costs', '−' + pct(e.vcPct), 'product, freight, 3PL, fees'),
    line('Contribution', pct(e.contributionPct), money(e.contribution), 'sub'),
    line('less fixed costs', '−' + pct(e.fcPct), money(e.fc)),
    line('Ad spend that breaks even', pct(e.beAdPct), money(e.contribution - e.fc), 'tot'),
  ];
  out.push(line('Break-even MER', xm(e.beMer), 'profit exactly zero', 'tot'));
  out.push(line('Cash break-even MER', xm(e.beCashMer), 'the next dollar’s floor'));
  out.push(line('Actual MER', xm(e.mer), DLspend.ZONE_SIGNAL[e.zone], e.zone === 'g' ? 'good' : e.zone === 'a' ? 'warn' : 'bad'));
  /* Headroom in dollars is, identically, the period's profit — spend rises, a
     dollar of profit goes, and at the profit's last dollar it is zero. Stating
     it as a share of current spend is the part that is not already on the KPI
     strip. */
  out.push(line('Room to spend more', (e.ads ? (e.headroom / e.ads >= 0 ? '+' : '') + pct(e.headroom / e.ads * 100, 0) : '—'),
    `${money(e.headroom)} — revenue held still`));
  return `<div class="elist">${out.join('')}</div>
    <div class="p-note chartfoot">Rates are this window’s own, not a budget. Profit ties to the sheet: revenue ex GST less variable, advertising and fixed costs.</div>`;
}

function renderFooter(c) {
  const src = (DATA && DATA.meta && DATA.meta.source) || 'P&L workbook';
  document.getElementById('footSource').innerHTML =
    `Source: ${esc(src)} · <b>${esc((DATA && DATA.meta && DATA.meta.currency) || 'AUD')}</b> · ${c.rows.length} days, ${DLspend.wholeWeeks(c.weeks).length} whole weeks`;
}

/* ---- live / wiring / init ---- */
function setLive(mode) {
  S.live = mode;
  const dot = document.getElementById('liveDot'), txt = document.getElementById('liveText');
  if (!dot || !txt) return;
  dot.className = 'dot ' + (mode === 'live' ? 'live' : mode === 'loading' ? 'loading' : 'snap');
  txt.textContent = mode === 'live' ? 'Live' : mode === 'loading' ? 'Syncing…' : 'Snapshot';
}
function wire() {
  document.querySelectorAll('#winSeg button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#winSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const v = b.dataset.win;
    S.win = v === 'ALL' ? 'ALL' : parseInt(v, 10);
    render();
  });
  document.querySelectorAll('#readSeg button').forEach(b => b.onclick = () => {
    S.view = b.dataset.view; renderReadout(ctx());
  });
  window.addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(render, 200); });
}
/* Same merge-not-replace upgrade every page does: /api/data carries only the
   recent months, and replacing the book outright would cut 52W and ALL off at
   the knees. */
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
    setLive('live'); render();
  } catch (e) {
    setLive('snap');
  }
}

(function init() {
  if (!DATA || !DATA.daily) { document.getElementById('errBox').classList.add('show'); return; }
  setLive('snap'); wire(); render();
  if (window.DLmotion) DLmotion.entrance();
  tryLiveRefresh();
  setInterval(tryLiveRefresh, REFRESH_MINUTES * 60 * 1000);
})();
