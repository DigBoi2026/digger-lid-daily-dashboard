/* =========================================================================
   DiggerLid — Product Performance (Shopify). Read-only.
   Unified period selector 7D · 30D · 90D · 12M (matches the other pages).
   7D/30D use daily history; 90D/12M use monthly history. Net-sales totals live
   on Daily Ops — here we break sales down by category & product.
   ========================================================================= */
let D = window.DL_SHOPIFY || null;
const KEYS = D ? D.keys : {};
const S = { win: 30, off: 0, trendMode: 'net' };         // win ∈ {7,30,90,'12M'}; trendMode ∈ {net,share}
const { sparkline, periodSlices } = DLcore;              // shared, unit-tested
let charts = { trend:null };
// stable colour per category so lines/legend don't shuffle between modes
const CATCOLORS = {covers:'#f5eb19',grease:'#c98bff',screens:'#5ec8ff',drawbar:'#ff8a4a',
  phone:'#39d98a',shipping:'#ffb020',wipes:'#e0607a',mobile:'#2dd4bf',merch:'#b3abac',other:'#7d7576'};

const money=(n,c=true)=>{ if(n==null||isNaN(n))return '—';
  if(c){const a=Math.abs(n); if(a>=1e6)return '$'+(n/1e6).toFixed(2)+'M'; if(a>=1e3)return '$'+(n/1e3).toFixed(a>=1e4?0:1)+'K'; return '$'+Math.round(n);}
  return n.toLocaleString('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0}); };
const numf=n=>n==null||isNaN(n)?'—':Math.round(n).toLocaleString('en-AU');
const pct=(n,d=0)=>n==null||isNaN(n)?'—':n.toFixed(d)+'%';
const MONTH=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const nice=iso=>{const[,m,d]=iso.split('-').map(Number);return d+' '+MONTH[m-1];};
const PALETTE=['#f5eb19','#c98bff','#ff8a4a','#39d98a','#5ec8ff','#f8f163','#ffb020','#9a9193','#e0607a','#6b6209'];
const WLABEL={3:'LAST 3 DAYS',7:'LAST 7 DAYS',30:'LAST 30 DAYS',90:'LAST 90 DAYS','12M':'LAST 12 MONTHS'};
const PDAYS={3:3,7:7,30:30,90:90,'12M':365};

/* ---- helpers ---- */
const yIdx = () => D.daily.length - 2;                    // yesterday (last daily row = partial today)
const sum = (arr,k) => (arr||[]).reduce((a,d)=>a+(d[k]||0),0);
const daySlice = W => { const y=yIdx(); return D.daily.slice(Math.max(0,y-W+1), y+1); };
const prevSlice = W => { const y=yIdx(), s=y-2*W+1; return s>=0 ? D.daily.slice(s, y-W+1) : null; };
const uval = d => d.items!=null ? d.items : d.units;      // daily uses .items, monthly uses .units

// bucket a period's product rows into categories + a sorted product list
function windowData(W){
  const rows = D.windows[String(W)] || [];
  const cats={}; let net=0, units=0;
  rows.forEach(r=>{
    if(!cats[r.k]) cats[r.k]={key:r.k,name:KEYS[r.k]||r.k,net:0,items:0,orders:0};
    cats[r.k].net+=r.net; cats[r.k].items+=r.u; cats[r.k].orders+=r.o; net+=r.net; units+=r.u;
  });
  return {
    categories: Object.values(cats).sort((a,b)=>b.net-a.net),
    products: rows.filter(r=>r.net>0).map(r=>({title:r.t,cat:KEYS[r.k]||r.k,net:r.net,items:r.u,orders:r.o})).sort((a,b)=>b.net-a.net),
    net, units
  };
}
const base12M = () => windowData('12M');
/* Period run-rate vs the same category's 12-month average run-rate.

   Read this against companyMomentum() below, not on its own. The whole business
   is currently running 22-39% above its own 12-month pace, so at 90 days 8 of 10
   categories show an up arrow — that is the rising tide, not ten categories each
   outperforming. The note under the list now states the company figure so the
   arrows can be read as "faster or slower than the business as a whole". */
function momentum(catKey, catNet, W){
  if(W==='12M') return null;
  const b=base12M().categories.find(c=>c.key===catKey);
  if(!b || !b.net) return null;
  return (catNet/PDAYS[W]) / (b.net/365) - 1;
}
// The same calculation over every category, i.e. the baseline drift the arrows sit on.
function companyMomentum(W){
  if(W==='12M') return null;
  const cur=windowData(W).net, base=base12M().net;
  if(!base) return null;
  return (cur/PDAYS[W]) / (base/365) - 1;
}
function momEl(m){
  if(m==null) return '<span class="mom flat">—</span>';
  const cls=m>0.05?'up':m<-0.05?'down':'flat', ar=m>0.05?'▲':m<-0.05?'▼':'▪';
  return `<span class="mom ${cls}">${ar} ${Math.abs(m*100).toFixed(0)}%</span>`;
}

function totals(){
  const W=S.win, wd=windowData(W);
  let orders, units, prevNet=null, prevOrders=null, prevUnits=null, curSpark, prevSpark=null;
  if(W===3 || W===7 || W===30){                           // daily-based
    const cur=daySlice(W), prev=prevSlice(W);
    orders=sum(cur,'orders'); units=sum(cur,'items'); curSpark=cur;
    if(prev){ prevOrders=sum(prev,'orders'); prevUnits=sum(prev,'items'); prevNet=sum(prev,'net'); prevSpark=prev; }
  } else {
    /* Long windows: the totals now come from the API's own query over exactly
       this window (winTotals), so orders, units and net all describe the same
       period. They used to be taken from whole calendar months — "LAST 90 DAYS"
       counted Jun+Jul+Aug orders against a trailing-90-day net, which made AOV a
       ratio of two different periods and stopped the order count eight days
       short of its label.

       Monthly rows are still the sparkline series: they are the only long-run
       shape available, and a sparkline is a trend, not a total. */
    const n=(W===90?3:12), M=D.monthly;
    const t=(D.winTotals||{})[String(W)];
    curSpark=M.slice(-n);
    if(t){ orders=t.orders; units=t.units; }
    else { orders=sum(curSpark,'orders'); units=sum(curSpark,'units'); }   // pre-winTotals payload
    const pt=(D.winPrevTotals||{})[String(W)];
    if(pt){ prevOrders=pt.orders; prevUnits=pt.units; prevNet=pt.net; prevSpark=M.slice(-2*n,-n); }
    else if(W===90 && M.length>=2*n){
      const prev=M.slice(-2*n,-n); prevOrders=sum(prev,'orders'); prevUnits=sum(prev,'units'); prevNet=sum(prev,'net'); prevSpark=prev;
    }
  }
  const net=(W===3||W===7||W===30) ? wd.net
    : (((D.winTotals||{})[String(W)]||{}).net ?? wd.net);   // same period as orders/units
  return {W,wd,net,orders,units,aov:orders?net/orders:0,prevOrders,prevUnits,prevNet,
    prevAov:(prevNet&&prevOrders)?prevNet/prevOrders:null,curSpark,prevSpark};
}

/* ---- delta + sparkline ---- */
function deltaEl(cur,prev){
  if(cur==null||prev==null||prev===0) return '<span class="delta flat">—</span>';
  const chg=(cur-prev)/Math.abs(prev)*100;
  const cls=Math.abs(chg)<0.05?'flat':chg>0?'up':'down';
  const ar=chg>0.05?'▲':chg<-0.05?'▼':'—';
  return `<span class="delta ${cls}">${ar} ${Math.abs(chg).toFixed(1)}%</span>`;
}
const svals=(list,m)=>(list||[]).map(d=>{
  if(m==='aov') return d.orders?d.net/d.orders:null;
  if(m==='ipo') return d.orders?uval(d)/d.orders:null;
  if(m==='units') return uval(d);
  return d[m];
});

/* ============================ RENDER ============================ */
function render(){
  if(!D){ document.getElementById('errBox').classList.add('show'); return; }
  const t=totals();
  // The last day actually included, not meta.asOf. asOf is the date the pull ran,
  // so it said "9 Sep" while every window ends at yesterday and every other page
  // said 8 Sep. Windows are anchored on yIdx(), so read the date from there.
  document.getElementById('throughVal').textContent = nice(D.daily[yIdx()].date);
  document.getElementById('winLabel').textContent = WLABEL[S.win];
  document.querySelectorAll('#winSeg button').forEach(b=>b.classList.toggle('active', b.dataset.win===String(S.win)));
  renderKPIs(t); renderCategories(t); renderProducts(t); renderMovers(t); renderFooter();
  if(window.DLmotion) DLmotion.countUpAll();
}
function kpiTile(lbl,val,sub,foot,accent,sparkKey){
  return `<div class="kpi ${accent?'accent':''}"><div class="k-head"><div class="k-lbl">${lbl}</div>
    <div class="k-val">${val}</div><div class="k-sub">${sub||''}</div></div>
    <div class="k-foot">${foot||''}</div>
    ${sparkKey?`<canvas class="spark" data-key="${sparkKey}"></canvas>`:''}</div>`;
}
function renderKPIs(t){
  const wd=t.wd, el=document.getElementById('kpis');
  const per=`<span class="k-per">vs prior ${WLABEL[t.W].replace('LAST ','').toLowerCase()}</span>`;
  const topCat=wd.categories[0], topProd=wd.products[0];
  const trim=s=>s&&s.length>17?s.slice(0,16)+'…':s;
  el.innerHTML=[
    kpiTile('Orders',numf(t.orders),`AOV <b>${money(t.aov)}</b>`,deltaEl(t.orders,t.prevOrders)+per,true,'orders'),
    kpiTile('Units Sold',numf(t.units),`${t.orders?(t.units/t.orders).toFixed(1):'—'} per order`,deltaEl(t.units,t.prevUnits)+per,false,'units'),
    kpiTile('Avg Order Value',money(t.aov,false),'net per order',deltaEl(t.aov,t.prevAov)+per,false,'aov'),
    kpiTile('Items / Order',t.orders?(t.units/t.orders).toFixed(1):'—','units per order','',false,'ipo'),
    kpiTile('Top Category',topCat?topCat.name:'—',topCat?`<b>${pct(topCat.net/wd.net*100)}</b> of net`:'','',false,null),
    kpiTile('Top Product',trim(topProd&&topProd.title),topProd?`<b>${pct(topProd.net/wd.net*100,1)}</b> · ${numf(topProd.items)} units`:'','',false,null),
  ].join('');
  el.querySelectorAll('canvas.spark').forEach(cv=>{
    sparkline(cv, svals(t.curSpark,cv.dataset.key), t.prevSpark?svals(t.prevSpark,cv.dataset.key):null);
  });
}
function renderCategories(t){
  const wrap=document.getElementById('catList');
  const list=t.wd.categories, maxNet=Math.max(...list.map(c=>c.net||0));
  /* "orders" on a category row means orders CONTAINING that category, so the
     rows do not add up to the order count in the KPI strip — 30 days of rows
     sum to 3,956 against 1,766 real orders, because a three-category order is
     counted in all three. Net sales and units do partition; say which is which
     rather than leave a reader to discover it by adding them up. */
  const cm=companyMomentum(S.win);
  const cmTxt=cm==null?'' : ` (business ${cm>=0?'+':''}${(cm*100).toFixed(0)}%)`;
  document.getElementById('catNote').textContent = S.win==='12M'
    ? 'net sales · share · orders overlap'
    : `net sales · share · vs 12-mo pace${cmTxt} · orders overlap`;
  wrap.innerHTML = list.map(c=>{
    const share=c.net/t.wd.net*100, w=maxNet?(c.net/maxNet*100):0;
    const mom = (S.win==='12M'||c.key==='other') ? '' : ' · '+momEl(momentum(c.key,c.net,S.win));
    return `<div class="catrow">
      <div class="bar" style="width:${Math.max(w,1.5)}%"></div>
      <div class="cinfo"><div class="cname">${c.name}</div>
        <div class="cmeta">${numf(c.orders)} orders · ${numf(c.items)} units</div></div>
      <div class="cright"><div class="cnet">${money(c.net)}</div>
        <div class="cshare">${pct(share)}${mom}</div></div>
    </div>`;
  }).join('');
}
function renderProducts(t){
  const wrap=document.getElementById('pTable');
  const CAP=15, all=t.wd.products, rows=all.slice(0,CAP);
  // The table used to render 15 rows into a box that showed six, with no hint
  // that it continued. It scrolls now, so state what is in it.
  document.getElementById('prodNote').textContent = all.length>CAP
    ? `Top ${CAP} of ${all.length} · scroll for more`
    : (all.length>6 ? `Top sellers · ${all.length} · scroll for more` : 'Top sellers');
  let html=`<div class="thead"><div>#</div><div>Product</div><div class="num">Net Sales</div><div class="num">Units</div><div class="num">Orders</div><div class="num">Share</div></div>`;
  html+=rows.map((p,i)=>`<div class="trow">
    <div class="rank">${i+1}</div>
    <div><div class="pname">${p.title}</div><div class="pcat">${p.cat}</div></div>
    <div class="num">${money(p.net)}</div>
    <div class="num dim">${numf(p.items)}</div>
    <div class="num dim">${numf(p.orders)}</div>
    <div class="share">${pct(p.net/t.wd.net*100,1)}</div>
  </div>`).join('');
  wrap.innerHTML=html;
}
// Category Trends: net sales by category across the last 12 months (independent of
// the 7/30/90 KPI selector — this is the over-time view). Top 6 categories get their
// own line; everything else folds into "Other". Toggle net $ vs mix % (100% stacked).
function trendSeries(){
  const cm = D.catMonthly || [];
  const labels = cm.map(r=>r.m);
  const tot={};
  cm.forEach(r=>Object.entries(r.cats).forEach(([k,v])=>tot[k]=(tot[k]||0)+v));
  const ranked = Object.keys(tot).filter(k=>k!=='other').sort((a,b)=>tot[b]-tot[a]);
  const top = ranked.slice(0,6);
  const keys = top.concat(['other']);                    // 'other' always last, absorbs the tail
  const val = (r,k)=> k==='other'
    ? Object.entries(r.cats).reduce((a,[ck,cv])=>a+((top.includes(ck))?0:cv),0)   // tail + real other
    : (r.cats[k]||0);
  const monthTot = cm.map(r=>Object.values(r.cats).reduce((a,b)=>a+b,0));
  return {labels, keys, series:keys.map(k=>cm.map((r,i)=>{
    const v=val(r,k); return S.trendMode==='share' ? (monthTot[i]? v/monthTot[i]*100 : 0) : v;
  }))};
}
function renderTrend(){
  if(!D || !D.catMonthly) return;
  const share = S.trendMode==='share';
  const {labels, keys, series} = trendSeries();
  const name = k => KEYS[k] || (k==='other'?'Other':k);
  const datasets = keys.map((k,i)=>{
    const col = CATCOLORS[k] || PALETTE[i%PALETTE.length];
    return {label:name(k), data:series[i], borderColor:col,
      backgroundColor: share ? col+'cc' : col+'22',
      fill: share ? (i===0?'origin':'-1') : false,
      borderWidth: share?1:2.4, tension:.32, pointRadius:0, pointHoverRadius:4, cubicInterpolationMode:'monotone'};
  });
  document.getElementById('trendNote').textContent = share ? 'last 12 months · % of net' : 'last 12 months · net sales';
  const cfg={type:'line', data:{labels, datasets},
    options:{responsive:true, maintainAspectRatio:false, animation:{duration:600},
      interaction:{mode:'index', intersect:false},
      scales:{
        x:{stacked:share, grid:{color:'rgba(255,255,255,0.05)'}, ticks:{color:'#9a9193', font:{size:9.5}}},
        y:{stacked:share, beginAtZero:true, max:share?100:undefined,
           grid:{color:'rgba(255,255,255,0.05)'},
           ticks:{color:'#9a9193', font:{size:9.5},
             callback:v=> share ? v+'%' : (v>=1000?'$'+(v/1000)+'K':'$'+v)}}},
      plugins:{
        legend:{position:'bottom', labels:{color:'#c9c1c2', boxWidth:9, boxHeight:9, font:{size:9.5}, padding:6, usePointStyle:true}},
        tooltip:{callbacks:{label:i=> `${i.dataset.label}: ${share?pct(i.raw,1):money(i.raw)}`}}}}};
  if(charts.trend) charts.trend.destroy();
  charts.trend=new Chart(document.getElementById('trendChart'),cfg);
}
// Top movers = biggest category net-sales change, SELECTED period vs the prior equal
// period. Category data is monthly (catMonthly), so each period maps to a month count:
// 7D/30D → 1 mo, 90D → 3 mo, 12M → 6 mo (only 12 mo of data, so H2-vs-H1).
const MOVER_MONTHS = {3:1, 7:1, 30:1, 90:3, '12M':6};
function moversData(){
  const cm = D.catMonthly || [];
  const n = MOVER_MONTHS[S.win] || 1;
  const curM = cm.slice(-n), prevM = cm.slice(-2*n, -n);
  const agg = ms => { const o={}; ms.forEach(r=>Object.entries(r.cats).forEach(([k,v])=>o[k]=(o[k]||0)+v)); return o; };
  const cur=agg(curM), prev=agg(prevM);
  const rows=[];
  new Set([...Object.keys(cur),...Object.keys(prev)]).forEach(k=>{
    if(k==='other') return;
    const c=cur[k]||0, p=prev[k]||0;
    if(Math.max(c,p) < 3000) return;                       // noise floor — skip tiny categories
    const isNew = p<=0 && c>0;
    const chg = p>0 ? (c-p)/p : (isNew?Infinity:0);
    rows.push({key:k, name:KEYS[k]||k, cur:c, prev:p, chg, isNew});
  });
  return {rows, n, hasPrev: prevM.length>0};
}
function renderMovers(){
  const wrap=document.getElementById('moversWrap');
  const {rows,n,hasPrev} = moversData();
  const per = n===1 ? 'last month vs prior month' : `last ${n} mo vs prior ${n} mo`;
  document.getElementById('moversNote').textContent = ((S.win===7||S.win===3) ? 'monthly data · ' : '') + per;
  if(!hasPrev || !rows.length){
    wrap.innerHTML = `<div class="hrow"><span class="hdot a"></span>
      <span class="hnm" style="grid-column:2 / -1">Not enough history for a period comparison</span></div>`;
    return;
  }
  const top = rows.sort((a,b)=>Math.abs(b.chg)-Math.abs(a.chg)).slice(0,5);
  wrap.innerHTML = top.map(x=>{
    const cls = x.chg>0.05?'g':x.chg<-0.05?'b':'a';
    const txt = x.isNew ? 'NEW' : `${x.chg>=0?'+':''}${(x.chg*100).toFixed(0)}%`;
    return `<div class="hrow"><span class="hdot ${cls}"></span>
      <span class="hnm">${x.name}</span>
      <span class="hval ${cls}-t">${txt}</span>
      <small class="mv-sub">${money(x.cur)}</small></div>`;
  }).join('');
}
function renderFooter(){
  document.getElementById('footSource').innerHTML=`Source: ${D.meta.source} · <b>${D.meta.currency}</b> · trailing period`;
}

/* ---- live / wiring / init ---- */
function setLive(mode){ const dot=document.getElementById('liveDot'),txt=document.getElementById('liveText');
  dot.className='dot '+(mode==='live'?'live':mode==='loading'?'loading':'snap'); txt.textContent=mode==='live'?'Live':mode==='loading'?'Syncing…':'Snapshot'; }
function wire(){
  document.querySelectorAll('#winSeg button').forEach(b=>b.onclick=()=>{
    const v=b.dataset.win; S.win = v==='12M'?'12M':parseInt(v,10); render();
  });
  document.querySelectorAll('#trendMode button').forEach(b=>b.onclick=()=>{
    S.trendMode=b.dataset.mode;
    document.querySelectorAll('#trendMode button').forEach(x=>x.classList.toggle('active',x===b));
    renderTrend();
  });
  window.addEventListener('resize',()=>{clearTimeout(window._rz);window._rz=setTimeout(()=>{render();renderTrend();},200);});
}
// Upgrade to live Shopify data when the API is reachable; keep the snapshot otherwise.
async function tryLive(){
  setLive('loading');
  try{
    const r=await fetch('/api/shopify?dataset=products'); if(!r.ok) throw 0;
    const j=await r.json(); if(!j||j.error||!j.windows||!j.catMonthly) throw 0;
    D=window.DL_SHOPIFY=j;
    render(); renderTrend(); setLive('live');
  }catch(e){ setLive('snap'); }   // 404 locally / any error → embedded snapshot
}
(function init(){
  if(!D){ document.getElementById('errBox').classList.add('show'); return; }
  wire(); render(); renderTrend(); setLive('snap');
  if(window.DLmotion) DLmotion.entrance();
  tryLive();
})();
