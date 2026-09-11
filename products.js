/* =========================================================================
   DiggerLid — Product Performance (Shopify). Read-only.

   THE GRID. Every product, every day, for about fourteen months: a committed
   snapshot (products_history.js, built from /api/shopify?dataset=productsHistory)
   with the last 45 days replaced live by ?dataset=productsRecent. Everything
   on this page is a sum over a range of that grid, so any period is one
   selection away and none of them costs a Shopify query per product.

   PERIODS. Trailing windows ending yesterday (1D · 3D · 7D · 30D · 90D · 12M)
   and the two calendar windows a business actually reports against — month to
   date and financial year to date (July to June). "Yesterday" is yesterday on
   the shop's clock (AEST), the same day boundary Shopify and the sheet use.

   COMPARISON. Every delta is against one of two things, and the page says
   which: the equal period immediately before, or the same dates a year ago.
   For a business that makes its year in June and November the second is the
   one that answers "is this good?"; the first answers "is it moving?".

   net_sales is ex GST and net of refunds. Orders on a product row are orders
   CONTAINING that product, so product and category rows do not add up to the
   store's order count; the KPI strip carries the true total.
   ========================================================================= */
const HIST = window.DL_PRODUCTS_HISTORY || null;
let G = null;                                            // the merged grid: {days, products, totals, keys}
let KEYS = (HIST && HIST.meta && HIST.meta.keys) || {};
const S = { win: '30', cmp: 'prev', trendMode: 'net' }; // win ∈ {'1','3','7','30','90','MTD','FYTD','12M'}; cmp ∈ {prev, ly}
const { sparkline } = DLcore;
let charts = { trend: null };
const CATCOLORS = {covers:'#f5eb19',grease:'#c98bff',screens:'#5ec8ff',drawbar:'#ff8a4a',
  phone:'#39d98a',shipping:'#ffb020',wipes:'#e0607a',mobile:'#2dd4bf',merch:'#b3abac',other:'#7d7576'};
const PALETTE=['#f5eb19','#c98bff','#ff8a4a','#39d98a','#5ec8ff','#f8f163','#ffb020','#9a9193','#e0607a','#6b6209'];

/* ---- formatters ---- */
const money=(n,c=true)=>{ if(n==null||isNaN(n))return '—';
  if(c){const a=Math.abs(n); if(a>=1e6)return '$'+(n/1e6).toFixed(2)+'M'; if(a>=1e3)return '$'+(n/1e3).toFixed(a>=1e4?0:1)+'K'; return '$'+Math.round(n);}
  return n.toLocaleString('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0}); };
const numf=n=>n==null||isNaN(n)?'—':Math.round(n).toLocaleString('en-AU');
const pct=(n,d=0)=>n==null||isNaN(n)?'—':n.toFixed(d)+'%';
const MONTH=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const nice=iso=>{const[,m,d]=iso.split('-').map(Number);return d+' '+MONTH[m-1];};
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10);};
const yearBefore=iso=>{const [y,m,d]=iso.split('-').map(Number); const back=new Date(Date.UTC(y-1,m-1,d)); return back.toISOString().slice(0,10);};

/* ---- the grid ---- */
/* Snapshot first, then the live top-up: every day the live pull covers replaces
   the snapshot's copy (a refund that repriced an old day lands as the tail moves
   over it), and products the snapshot never saw are appended. */
