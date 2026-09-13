/* =========================================================================
   DiggerLid — GPAM page. Gross Profit After Marketing: the bonus base.

   The maths lives in lib/gpam.js (unit-tested). This file is the page: pick
   the period, sum the two books, draw the waterfall, the FY months, the
   formulation and the bridge. Everything below the line is shown once, greyed,
   so nobody mistakes GPAM for profit — and profit ties to the sheet.
   ========================================================================= */
const { MONTH_ABBR, isoToNice, pendingOf, pendingLabel } = DLcore;
const G = window.DLgpam;
const F = window.DLforecast || null;
const API_URL = '/api/data';
const REFRESH_MINUTES = 30;

/* Declared marketing overhead per day, for a sheet that has no consultants /
   creative line yet. $0 until the business says otherwise; the page states it. */
const OVERHEAD_PER_DAY = 0;

const S = { win: 'MTD', live: 'snap' };
let DATA = window.DL_DATA || null;
const PRIOR = window.DL_PRIOR || null;
let CHART = null;

/* ---- formatters ---- */
const money = (n, c) => { if (n == null || isNaN(n)) return '—'; const a = Math.abs(n), s = n < 0 ? '-$' : '$';
  if (c === false) return s + Math.round(a).toLocaleString('en-AU');
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return s + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K'; return s + Math.round(a); };
const pct = (n, d = 1) => n == null || isNaN(n) ? '—' : n.toFixed(d) + '%';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nice = iso => isoToNice(iso);
const niceY = iso => isoToNice(iso) + ' ' + iso.slice(0, 4);
const deltaEl = (cur, prev, good = 'high') => {
  if (cur == null || prev == null || !prev) return '<span class="delta flat">—</span>';
  const chg = (cur - prev) / Math.abs(prev) * 100, up = chg > 0.05, down = chg < -0.05;
  const cls = !up && !down ? 'flat' : (good === 'high' ? up : down) ? 'up' : 'down';
  return `<span class="delta ${cls}">${up ? '▲' : down ? '▼' : '—'} ${Math.abs(chg).toFixed(0)}%</span>`;
};
const yesterdayISO = () => { const t = new Date(); t.setDate(t.getDate() - 1); t.setHours(0, 0, 0, 0); return t.toISOString().slice(0, 10); };

/* ---- data ---- */
function rows() {
  const map = new Map();
  ((PRIOR && PRIOR.daily) || []).forEach(d => { if (d && d.date) map.set(d.date, d); });
  ((DATA && DATA.daily) || []).forEach(d => { if (d && d.date) map.set(d.date, d); });
  return [...map.values()].filter(d => d.revenue > 0).sort((a, b) => a.date < b.date ? -1 : 1);
}
/* The last COMPLETE day — a day with revenue typed but costs not yet is not a
   day of GPAM, it is a day of revenue. */
function anchorOf(list) {
  const cap = Math.min(yesterdayISO(), (DATA && DATA.meta && DATA.meta.latestDataDate) || '9999');
  for (let i = list.length - 1; i >= 0; i--) if (list[i].date <= cap && !list[i].pending && list[i].totalFC != null) return list[i].date;
  return list.length ? list[list.length - 1].date : null;
}

/* ---- render ---- */
function render() {
  if (!DATA) { document.getElementById('errBox').classList.add('show'); return; }
  const list = rows(); const anchor = anchorOf(list); if (!anchor) return;
  const rg = G.period(S.win, anchor);
  const cur = list.filter(r => G.inRange(r, rg) && !r.pending);
  const prevRows = list.filter(r => G.inRange(r, rg.prev));
  const cov = G.coverage(list, rg.prev);
  const L = G.layers(cur, { overheadPerDay: OVERHEAD_PER_DAY });
  const P = cov.ok ? G.layers(prevRows, { overheadPerDay: OVERHEAD_PER_DAY }) : null;
  const ctx = { list, anchor, rg, L, P, cov };
  const safe = (n, fn) => { try { fn(); } catch (e) { console.error('gpam: ' + n + ' failed', e); } };
  safe('header', () => renderHeader(ctx));
  safe('kpis', () => renderKpis(ctx));
  safe('waterfall', () => renderWaterfall(ctx));
  safe('months', () => renderMonths(ctx));
  safe('form', () => renderForm(ctx));
  safe('bridge', () => renderBridge(ctx));
  document.getElementById('footSource').textContent =
    `P&L sheet · ${L.days} complete day${L.days === 1 ? '' : 's'} · through ${niceY(anchor)} · ${S.live === 'live' ? 'live' : 'snapshot'}` +
    (PRIOR ? ' · 2025 book for last year' : '');
  if (window.DLmotion) DLmotion.countUpAll();
}

function renderHeader({ list, anchor, rg, cov }) {
  document.querySelectorAll('#winSeg button').forEach(b => b.classList.toggle('active', b.dataset.win === S.win));
  document.getElementById('winLabel').textContent = rg.label.toUpperCase();
  const same = rg.start === rg.end;
  const span = same ? niceY(rg.start) : `${nice(rg.start)}–${nice(rg.end)} ${rg.end.slice(0, 4)}`;
  document.getElementById('winDates').textContent = (span + (cov.ok ? ` · VS ${nice(rg.prev.start)}–${nice(rg.prev.end)} ${rg.prev.end.slice(0, 4)}` : ' · NO FULL PRIOR YEAR')).toUpperCase();
  document.getElementById('throughVal').textContent = niceY(anchor);
  const last = list[list.length - 1];
  const pend = last && last.date > anchor ? `${nice(last.date)} ${pendingLabel(last) || 'pending'}` : 'all days complete';
  document.getElementById('throughPend').textContent = pend;
}

function tile(lbl, val, sub, foot, cls) {
  return `<div class="kpi ${cls || ''}"><div class="k-head"><div class="k-lbl">${lbl}</div><div class="k-val">${val}</div><div class="k-sub">${sub || ''}</div></div><div class="k-foot">${foot || ''}</div></div>`;
}
function renderKpis({ list, anchor, rg, L, P, cov }) {
  const el = document.getElementById('kpis');
  const vs = cov.ok ? 'vs same dates last yr' : 'no full prior year';
  const fy = fyForecast(list, anchor, rg);
  el.innerHTML = [
    tile('Net revenue', money(L.netRevenue), `ex GST${L.returns ? ' · returns ' + money(L.returns) : ''} · ${L.days} days`, (P ? deltaEl(L.netRevenue, P.netRevenue) : '<span class="delta flat">—</span>') + `<span class="k-per">${vs}</span>`),
    tile('Gross profit', money(L.grossProfit), `margin <b>${pct(L.gmPct)}</b> · COGS ${money(L.cogs.total)}`, (P ? deltaEl(L.gmPct, P.gmPct) : '<span class="delta flat">—</span>') + `<span class="k-per">${P ? 'GM% vs ' + pct(P.gmPct) + ' last yr' : vs}</span>`),
    tile('Advertising', money(L.ads.total), `<b>${pct(L.adsPct)}</b> of net revenue · MER ${L.mer ? L.mer.toFixed(2) + '×' : '—'}`, (P ? deltaEl(L.adsPct, P.adsPct, 'low') : '<span class="delta flat">—</span>') + `<span class="k-per">${P ? 'rate vs ' + pct(P.adsPct) + ' last yr' : vs}</span>`),
    tile('Contribution', money(L.cm), `margin <b>${pct(L.cmPct)}</b> · after COGS and ads`, (P ? deltaEl(L.cm, P.cm) : '<span class="delta flat">—</span>') + `<span class="k-per">${vs}</span>`),
    tile('GPAM · ' + (rg.win === 'FYTD' ? rg.label : rg.label.toLowerCase()), money(L.gpam), `<b>${pct(L.gpamPct)}</b> of net revenue${L.overhead.total ? ' · after ' + money(L.overhead.total) + ' mkt overhead' : ' · no mkt overhead line'}`, (P ? deltaEl(L.gpam, P.gpam) : '<span class="delta flat">—</span>') + `<span class="k-per">${P ? 'vs ' + money(P.gpam) + ' last yr' : vs}</span>`, L.gpam < 0 ? 'bad accent' : 'accent'),
    fy ? tile('GPAM · ' + fy.label, money(fy.total), `to date <b>${money(fy.actual)}</b> · forecast ${money(fy.fc)} to 30 Jun`, `<span class="delta flat">forecast</span><span class="k-per">realistic scenario · ${fy.horizon} days ahead · not a commitment</span>`)
       : tile('GPAM · financial year', money(fyActual(list, anchor)), 'to date', '<span class="delta flat">no forecast engine</span>'),
  ].join('');
}

/* FY to date actual plus the realistic forecast to 30 June, on the same
   layers: each forecast day's revenue × contribution rate less its ad spend
   (forecast.js already models both), less declared overhead. */
function fyActual(list, anchor) {
  const fy = G.period('FYTD', anchor);
  return G.layers(list.filter(r => G.inRange(r, fy) && !r.pending), { overheadPerDay: OVERHEAD_PER_DAY }).gpam;
}
function fyForecast(list, anchor, rg) {
  if (!F) return null;
  const fy = G.period('FYTD', anchor);
  const end = `${fy.fyStartYear + 1}-06-30`;
  const horizon = G.expectedDays({ start: anchor, end }) - 1;
  if (horizon < 1) return null;
  let mods = [];
  try { const years = new Set(list.map(r => r.date.slice(0, 4))); years.add(String(+anchor.slice(0, 4) + 1)); mods = F.salePeriodModifiers(list, { years: [...years].sort() }); } catch (e) { mods = []; }
  let p; try { p = F.projectPnl({ rows: list, from: anchor, horizon, scenario: 'realistic', modifiers: mods }); } catch (e) { return null; }
  if (!p || !p.pnl) return null;
  const fc = p.days.reduce((a, d) => a + d.revenue * p.pnl.contribRate - (d.adSpend || 0), 0) - OVERHEAD_PER_DAY * horizon;
  const actual = fyActual(list, anchor);
  return { label: `FY${String(fy.fyStartYear + 1).slice(2)}`, actual, fc, total: actual + fc, horizon };
}

/* ---- waterfall ---- */
const WF_COLOUR = { total: 'rgba(245,235,25,.8)', minus: 'rgba(255,90,82,.72)', gpam: 'rgba(57,217,138,.9)', ghost: 'rgba(255,255,255,.14)', 'ghost-total': 'rgba(255,255,255,.35)' };
function renderWaterfall({ L, rg }) {
  const steps = G.waterfall(L);
  if (CHART) { CHART.destroy(); CHART = null; }
  if (typeof Chart === 'undefined') return;
  const colours = steps.map(s => s.key === 'gpam' ? WF_COLOUR.gpam : WF_COLOUR[s.kind]);
  const labelPlugin = { id: 'wfLabels', afterDatasetsDraw(ch) {
    const { ctx: c, scales } = ch; c.save(); c.font = '600 10px system-ui, sans-serif'; c.textAlign = 'center';
    ch.getDatasetMeta(0).data.forEach((bar, i) => {
      const s = steps[i]; const y = scales.y.getPixelForValue(s.to);
      c.fillStyle = s.kind === 'minus' ? 'rgba(255,140,132,.95)' : s.key === 'gpam' ? '#39d98a' : s.kind.startsWith('ghost') ? 'rgba(255,255,255,.55)' : '#f5eb19';
      const txt = (s.kind === 'minus' || s.kind === 'ghost' ? '−' : s.value < 0 ? '−' : '') + money(Math.abs(s.value));
      c.fillText(txt, bar.x, s.value < 0 && s.kind !== 'minus' && s.kind !== 'ghost' ? scales.y.getPixelForValue(s.from) + 12 : y - 4);
      if (s.kind === 'total' || s.key === 'gpam') { c.fillStyle = 'rgba(255,255,255,.55)'; c.font = '400 9px system-ui, sans-serif';
        const share = L.netRevenue ? (s.value / L.netRevenue * 100).toFixed(0) + '%' : ''; if (s.key !== 'grossSales' && share) c.fillText(share, bar.x, y - 15); c.font = '600 10px system-ui, sans-serif'; }
    }); c.restore(); } };
  CHART = new Chart(document.getElementById('wfChart'), {
    type: 'bar',
    data: { labels: steps.map(s => s.label), datasets: [{ data: steps.map(s => [s.from, s.to]), backgroundColor: colours, borderWidth: 0, borderRadius: 3, barPercentage: .72, categoryPercentage: .9 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: { duration: 450 }, layout: { padding: { top: 22 } },
      scales: { x: { grid: { display: false }, ticks: { color: '#c9c1c2', font: { size: 10 }, maxRotation: 0, autoSkip: false } },
                y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#9a9193', font: { size: 9 }, callback: v => money(v) } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: i => { const s = steps[i.dataIndex]; return `${s.label}: ${money(s.value, false)}` + (L.netRevenue && s.key !== 'grossSales' ? ` · ${(s.value / L.netRevenue * 100).toFixed(1)}% of net revenue` : ''); } } } } },
    plugins: [labelPlugin],
  });
  document.getElementById('wfNote').textContent = `${rg.label} · ${nice(rg.start)}–${nice(rg.end)} · each bar as a share of net revenue · grey is below the line, outside GPAM`;
}

/* ---- FY months ---- */
function renderMonths({ list, anchor }) {
  const wrap = document.getElementById('months');
  const months = G.fyMonths(anchor);
  let html = `<div class="thead gp"><div>Month</div><div class="num">Net rev</div><div class="num">GM%</div><div class="num">Ads%</div><div class="num">CM%</div><div class="num">GPAM</div><div class="num">GPAM%</div><div class="num">vs LY</div></div>`;
  let tot = [];
  months.forEach(ym => {
    const rg = G.period(ym, anchor);
    const cur = list.filter(r => G.inRange(r, rg) && !r.pending); if (!cur.length) return;
    const L = G.layers(cur, { overheadPerDay: OVERHEAD_PER_DAY }); tot = tot.concat(cur);
    const cov = G.coverage(list, rg.prev);
    const P = cov.ok ? G.layers(list.filter(r => G.inRange(r, rg.prev)), { overheadPerDay: OVERHEAD_PER_DAY }) : null;
    const partial = rg.end === anchor && +anchor.slice(8, 10) < G.expectedDays({ start: rg.start, end: `${ym}-28` }) + 1 ? true : false;
    const isCur = ym === anchor.slice(0, 7);
    html += `<div class="trow gp${isCur ? ' cur' : ''}" title="${esc(MONTH_ABBR[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4) + ': ' + L.days + ' days · net revenue ' + money(L.netRevenue, false) + ' · GPAM ' + money(L.gpam, false) + (P ? ' · last year ' + money(P.gpam, false) : ''))}">
      <div class="pname">${MONTH_ABBR[+ym.slice(5, 7) - 1]} <small>${ym.slice(2, 4)}${isCur ? ' · ' + L.days + 'd' : ''}</small></div>
      <div class="num">${money(L.netRevenue)}</div><div class="num">${pct(L.gmPct, 0)}</div><div class="num">${pct(L.adsPct, 0)}</div><div class="num">${pct(L.cmPct, 0)}</div>
      <div class="num ${L.gpam < 0 ? 'neg' : 'pos'}">${money(L.gpam)}</div><div class="num">${pct(L.gpamPct, 0)}</div>
      <div class="num">${P ? deltaEl(L.gpam, P.gpam) : '<span class="delta flat">—</span>'}</div></div>`;
  });
  if (tot.length) {
    const T = G.layers(tot, { overheadPerDay: OVERHEAD_PER_DAY });
    const fy = G.period('FYTD', anchor); const cov = G.coverage(list, fy.prev);
    const P = cov.ok ? G.layers(list.filter(r => G.inRange(r, fy.prev)), { overheadPerDay: OVERHEAD_PER_DAY }) : null;
    html += `<div class="trow gp tot"><div class="pname">${fy.label.toUpperCase()}</div>
      <div class="num">${money(T.netRevenue)}</div><div class="num">${pct(T.gmPct, 0)}</div><div class="num">${pct(T.adsPct, 0)}</div><div class="num">${pct(T.cmPct, 0)}</div>
      <div class="num ${T.gpam < 0 ? 'neg' : 'pos'}">${money(T.gpam)}</div><div class="num">${pct(T.gpamPct, 0)}</div>
      <div class="num">${P ? deltaEl(T.gpam, P.gpam) : '<span class="delta flat">—</span>'}</div></div>`;
  }
  wrap.innerHTML = html;
  document.getElementById('monthsNote').textContent = `financial year from 1 July · each month vs the same dates last year · the current month is to ${nice(anchor)}`;
}

/* ---- the formulation ---- */
function renderForm({ L, rg }) {
  const f = document.getElementById('fform'), w = document.getElementById('form2');
  f.innerHTML = `<b>GPAM</b> = Net revenue − COGS − Advertising − Marketing overhead &nbsp;·&nbsp; <b>GPAM %</b> = GPAM ÷ Net revenue &nbsp;·&nbsp; <b>Profit</b> = GPAM − Below the line`;
  const line = (label, v, cls, note) => `<div class="fline ${cls || ''}"><span class="fl-n">${esc(label)}${note ? ` <i>${esc(note)}</i>` : ''}</span><span class="fl-v">${money(v)} <small>${L.netRevenue ? (v / L.netRevenue * 100).toFixed(1) + '%' : '—'}</small></span></div>`;
  const items = (lay) => lay.items.filter(i => i.present || i.value).map(i => line(i.label, i.value)).join('') + (lay.other ? line('Other (sheet total − lines)', lay.other, 'dim') : '');
  /* Three columns so every line is on screen at once: revenue to gross profit,
     then advertising and overhead to GPAM, then what sits below. */
  const atl = `<div class="fcol"><div class="fhead">Above the line <small>revenue → gross profit</small></div>
    ${line('Gross sales (inc GST)', L.grossSales, 'top')}${line('GST', -L.gst, 'dim')}${L.returns ? line('Returns', -L.returns, 'dim') : ''}${line('Net revenue', L.netRevenue, 'sum')}
    <div class="fgrp">COGS</div>${items(L.cogs)}${line('Gross profit', L.grossProfit, 'sum')}</div>
    <div class="fcol"><div class="fhead">Above the line <small>→ GPAM</small></div>
    <div class="fgrp">Advertising</div>${items(L.ads)}${line('Contribution margin', L.cm, 'sum')}
    <div class="fgrp">Marketing overhead</div>${L.overhead.inSheet ? items(L.overhead) : `<div class="fline warn"><span class="fl-n">Consultants · content &amp; creative <i>no line in the sheet yet · counted as $0</i></span><span class="fl-v">${money(L.overhead.declared)}</span></div>`}
    ${line('GPAM', L.gpam, 'sum gpam')}
    <div class="fwhy">GPAM is the bonus base: what the trading and marketing team can move — price, mix, COGS, media and the marketing they buy in.</div></div>`;
  const btl = `<div class="fcol"><div class="fhead">Below the line <small>excluded from GPAM</small></div>
    ${items(L.btl)}${line('Below the line total', L.btl.total, 'sum')}
    ${line('Profit (GPAM − below the line)', L.profit, 'sum profit')}
    ${L.sheetProfit != null ? `<div class="fline dim"><span class="fl-n">Sheet PROFIT ${Math.abs(L.profitGap) > 1 ? `<i>differs by ${money(L.profitGap)} — returns${L.overhead.declared ? ' and declared overhead' : ''} are not in the sheet’s expenses</i>` : '<i>ties</i>'}</span><span class="fl-v">${money(L.sheetProfit)}</span></div>` : ''}
    <div class="fwhy">Why these are below the line: people, vehicles, software and the office do not move with a campaign or a price. A bonus judged on GPAM rewards what the team can move and ignores what it cannot.</div></div>`;
  w.innerHTML = atl + btl;
  document.getElementById('formNote').textContent = `${rg.label} · each line as a share of net revenue`;
}

/* ---- bridge ---- */
function renderBridge({ L, P, rg, cov }) {
  const el = document.getElementById('bridge'), note = document.getElementById('bridgeNote'), foot = document.getElementById('bridgeFoot');
  const B = P ? G.bridge(L, P) : null;
  if (!B) { el.innerHTML = `<div class="empty">No full prior year for ${rg.label.toLowerCase()} — the 2025 book starts 1 July 2025, so the same dates last year are ${cov.n} of ${cov.expected} days. Comparisons appear once the window is at least 90% covered.</div>`; note.textContent = 'vs same dates last year'; foot.textContent = ''; return; }
  const maxAbs = Math.max(1, ...B.items.map(i => Math.abs(i.value)), Math.abs(B.delta));
  const row = (label, v, sub, cls) => { const w = Math.abs(v) / maxAbs * 50, neg = v < 0;
    return `<div class="pr ${neg ? 'neg' : 'pos'} ${cls || ''}" title="${esc(label + ': ' + money(v, false) + (sub ? ' · ' + sub : ''))}"><div class="pr-l">${esc(label)}<i>${esc(sub || '')}</i></div><div class="pr-t"><s></s><i style="left:${(neg ? 50 - w : 50).toFixed(1)}%;width:${w.toFixed(1)}%"></i></div><div class="pr-v">${(v >= 0 ? '+' : '') + money(v)}</div></div>`; };
  el.innerHTML = B.items.map(i => row(i.label, i.value, i.note)).join('') + row('Δ GPAM', B.delta, `${money(P.gpam)} → ${money(L.gpam)}`, 'tot');
  note.textContent = `vs ${nice(rg.prev.start)}–${nice(rg.prev.end)} ${rg.prev.end.slice(0, 4)} · four effects that sum exactly`;
  const big = B.items.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
  foot.textContent = `Largest driver: ${big.label.toLowerCase()} (${(big.value >= 0 ? '+' : '') + money(big.value)}). Volume is last year’s GPAM rate on the change in net revenue; the three rates are applied to this year’s net revenue.`;
}

/* ---- live ---- */
function setLive(state) { S.live = state; const dot = document.getElementById('liveDot'), txt = document.getElementById('liveText');
  dot.className = 'dot ' + (state === 'live' ? 'live' : state === 'loading' ? 'loading' : 'snap'); txt.textContent = state === 'live' ? 'Live sheet' : state === 'loading' ? 'Syncing…' : 'Snapshot'; }
async function tryLiveRefresh() {
  setLive('loading');
  try {
    const r = await fetch(API_URL); if (!r.ok) throw new Error('http-' + r.status);
    const j = await r.json(); if (!(j.daily || []).length) throw new Error('api-no-rows');
    const map = new Map(DATA.daily.map(d => [d.date, d])); (j.daily || []).forEach(d => map.set(d.date, d));
    DATA.daily = [...map.values()].sort((a, b) => a.date < b.date ? -1 : 1);
    if (j.meta && j.meta.latestDataDate) DATA.meta.latestDataDate = j.meta.latestDataDate;
    setLive('live'); render();
  } catch (e) { setLive('snap'); }
}
function wire() {
  document.querySelectorAll('#winSeg button').forEach(b => b.onclick = () => { S.win = b.dataset.win; render(); });
  window.addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(render, 200); });
}
(function init() {
  if (!DATA || !G) { document.getElementById('errBox').classList.add('show'); return; }
  wire(); setLive('snap'); render();
  if (window.DLmotion) DLmotion.entrance();
  tryLiveRefresh(); setInterval(tryLiveRefresh, REFRESH_MINUTES * 60 * 1000);
})();
