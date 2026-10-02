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
/* Windows short enough to read one bar at a time. Four weeks is four weekly
   points — not a chart — and twenty-eight daily ones, which is. So the unit
   follows the window rather than being a control the reader has to find: short
   windows are drawn day by day, longer ones pool into weeks, and the header
   says which. */
const GRAN_DAY = new Set([4, 8]);
const granOf = win => GRAN_DAY.has(win) ? 'day' : 'week';
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
  const rows = [...map.values()]
    .filter(d => d && d.revenue > 0 && d.totalAds != null && !d.pending)
    .sort((a, b) => a.date < b.date ? -1 : 1);
  /* The half-entered tail. The sheet's last row carried $10,905 of revenue
     against $0 of ad spend while every neighbouring day ran about $5,000 — a
     cell nobody had typed into yet, not a day the account was paused, and the
     pending flag misses it because the cell holds a zero rather than a blank.

     On a 26-week window it moved MER by a hundredth. On a four-week window it
     moved it 2.7%, and as the rightmost point of a daily chart it would have
     read "$10.9K of revenue on no spend" — the single most misleading mark this
     page could carry. Trimmed off the end, the way Performance pulls a short
     window back off a pending day, and reported in the header rather than
     silently dropped. */
  let end = rows.length;
  while (end > 0 && !(+rows[end - 1].totalAds > 0)) end--;
  return { rows: rows.slice(0, end), tail: rows.slice(end) };
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
  const b = book(), all = b.rows;
  const cur = trimToWeeks(all, S.win);
  /* ALL already reaches the start of the book, so there is nothing before it to
     compare against — and whatever days are left over are not a period. */
  const prev = cur.length && S.win !== 'ALL'
    ? trimToWeeks(all.slice(0, all.length - cur.length), S.win) : [];
  const weeks = weeklyBuckets(cur);
  const gran = granOf(S.win);
  const link = DLspend.link(cur, weeks);
  return {
    rows: cur, weeks, tail: b.tail, gran,
    /* What one mark on the charts is. Every panel reads this rather than
       deciding for itself, so the scatter, the bars, the MER line and the bands
       can never be counting different things on the same screen. */
    units: gran === 'day' ? cur : DLspend.wholeWeeks(weeks),
    unit: gran, unitShort: gran === 'day' ? 'day' : 'wk',
    econ: DLspend.economics(cur),
    prevEcon: prev.length ? DLspend.economics(prev) : null,
    link,
    fit: gran === 'day' ? link.daily : link.weekly,
    profitFit: gran === 'day' ? link.profitDay : link.profit,
    elastic: gran === 'day' ? link.elasticDay : link.elastic,
    minElastic: gran === 'day' ? link.minElasticDays : link.minElastic,
    lags: DLspend.lagProfile(cur, 3),
    bands: DLspend.bands(gran === 'day' ? cur : weeks, gran),
    nWeeks: Math.round(cur.length / 7),
    periodLabel: S.win === 'ALL' ? 'vs nothing earlier' : `vs prior ${S.win}W`,
  };
}
/* One mark's label, in whichever unit the window is drawn in. */
const unitLabel = (c, x) => c.gran === 'day' ? isoToNice(x.date) : x.label.replace('w/c ', '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
/* "weekly" and "daily", because `${unit}ly` spells one of them "dayly". */
const ADVERB = { day: 'daily', week: 'weekly' };

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
  const c = book().rows.length ? ctx() : null;
  /* Fewer than seven complete days anywhere is not a short window, it is no
     window: every statistic on this page is measured over whole weeks. */
  if (!c || !c.rows.length) { document.getElementById('errBox').classList.add('show'); return; }
  renderHeader(c); renderKPIs(c); renderSeries(c); renderScatter(c); renderMer(c);
  renderBands(c); renderReadout(c); renderFooter(c);
  if (window.DLmotion) DLmotion.countUpAll();
}