function mergeGrid(hist, recent){
  if(!hist && !recent) return null;
  const parts=[hist, recent].filter(Boolean);
  const daySet=new Set(); parts.forEach(p=>p.days.forEach(d=>daySet.add(d)));
  const days=[...daySet].sort(); const di=Object.fromEntries(days.map((d,i)=>[d,i]));
  const prod={}; const tot=days.map(()=>[0,0,0]);
  parts.forEach(p=>{                                                    // later parts win
    p.products.forEach(pr=>{
      const row = prod[pr.title] || (prod[pr.title]={title:pr.title, k:pr.k, cells:days.map(()=>[0,0,0])});
      pr.cells.forEach((c,i)=>{ row.cells[di[p.days[i]]]=c.slice(); });
    });
    p.totals.forEach((c,i)=>{ tot[di[p.days[i]]]=c.slice(); });
    // a day the live pull covers but a product did not sell on: zero it, so a
    // snapshot sale that was later refunded to nothing does not survive the merge
    if(p!==parts[0]) Object.values(prod).forEach(row=>{
      if(!p.products.some(pr=>pr.title===row.title)) p.days.forEach(d=>{ row.cells[di[d]]=[0,0,0]; });
    });
  });
  const keys = Object.assign({}, ...(parts.map(p=>(p.meta&&p.meta.keys)||{})));
  return { days, products:Object.values(prod), totals:tot, keys, meta: (recent&&recent.meta)||(hist&&hist.meta)||{} };
}
const dayIndex = () => Object.fromEntries(G.days.map((d,i)=>[d,i]));
/* The newest complete day on the shop's clock; the grid never carries today. */
function anchorDay(){
  const want=DLcore.previousDayAEST();
  const ok=G.days.filter(d=>d<=want);
  return ok.length? ok[ok.length-1] : G.days[G.days.length-1];
}

/* ---- periods ---- */
const WIN_META = {
  '1':  {label:'YESTERDAY',        short:'yesterday'},
  '3':  {label:'LAST 3 DAYS',      short:'3 days'},
  '7':  {label:'LAST 7 DAYS',      short:'7 days'},
  '30': {label:'LAST 30 DAYS',     short:'30 days'},
  '90': {label:'LAST 90 DAYS',     short:'90 days'},
  'MTD':{label:'MONTH TO DATE',    short:'month to date'},
  'FYTD':{label:'FY TO DATE',      short:'FY to date'},
  '12M':{label:'12 MONTHS',        short:'12 months'},
};
/* A range is [start, end] inclusive, in dates. The comparison is either the equal
   run of days immediately before it, or the same calendar dates a year earlier. */
function rangeFor(win, end){
  const [y,m]=end.split('-').map(Number);
  if(win==='MTD')  return { start: end.slice(0,8)+'01', end };
  if(win==='FYTD') return { start: (m>=7? y : y-1)+'-07-01', end };
  if(win==='12M')  return { start: addDays(end,-364), end };
  return { start: addDays(end, -(parseInt(win,10)-1)), end };
}
function comparisonFor(win, r, cmp){
  if(win==='FYTD' || cmp==='ly')                          // for FY to date the two are the same window
    return { start: yearBefore(r.start), end: yearBefore(r.end), label: win==='FYTD' ? 'previous FY to the same date' : 'same dates last year' };
  const len = Math.round((Date.parse(r.end+'T00:00:00Z')-Date.parse(r.start+'T00:00:00Z'))/86400000)+1;
  if(win==='MTD'){                                        // the same number of days at the start of the previous month
    const first=new Date(r.start+'T00:00:00Z'); first.setUTCMonth(first.getUTCMonth()-1);
    const s=first.toISOString().slice(0,10); return { start:s, end:addDays(s,len-1), label:'same days of the previous month' };
  }
  return { start: addDays(r.start,-len), end: addDays(r.start,-1), label: `prior ${WIN_META[win].short}` };
}
/* Sum the grid over a range. Returns null when the grid does not cover any of it. */
function sumRange(r){
  const di=dayIndex();
  const idx=[]; for(let d=r.start; d<=r.end; d=addDays(d,1)) if(di[d]!=null) idx.push(di[d]);
  const expected = Math.round((Date.parse(r.end+'T00:00:00Z')-Date.parse(r.start+'T00:00:00Z'))/86400000)+1;
  if(!idx.length) return null;
  const tot=[0,0,0]; idx.forEach(i=>{ const c=G.totals[i]; tot[0]+=c[0]; tot[1]+=c[1]; tot[2]+=c[2]; });
  const products=G.products.map(p=>{ const a=[0,0,0]; idx.forEach(i=>{ const c=p.cells[i]; a[0]+=c[0]; a[1]+=c[1]; a[2]+=c[2]; });
    return { title:p.title, k:p.k, net:a[0], orders:a[1], units:a[2] }; });
  const cats={}; products.forEach(p=>{ const c=cats[p.k]||(cats[p.k]={key:p.k,name:KEYS[p.k]||p.k,net:0,orders:0,units:0}); c.net+=p.net; c.orders+=p.orders; c.units+=p.units; });
  const daily = idx.map(i=>({date:G.days[i], net:G.totals[i][0], orders:G.totals[i][1], units:G.totals[i][2]}));
  return { net:tot[0], orders:tot[1], units:tot[2], products, categories:Object.values(cats), daily, covered:idx.length, expected };
}
/* Bucket a daily series into weeks when it is too long to read as days. */
function sparkVals(daily, key){
  if(!daily) return null;
  const v = d => key==='aov' ? (d.orders? d.net/d.orders : null) : key==='ipo' ? (d.orders? d.units/d.orders : null) : d[key];
  if(daily.length<=60) return daily.map(v);
  const out=[]; for(let i=0;i<daily.length;i+=7){ const w=daily.slice(i,i+7); const agg={net:0,orders:0,units:0}; w.forEach(d=>{agg.net+=d.net;agg.orders+=d.orders;agg.units+=d.units;}); out.push(v(agg)); }
  return out;
}