function renderHeader(c) {
  const r = c.rows;
  /* A window drawn day by day is named in days. The button still says 4W, and
     28 days is the same thing — but the title has to agree with the marks on
     the charts under it, or the page looks like it is showing weeks. */
  document.getElementById('winLabel').textContent = c.gran === 'day'
    ? `LAST ${r.length} DAYS`
    : S.win === 'ALL' ? `ALL ${c.nWeeks} WEEKS` : `LAST ${c.nWeeks} WEEKS`;
  document.getElementById('winDates').textContent = r.length
    ? `${rangeLabel(r[0].date, r[r.length - 1].date)} · by ${c.unit}` : '—';
  const last = r.length ? r[r.length - 1].date : null;
  document.getElementById('throughVal').textContent = last ? isoToNice(last) + ' ' + last.slice(0, 4) : '—';
  /* Two things the reader would otherwise read as a fault: a window shorter than
     the one asked for (52W of a book holding 40 is 40), and the half-entered
     tail this page trims off the end. */
  const want = S.win === 'ALL' ? c.nWeeks : S.win;
  const notes = [];
  if (c.nWeeks < want) notes.push(`only ${c.nWeeks}W of history`);
  if (c.tail.length) notes.push(`${c.tail.map(d => isoToNice(d.date)).join(', ')}: no ad spend entered yet`);
  const pend = document.getElementById('throughPend');
  pend.textContent = notes.join(' · ');
  /* The chip is capped at 14cqw and ellipsises; the title is what makes the
     rest of it reachable rather than merely present. */
  pend.title = notes.join(' · ');
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
  const w = c.fit, el = c.elastic;
  const n = c.gran === 'day' ? L.days : L.weeks;
  /* An r over four points swings on any one of them. Shown with its n either
     way, and marked when the n is too small to lean on. */
  const thin = n < 12;
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
      `${ADVERB[c.unit]} · <b>${n}</b> ${c.unit}${n === 1 ? '' : 's'}${thin ? ' · thin' : ''}`,
      el ? `<span class="k-per">+1% spend → ${el.slope >= 0 ? '+' : ''}${el.slope.toFixed(2)}% revenue</span>`
         : `<span class="k-per">needs ${plural(c.minElastic, c.unit)} for an elasticity</span>`),
  ].join('');
}

/* ---- the two series, on one dollar axis ---- */
function renderSeries(c) {
  const w = c.units, e = c.econ;
  const labels = w.map(x => unitLabel(c, x));
  /* What each day or week had to sell to break even, at THIS window's cost
     structure. The gap between the revenue bar and this line is that period's
     profit, which is the whole page in one shape. */
  const beLine = e.beMer ? w.map(x => x.totalAds * e.beMer) : w.map(() => null);
  const ds = [
    { type: 'bar', label: 'Revenue', data: w.map(x => x.revenue), backgroundColor: C_REV + 'd9', borderRadius: 3, order: 3 },
    { type: 'bar', label: 'Ad spend', data: w.map(x => x.totalAds), backgroundColor: C_SPEND + 'd9', borderRadius: 3, order: 3 },
    { type: 'line', label: 'Revenue needed to break even', data: beLine, borderColor: C_BE, borderDash: [5, 4],
      borderWidth: 2, pointRadius: 0, tension: .25, order: 1 },
  ];
  document.getElementById('seriesNote').textContent =
    `${plural(w.length, c.unit)} · Meta is ${pct(e.metaShare, 1)} of this spend`;
  document.getElementById('seriesFoot').textContent =
    `one dollar axis · the dashed line is the revenue each ${c.unit} needed to break even`;
  const cfg = { data: { labels, datasets: ds }, options: {
    responsive: true, maintainAspectRatio: false, animation: { duration: 450 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, labels: { color: C_INK, boxWidth: 10, font: { size: 10 } } },
      tooltip: { callbacks: {
        label: i => i.dataset.label + ': ' + money(i.raw),
        afterBody: it => { const x = w[it[0].dataIndex]; if (!x) return '';
          const dow = c.gran === 'day' && x.dow ? x.dow + ' · ' : '';
          if (!x.totalAds) return dow + 'no ad spend recorded';
          return dow + 'MER ' + xm(x.revenue / x.totalAds) + ' · profit ' + money(x.profit); } } },
    },
    scales: {
      y: { beginAtZero: true, grid: { color: GRID }, ticks: { color: C_MUTE, font: { size: 9 }, callback: v => money(v) } },
      x: { grid: { display: false }, ticks: { color: C_MUTE, font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: c.gran === 'day' ? 8 : 10 } },
    } } };
  if (charts.series) charts.series.destroy();
  charts.series = new Chart(document.getElementById('seriesChart'), cfg);
}