/* ---- the selection ---- */
function current(){
  const end=anchorDay(), r=rangeFor(S.win,end), c=comparisonFor(S.win,r,S.cmp);
  const cur=sumRange(r); let prev=sumRange(c);
  /* A comparison window the grid covers less than nine-tenths of would compare
     a whole period against part of one — LAST 12 MONTHS against the four months
     of last year the grid holds read +738%. Below that it is not a comparison. */
  const prevPartial = !!(prev && prev.covered < prev.expected*0.9);
  if(prevPartial) prev=null;
  return { end, r, c, cur, prev, partial: cur && cur.covered<cur.expected, prevPartial };
}
function deltaEl(cur,prev){
  if(cur==null||prev==null||prev===0) return '<span class="delta flat">—</span>';
  const chg=(cur-prev)/Math.abs(prev)*100;
  const cls=Math.abs(chg)<0.05?'flat':chg>0?'up':'down';
  const ar=chg>0.05?'▲':chg<-0.05?'▼':'—';
  return `<span class="delta ${cls}">${ar} ${Math.abs(chg).toFixed(1)}%</span>`;
}
const chgTxt=(c,p)=>{ if(p==null||p===0) return c>0?'<span class="mom up">NEW</span>':'<span class="mom flat">—</span>';
  const m=(c-p)/Math.abs(p); const cls=m>0.05?'up':m<-0.05?'down':'flat', ar=m>0.05?'▲':m<-0.05?'▼':'▪';
  return `<span class="mom ${cls}">${ar} ${Math.abs(m*100).toFixed(0)}%</span>`; };

/* ============================ RENDER ============================ */
function render(){
  if(!G || !G.days.length){ document.getElementById('errBox').classList.add('show'); return; }
  const t=current();
  const r=t.r;
  const tv=document.getElementById('throughVal'); if(tv) tv.textContent = nice(t.end);
  document.getElementById('winLabel').textContent = WIN_META[S.win].label;
  /* One line under the label: the dates, then what they are measured against.
     Kept short because it shares the header with two pickers — "5–7 SEP" not
     "5 Sep – 7 Sep"; the full sentence is the tooltip and the footer. */
  const span = (a,b) => a===b ? nice(a) : (a.slice(0,7)===b.slice(0,7) ? a.slice(8).replace(/^0/,'')+'–'+nice(b) : nice(a)+'–'+nice(b));
  const cmpShort = S.win==='FYTD' ? 'PREV FY' : S.win==='MTD' && S.cmp==='prev' ? 'PREV MONTH' : S.cmp==='ly' ? 'LAST YR' : 'PRIOR';
  const cmpLong = t.prev ? `vs ${t.c.label} (${nice(t.c.start)} – ${nice(t.c.end)})`
                : t.prevPartial ? `${t.c.label} is not fully in the data, so no comparison is shown` : `no data for ${t.c.label}`;
  t.cmpLong = cmpLong;
  const dates=document.getElementById('winDates');
  dates.textContent = (span(r.start,r.end) + (t.prev ? ` · VS ${cmpShort} ${span(t.c.start,t.c.end)}` : ' · NO FULL COMPARISON')).toUpperCase();
  dates.title = cmpLong;
  document.querySelectorAll('#winSeg button').forEach(b=>b.classList.toggle('active', b.dataset.win===S.win));
  document.querySelectorAll('#cmpSeg button').forEach(b=>b.classList.toggle('active', b.dataset.cmp===S.cmp));
  renderKPIs(t); renderCategories(t); renderProducts(t); renderMovers(t); renderFooter(t);
  if(window.DLmotion) DLmotion.countUpAll();
}
function kpiTile(lbl,val,sub,foot,accent,sparkKey){
  return `<div class="kpi ${accent?'accent':''}"><div class="k-head"><div class="k-lbl">${lbl}</div>
    <div class="k-val">${val}</div><div class="k-sub">${sub||''}</div></div>
    <div class="k-foot">${foot||''}</div>
    ${sparkKey?`<canvas class="spark" data-key="${sparkKey}"></canvas>`:''}</div>`;
}
function renderKPIs(t){
  const el=document.getElementById('kpis'), cur=t.cur, prev=t.prev;
  if(!cur){ el.innerHTML=`<div class="kpi accent" style="grid-column:1/-1"><div class="k-lbl">No data</div><div class="k-val">—</div><div class="k-sub">the grid does not cover ${nice(t.r.start)} – ${nice(t.r.end)}</div></div>`; return; }
  const per=`<span class="k-per">vs ${S.cmp==='ly'?'last year':WIN_META[S.win].short==='yesterday'?'day before':'prior period'}</span>`;
  const byNet=(a,b)=>b.net-a.net;
  const topCat=cur.categories.slice().sort(byNet)[0], topProd=cur.products.filter(p=>p.net>0).sort(byNet)[0];
  const aov=cur.orders?cur.net/cur.orders:null, paov=prev&&prev.orders?prev.net/prev.orders:null;
  const trim=s=>s&&s.length>17?s.slice(0,16)+'…':s;
  const ly = (k) => prev ? deltaEl(cur[k], prev[k])+per : '<span class="delta flat">—</span>'+per;
  el.innerHTML=[
    kpiTile('Net Sales',money(cur.net),`${numf(cur.orders)} orders`,ly('net'),true,'net'),
    kpiTile('Orders',numf(cur.orders),`AOV <b>${money(aov)}</b>`,ly('orders'),false,'orders'),
    kpiTile('Units Sold',numf(cur.units),`${cur.orders?(cur.units/cur.orders).toFixed(1):'—'} per order`,ly('units'),false,'units'),
    kpiTile('Avg Order Value',money(aov,false),'net per order',(prev?deltaEl(aov,paov):'<span class="delta flat">—</span>')+per,false,'aov'),
    kpiTile('Top Category',topCat?topCat.name:'—',topCat?`<b>${pct(topCat.net/cur.net*100)}</b> of net`:'','',false,null),
    kpiTile('Top Product',trim(topProd&&topProd.title),topProd?`<b>${pct(topProd.net/cur.net*100,1)}</b> · ${numf(topProd.units)} units`:'','',false,null),
  ].join('');
  el.querySelectorAll('canvas.spark').forEach(cv=>{
    sparkline(cv, sparkVals(cur.daily,cv.dataset.key), prev?sparkVals(prev.daily,cv.dataset.key):null);
  });
}
function renderCategories(t){
  const wrap=document.getElementById('catList'), cur=t.cur, prev=t.prev;
  if(!cur){ wrap.innerHTML=''; return; }
  const list=cur.categories.filter(c=>c.net>0).sort((a,b)=>b.net-a.net), maxNet=Math.max(...list.map(c=>c.net||0),1);
  const pm = prev ? Object.fromEntries(prev.categories.map(c=>[c.key,c])) : null;
  document.getElementById('catNote').textContent = `net sales · share · vs ${S.cmp==='ly'?'last year':'prior period'} · orders overlap`;
  wrap.innerHTML = list.map(c=>{
    const share=c.net/cur.net*100, w=c.net/maxNet*100;
    const p=pm&&pm[c.key];
    return `<div class="catrow">
      <div class="bar" style="width:${Math.max(w,1.5)}%"></div>
      <div class="cinfo"><div class="cname">${c.name}</div>
        <div class="cmeta">${numf(c.orders)} orders · ${numf(c.units)} units</div></div>
      <div class="cright"><div class="cnet">${money(c.net)}</div>
        <div class="cshare">${pct(share)}${prev?' · '+chgTxt(c.net, p?p.net:0):''}</div></div>
    </div>`;
  }).join('');
}
function renderProducts(t){
  const wrap=document.getElementById('pTable'), cur=t.cur, prev=t.prev;
  if(!cur){ wrap.innerHTML=''; return; }
  const CAP=20, all=cur.products.filter(p=>p.net>0).sort((a,b)=>b.net-a.net), rows=all.slice(0,CAP);
  const pm = prev ? Object.fromEntries(prev.products.map(p=>[p.title,p])) : null;
  document.getElementById('prodNote').textContent = all.length>CAP
    ? `Top ${CAP} of ${all.length} · scroll for more` : (all.length>6 ? `${all.length} products · scroll for more` : 'Top sellers');
  let html=`<div class="thead"><div>#</div><div>Product</div><div class="num">Net Sales</div><div class="num">vs ${S.cmp==='ly'?'LY':'prior'}</div><div class="num">Units</div><div class="num">Orders</div><div class="num">Share</div></div>`;
  html+=rows.map((p,i)=>`<div class="trow">
    <div class="rank">${i+1}</div>
    <div><div class="pname">${p.title}</div><div class="pcat">${KEYS[p.k]||p.k}</div></div>
    <div class="num">${money(p.net)}</div>
    <div class="num dim">${prev? chgTxt(p.net, pm[p.title]?pm[p.title].net:0) : '—'}</div>
    <div class="num dim">${numf(p.units)}</div>
    <div class="num dim">${numf(p.orders)}</div>
    <div class="share">${pct(p.net/cur.net*100,1)}</div>
  </div>`).join('');
  wrap.innerHTML=html;
}
/* Category Trends: net sales by category by month over the grid (the over-time view,
   independent of the period selector). Top 6 categories get a line; the rest fold
   into "Other". Toggle net $ vs mix %. */