/* ---- the scatter: one point per week ---- */
function renderScatter(c) {
  /* Only marks that carry spend: a point at x = 0 has nothing to say about ad
     response and drags the fit through the origin. */
  const w = DLspend.spending(c.units), e = c.econ, fit = c.fit;
  const pt = x => ({ x: x.totalAds, y: x.revenue, w: x });
  /* Profitable and loss-making marks are split into two datasets so the legend
     names them and the marker shape carries the same information the colour
     does — a circle and a triangle stay apart for a reader who cannot separate
     the green from the red. */
  const good = w.filter(x => x.profit >= 0).map(pt), bad = w.filter(x => x.profit < 0).map(pt);
  const U = c.unit;
  /* Anchoring both axes at zero spends most of the panel on empty quadrant: at
     four weeks every day sits between $4K and $7K of spend and the points
     bunched into one corner. The axes frame the data instead, and both
     reference lines are drawn across that frame rather than from the origin —
     a ray through (0,0) does not need the origin plotted to have its slope. */
  const xs = w.map(x => x.totalAds), lo = Math.min(...xs), hi = Math.max(...xs);
  const padX = (hi - lo) * 0.08 || Math.max(hi * 0.08, 1);
  const x0 = Math.max(0, lo - padX), x1 = hi + padX;
  const ds = [
    { label: `Profitable ${U}`, data: good, backgroundColor: C_GOOD + 'cc', borderColor: C_GOOD,
      pointStyle: 'circle', pointRadius: c.gran === 'day' ? 3.4 : 4.5, borderWidth: 1 },
    { label: `Loss-making ${U}`, data: bad, backgroundColor: C_BAD + 'cc', borderColor: C_BAD,
      pointStyle: 'triangle', pointRadius: c.gran === 'day' ? 4.6 : 6, borderWidth: 1 },
  ];
  if (e.beMer) ds.push({ label: 'Break-even ' + xm(e.beMer), data: [{ x: x0, y: x0 * e.beMer }, { x: x1, y: x1 * e.beMer }],
    showLine: true, borderColor: C_BE, borderDash: [5, 4], borderWidth: 2, pointRadius: 0, fill: false, pointStyle: 'line' });
  if (fit) ds.push({ label: 'Fitted trend', data: [{ x: x0, y: fit.intercept + fit.slope * x0 }, { x: x1, y: fit.intercept + fit.slope * x1 }],
    showLine: true, borderColor: C_INK, borderWidth: 2, pointRadius: 0, fill: false, pointStyle: 'line' });
  document.getElementById('scatterNote').textContent = `one point per ${U} · n = ${w.length}`;
  document.getElementById('scatterFoot').innerHTML = fit
    ? `r <b>${fit.r.toFixed(2)}</b> · R² ${fit.r2.toFixed(2)} · the trend adds <b>$${fit.slope.toFixed(2)}</b> of revenue per extra $1 of ${ADVERB[U]} spend`
    : `not enough ${U}s with spend to fit a trend`;
  const cfg = { type: 'scatter', data: { datasets: ds }, options: {
    responsive: true, maintainAspectRatio: false, animation: { duration: 450 },
    plugins: {
      legend: { display: true, labels: { color: C_INK, boxWidth: 10, usePointStyle: true, font: { size: 10 } } },
      tooltip: { callbacks: { label: i => {
        const x = i.raw && i.raw.w; if (!x) return money(i.parsed.x) + ' → ' + money(i.parsed.y);
        const nm = c.gran === 'day' ? `${unitLabel(c, x)}${x.dow ? ' (' + x.dow + ')' : ''}` : x.label;
        return `${nm}: spend ${money(x.totalAds)} → revenue ${money(x.revenue)} · MER ${xm(x.revenue / x.totalAds)} · profit ${money(x.profit)}`; } } },
    },
    scales: {
      x: { title: { display: true, text: `ad spend per ${U}`, color: C_MUTE, font: { size: 9 } },
        min: x0, max: x1, grid: { color: GRID }, ticks: { color: C_MUTE, font: { size: 9 }, maxTicksLimit: 7, callback: v => money(v) } },
      y: { title: { display: true, text: `revenue per ${U}`, color: C_MUTE, font: { size: 9 } },
        grid: { color: GRID }, ticks: { color: C_MUTE, font: { size: 9 }, maxTicksLimit: 7, callback: v => money(v) } },
    } } };
  if (charts.scatter) charts.scatter.destroy();
  charts.scatter = new Chart(document.getElementById('scatterChart'), cfg);
}