function trendSeries(){
  const months={};
  G.days.forEach((d,i)=>{ const m=d.slice(0,7); const b=months[m]||(months[m]={m, cats:{}});
    G.products.forEach(p=>{ const v=p.cells[i][0]; if(v) b.cats[p.k]=(b.cats[p.k]||0)+v; }); });
  const end=anchorDay().slice(0,7);
  const cm=Object.values(months).filter(b=>b.m<=end).sort((a,b)=>a.m<b.m?-1:1).slice(-13);
  const labels=cm.map(b=>{const [y,m]=b.m.split('-'); return MONTH[+m-1]+' '+y.slice(2);});
  const tot={}; cm.forEach(r=>Object.entries(r.cats).forEach(([k,v])=>tot[k]=(tot[k]||0)+v));
  const ranked=Object.keys(tot).filter(k=>k!=='other').sort((a,b)=>tot[b]-tot[a]);
  const top=ranked.slice(0,6), keys=top.concat(['other']);
  const val=(r,k)=> k==='other' ? Object.entries(r.cats).reduce((a,[ck,cv])=>a+(top.includes(ck)?0:cv),0) : (r.cats[k]||0);
  const monthTot=cm.map(r=>Object.values(r.cats).reduce((a,b)=>a+b,0));
  return {labels, keys, series:keys.map(k=>cm.map((r,i)=>{ const v=val(r,k); return S.trendMode==='share' ? (monthTot[i]? v/monthTot[i]*100:0) : v; })), partialLast: anchorDay().slice(8)!==String(new Date(Date.UTC(+anchorDay().slice(0,4), +anchorDay().slice(5,7), 0)).getUTCDate())};
}
function renderTrend(){
  if(!G) return;
  const share=S.trendMode==='share';
  const {labels, keys, series, partialLast}=trendSeries();
  const name=k=>KEYS[k]||(k==='other'?'Other':k);
  const datasets=keys.map((k,i)=>{ const col=CATCOLORS[k]||PALETTE[i%PALETTE.length];
    return {label:name(k), data:series[i], borderColor:col, backgroundColor: share? col+'cc' : col+'22',
      fill: share?(i===0?'origin':'-1'):false, borderWidth: share?1:2.4, tension:.32, pointRadius:0, pointHoverRadius:4, cubicInterpolationMode:'monotone'}; });
  document.getElementById('trendNote').textContent = (share?'by month · % of net':'by month · net sales') + (partialLast?' · latest month to date':'');
  const cfg={type:'line', data:{labels, datasets},
    options:{responsive:true, maintainAspectRatio:false, animation:{duration:600}, interaction:{mode:'index', intersect:false},
      scales:{ x:{stacked:share, grid:{color:'rgba(255,255,255,0.05)'}, ticks:{color:'#9a9193', font:{size:9.5}}},
               y:{stacked:share, beginAtZero:true, max:share?100:undefined, grid:{color:'rgba(255,255,255,0.05)'},
                  ticks:{color:'#9a9193', font:{size:9.5}, callback:v=> share ? v+'%' : (v>=1000?'$'+(v/1000)+'K':'$'+v)}}},
      plugins:{ legend:{position:'bottom', labels:{color:'#c9c1c2', boxWidth:9, boxHeight:9, font:{size:9.5}, padding:6, usePointStyle:true}},
                tooltip:{callbacks:{label:i=> `${i.dataset.label}: ${share?pct(i.raw,1):money(i.raw)}`}}}}};
  if(charts.trend) charts.trend.destroy();
  charts.trend=new Chart(document.getElementById('trendChart'),cfg);
}
/* Top movers: the PRODUCTS whose net sales moved most against the comparison, in
   the selected period. Products, not categories — a category hides which line
   moved. Noise floor so a $40 tee doubling does not top the list. */
function renderMovers(t){
  const wrap=document.getElementById('moversWrap'), cur=t.cur, prev=t.prev;
  document.getElementById('moversNote').textContent = `products · ${WIN_META[S.win].short} vs ${S.cmp==='ly'?'last year':'prior period'}`;
  if(!cur || !prev){
    wrap.innerHTML=`<div class="hrow"><span class="hdot a"></span><span class="hnm" style="grid-column:2 / -1">No ${S.cmp==='ly'?'last-year':'prior-period'} data for this window</span></div>`; return; }
  const pm=Object.fromEntries(prev.products.map(p=>[p.title,p]));
  const floor = Math.max(500, cur.net*0.01);
  const rows=cur.products.map(p=>{ const q=pm[p.title]; const pv=q?q.net:0;
    if(Math.max(p.net,pv)<floor) return null;
    const isNew=pv<=0&&p.net>0, gone=p.net<=0&&pv>0;
    const chg= pv>0 ? (p.net-pv)/pv : (isNew?Infinity:0);
    return {title:p.title, cur:p.net, prev:pv, chg, isNew, gone, abs:p.net-pv}; }).filter(Boolean);
  const top=rows.sort((a,b)=>Math.abs(b.abs)-Math.abs(a.abs)).slice(0,6);
  wrap.innerHTML = top.map(x=>{
    const cls=x.abs>0?'g':x.abs<0?'b':'a';
    const txt=x.isNew?'NEW':x.gone?'GONE':`${x.chg>=0?'+':''}${(x.chg*100).toFixed(0)}%`;
    return `<div class="hrow"><span class="hdot ${cls}"></span>
      <span class="hnm" title="${x.title}">${x.title}</span>
      <span class="hval ${cls}-t">${txt}</span>
      <small class="mv-sub">${money(x.cur)} <span class="dim">← ${money(x.prev)}</span></small></div>`;
  }).join('') || `<div class="hrow"><span class="hdot a"></span><span class="hnm" style="grid-column:2 / -1">Nothing moved above the noise floor</span></div>`;
}
function renderFooter(t){
  const m=G.meta||{};
  document.getElementById('footSource').innerHTML=`Source: ${m.source||'Shopify · ShopifyQL sales'} · <b>AUD</b> · net sales ex GST · through ${nice(t.end)} · ${t.cmpLong||''}${t.partial?' · <span class="dim">selected period only partly in the data</span>':''}`;
}