/* ---- MER against the two break-evens ---- */
function renderMer(c) {
  const w = c.units, e = c.econ;
  const labels = w.map(x => unitLabel(c, x));
  const mer = w.map(x => x.totalAds ? x.revenue / x.totalAds : null);
  const above = mer.filter(v => v != null && e.beMer != null && v >= e.beMer).length;
  const ds = [
    /* Spline tension invents peaks between points. Twenty-six weekly points can
       carry a little; twenty-eight daily ones swing hard enough that the curve
       would draw MERs no day actually recorded. */
    { label: 'MER', data: mer, borderColor: C_REV, borderWidth: c.gran === 'day' ? 2 : 2.5,
      pointRadius: c.gran === 'day' ? 1.8 : 0, tension: c.gran === 'day' ? 0 : .3, order: 1 },
    { label: 'Profit break-even', data: w.map(() => e.beMer), borderColor: C_GOOD, borderDash: [5, 3],
      borderWidth: 1.6, pointRadius: 0, order: 9 },
    { label: 'Cash break-even', data: w.map(() => e.beCashMer), borderColor: C_BE, borderDash: [5, 3],
      borderWidth: 1.6, pointRadius: 0, order: 9 },
  ];
  document.getElementById('merNote').textContent =
    `revenue ÷ ad spend, ${c.unit} by ${c.unit}`;
  const shown = mer.filter(v => v != null).length;
  document.getElementById('merFoot').innerHTML = e.beMer
    ? `<b>${above}</b> of ${plural(shown, c.unit)} cleared ${xm(e.beMer)} · below ${xm(e.beCashMer)} the spend does not even cover variable costs`
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
      x: { grid: { display: false }, ticks: { color: C_MUTE, font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: c.gran === 'day' ? 8 : 10 } },
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
    el.innerHTML = `<div class="rdrow empty"><div class="rd-b">Not enough ${c.unit}s.</div>
      <div class="rd-t">Sorting into bands needs at least <b>${DLspend.MIN_BAND_UNITS}</b> ${c.unit}s with spend; this window has ${c.units.length}.
      Choose a longer period.</div></div>`;
    foot.textContent = '';
    return;
  }
  const U = b.unit, Ushort = c.unitShort;
  note.textContent = `${plural(b.units, U)} sorted by spend, cut into ${b.q}`;
  const head = `<div class="thead"><div>Band</div><div class="num">${U === 'day' ? 'Days' : 'Wks'}</div><div class="num">Spend/${Ushort}</div>
    <div class="num">Revenue/${Ushort}</div><div class="num">MER</div><div class="num">Profit/${Ushort}</div><div class="num">Margin</div></div>`;
  el.innerHTML = head + b.bands.map(x => `<div class="trow">
      <div class="pname">${esc(x.name)}<i>${money(x.from)}–${money(x.to)}</i></div>
      <div class="num">${x.n}</div>
      <div class="num">${money(x.spendPer)}</div>
      <div class="num">${money(x.revenuePer)}</div>
      <div class="num ${c.econ.beMer != null && x.mer >= c.econ.beMer ? 'g-t' : 'b-t'}">${xm(x.mer)}</div>
      <div class="num ${x.profitPer >= 0 ? 'g-t' : 'b-t'}">${money(x.profitPer)}</div>
      <div class="num ${x.marginPct >= 0 ? 'g-t' : 'b-t'}">${pct(x.marginPct)}</div>
    </div>`).join('');
  /* The finding this table exists for, stated rather than left to be spotted —
     and immediately qualified, because the same weeks that carry the most spend
     are the weeks that carry the most demand. */
  const lo = b.bands[0], hi = b.bands[b.bands.length - 1];
  const merDown = hi.mer < lo.mer, marginUp = hi.marginPct > lo.marginPct;
  /* The confounder is not the same at the two scales, and naming the wrong one
     would be worse than naming none: across weeks it is the trading season,
     across days it is mostly which day of the week it is. */
  const caveat = U === 'day'
    ? 'High-spend days are also the days the business expects demand, and the day of the week moves spend and sales together: description, not a lever.'
    : 'High-spend weeks are also peak-demand weeks: description, not a lever.';
  foot.innerHTML = (merDown && marginUp
    ? `Spending more bought <b>less</b> efficiency (${xm(hi.mer)} vs ${xm(lo.mer)}) and <b>more</b> margin (${pct(hi.marginPct)} vs ${pct(lo.marginPct)}) — fixed costs spread. `
    : `Highest band ${xm(hi.mer)} MER and ${pct(hi.marginPct)} margin, against ${xm(lo.mer)} and ${pct(lo.marginPct)} in the lowest. `) + caveat;
}

/* ---- the right-hand panel: three ways of saying the same thing ---- */
const READ_TITLE = { read: 'What the numbers <span>say</span>', lag: 'Does it land <span>same day</span>?', econ: 'The break-even <span>build-up</span>' };
const READ_NOTE = { read: 'generated from this window', lag: 'revenue N days after the spend', econ: 'per dollar of gross revenue' };

function renderReadout(c) {
  document.querySelectorAll('#readSeg button').forEach(b => b.classList.toggle('active', b.dataset.view === S.view));
  document.getElementById('readTitle').innerHTML = READ_TITLE[S.view];
  document.getElementById('readNote').textContent = READ_NOTE[S.view];
  const built = S.view === 'lag' ? lagHtml(c) : S.view === 'econ' ? econHtml(c) : readHtml(c);
  document.getElementById('readout').innerHTML = built.body;
  document.getElementById('readFoot').innerHTML = built.foot || '';
}