/* ---- live / wiring / init ---- */
function setLive(mode, note){ const dot=document.getElementById('liveDot'),txt=document.getElementById('liveText'),pill=document.getElementById('livePill');
  dot.className='dot '+(mode==='live'?'live':mode==='loading'?'loading':'snap'); txt.textContent=mode==='live'?'Live':mode==='loading'?'Syncing…':'Snapshot';
  if(pill) pill.title = note || 'Data source status'; }
function wire(){
  document.querySelectorAll('#winSeg button').forEach(b=>b.onclick=()=>{ S.win=b.dataset.win; render(); });
  document.querySelectorAll('#cmpSeg button').forEach(b=>b.onclick=()=>{ S.cmp=b.dataset.cmp; render(); });
  document.querySelectorAll('#trendMode button').forEach(b=>b.onclick=()=>{
    S.trendMode=b.dataset.mode;
    document.querySelectorAll('#trendMode button').forEach(x=>x.classList.toggle('active',x===b));
    renderTrend();
  });
  window.addEventListener('resize',()=>{clearTimeout(window._rz);window._rz=setTimeout(()=>{render();renderTrend();},200);});
}
/* The snapshot draws first; the last 45 days are then replaced live. */
async function tryLive(){
  setLive('loading');
  try{
    const r=await fetch('/api/shopify?dataset=productsRecent'); if(!r.ok) throw new Error('http-'+r.status);
    const j=await r.json(); if(!j||j.error||!j.days||!j.days.length) throw new Error('empty');
    G=mergeGrid(HIST, j); KEYS=G.keys||KEYS;
    render(); renderTrend(); setLive('live');
  }catch(e){ setLive('snap', 'Live top-up unavailable — showing the committed grid through '+(G&&G.days.length?nice(G.days[G.days.length-1]):'—')); }
}
(function init(){
  G = mergeGrid(HIST, null);
  if(!G){ document.getElementById('errBox').classList.add('show'); return; }
  wire(); render(); renderTrend(); setLive('snap');
  if(window.DLmotion) DLmotion.entrance();
  tryLive();
})();