const rdrow = (big, text, cls) => `<div class="rdrow ${cls || ''}"><div class="rd-b">${big}</div><div class="rd-t">${text}</div></div>`;

function readHtml(c) {
  const e = c.econ, L = c.link, out = [];
  const w = L.weekly, d = L.daily, el = c.elastic, U = c.unit;
  const n = U === 'day' ? L.days : L.weeks;

  /* The gap between the two r's is itself the finding, so both are stated
     whichever one the charts are drawn in — and the one being drawn leads. */
  if (w && d) {
    /* The weekly r over a four-week window is four points. Saying pooling
       "lifts" it would be asserting the general result over this window's own
       reading, so the direction is taken from the numbers and a weekly n too
       small to lean on says so instead. */
    const thinWeeks = L.weeks < 12;
    out.push(U === 'day'
      ? rdrow('r ' + d.r.toFixed(2),
          `Day by day, <b>${(d.r2 * 100).toFixed(0)}%</b> of the variation in a day’s revenue sits on the spend line — the rest is mostly which day of the week it is.
           ${thinWeeks ? `Pooled into weeks this window holds only ${plural(L.weeks, 'point')} — too few to compare; a longer one can.`
                       : `Pooled into whole weeks it reads <b>${w.r.toFixed(2)}</b>, on no new information.`}`)
      : rdrow('r ' + w.r.toFixed(2),
          `Week by week, spend and revenue move together — ${(w.r2 * 100).toFixed(0)}% of the variation in weekly revenue sits on the spend line.
           Day by day it is only <b>${d.r.toFixed(2)}</b>: most of a single day’s swing is which day it is, not what was spent.`));
  }
  if (el) {
    const dim = el.slope < 1;
    out.push(rdrow((el.slope >= 0 ? '+' : '') + el.slope.toFixed(2) + '%',
      `what a <b>1%</b> lift in ${ADVERB[U]} spend came with in revenue, over ${plural(n, U)}. ${dim
        ? 'Under 1% means diminishing returns — each extra dollar bought less than the one before it.'
        : 'Above 1% over this window, which is unusual and worth distrusting before acting on: ' + plural(n, U) + ' is a short read.'}${
        U === 'day' ? ' Measured on days, so day-of-week sits inside it.' : ''}`));
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
    out.push(rdrow(n + (U === 'day' ? 'D' : 'W'),
      `too few ${U}s with spend for an elasticity — it needs <b>${c.minElastic}</b>. Pick a longer period.`));
  }
  if (e.beMer != null) {
    const gap = e.mer - e.beMer, over = gap >= 0;
    out.push(rdrow(xm(e.mer),
      `blended MER against the <b>${xm(e.beMer)}</b> that covers variable and fixed costs — ${over ? 'above' : 'below'} it by
       <b class="${over ? 'g-t' : 'b-t'}">${Math.abs(gap).toFixed(2)}×</b>, and that distance is where the
       ${money(Math.abs(e.profit))} of ${over ? 'profit' : 'loss'} comes from.`));
  }
  const pf = c.profitFit;
  if (pf && c.fit) {
    out.push(rdrow('r ' + pf.r.toFixed(2),
      `how tightly <b>profit</b> follows spend ${U} by ${U}, against ${c.fit.r.toFixed(2)} for revenue. Revenue answers to spend far more readily than profit does —
       everything between the two is cost structure, and that is a ${pf.r >= 0.6 ? 'strong' : pf.r >= 0.3 ? 'loose' : 'weak'} link at this window.`));
  }
  /* The trimmed tail is stated in the header too, but the read-out is where
     someone wondering why the newest day is missing will actually look. As a
     footnote rather than a sixth statement, so it cannot push one off the end. */
  return { body: out.join(''), foot: c.tail.length
    ? `Left out: <b>${c.tail.map(x => isoToNice(x.date)).join(', ')}</b> — revenue, but no ad spend typed in yet.`
    : 'Every figure here is measured over this window only.' };
}

function lagHtml(c) {
  const lags = c.lags.filter(x => x.r != null);
  if (!lags.length) return { body: rdrow('—', 'not enough days to test a lag.'), foot: '' };
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
  return { body: `<div class="momlist">${rows}</div>`, foot: note };
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
  return { body: `<div class="elist">${out.join('')}</div>`,
    foot: 'Rates are this window’s own, not a budget. Profit ties to the sheet: revenue ex GST less variable, advertising and fixed costs.' };
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
