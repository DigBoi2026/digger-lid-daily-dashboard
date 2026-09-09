/* =========================================================================
   DiggerLid — Region Performance (Shopify shipping geography). Read-only.
   AU vs international, AU state breakdown + trends, NZ spotlight.
   Geo data is monthly, so the period selector maps to whole months.
   ========================================================================= */
let R = window.DL_REGION || null;
const S = { win: 12, off: 0, stateMode: 'net', auMode: 'split' };     // win = months; default to the 12-month view
const COUNTRY_COL = {"Australia":'#f5eb19',"United States":'#5ec8ff',"New Zealand":'#39d98a',
  "United Kingdom":'#ff8a4a',"Canada":'#c98bff',"Other":'#7d7576'};
let charts = { auIntl:null, stateTrend:null, nz:null };
const { sparkline } = DLcore;                             // shared, unit-tested sparkline

const money=(n,c=true)=>{ if(n==null||isNaN(n))return '—';
  if(c){const a=Math.abs(n); if(a>=1e6)return '$'+(n/1e6).toFixed(2)+'M'; if(a>=1e3)return '$'+(n/1e3).toFixed(a>=1e4?0:1)+'K'; return '$'+Math.round(n);}
  return n.toLocaleString('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0}); };
const numf=n=>n==null||isNaN(n)?'—':Math.round(n).toLocaleString('en-AU');
const pct=(n,d=0)=>n==null||isNaN(n)?'—':n.toFixed(d)+'%';

/* S.win IS a month count on this page. It used to be a day count mapped onto
   months by MREG = {3:1, 7:1, 30:1, 90:3, '12M':12}, which collapsed 3D, 7D and
   30D onto the same single month: all three rendered identical figures under
   headlines reading "LAST 3 DAYS" and "LAST 7 DAYS". The underlying Shopify
   shipping-geo report only ever returns whole months, so the day buttons could
   not be honoured and have been removed rather than relabelled. */
const WLABEL = {1:'LAST MONTH', 3:'LAST 3 MONTHS', 12:'LAST 12 MONTHS'};
const STATE_COL = {NSW:'#f5eb19',QLD:'#c98bff',VIC:'#5ec8ff',WA:'#ff8a4a',SA:'#39d98a',TAS:'#ffb020',ACT:'#e0607a',NT:'#9a9193'};

const sum = a => (a||[]).reduce((x,y)=>x+y,0);
// cur / prev month-count slices over a monthly array
function slices(arr, n){ const c=arr.slice(-n), p=arr.length>=2*n?arr.slice(-2*n,-n):null; return {cur:c, prev:p}; }
const netOf = m => m.net;

/* ============================ RENDER ============================ */
function render(){
  if(!R){ document.getElementById('errBox').classList.add('show'); return; }
  const n = Number(S.win) || 12;
  document.getElementById('winLabel').textContent = WLABEL[n] || `LAST ${n} MONTHS`;
  document.getElementById('throughVal').textContent = R.months[R.months.length-1];
  document.querySelectorAll('#winSeg button').forEach(b=>b.classList.toggle('active', parseInt(b.dataset.win,10)===n));
  /* At 12 months there is no prior 12 months in the pull (slices() returns
     prev=null below 2n), so no row can show a change — the note used to promise
     "vs prior yr" over a list that had none. Sparklines are always the full 12
     months regardless of the selector, which is deliberate for trend context but
     was nowhere stated. */
  document.getElementById('stateNote').textContent =
    (n===12 ? 'net · share · no prior year in this pull' : `net · share · last ${n} mo vs prior ${n}`)
    + ' · sparkline 12 mo';
  renderKPIs(n); renderStates(n); renderAuIntl(); renderStateTrend(); renderNZ(); renderIntl();
  if(window.DLmotion) DLmotion.countUpAll();
}

function kpiTile(lbl,val,sub,foot,accent,sparkKey){
  return `<div class="kpi ${accent?'accent':''}"><div class="k-head"><div class="k-lbl">${lbl}</div>
    <div class="k-val">${val}</div><div class="k-sub">${sub||''}</div></div>
    <div class="k-foot">${foot||''}</div>
    ${sparkKey?`<canvas class="spark" data-key="${sparkKey}"></canvas>`:''}</div>`;
}
// Delta foot — renders only when there's a prior period to compare against.
// At 12M there's no prior 12 months in the pulled window, so the foot stays empty.
function footDelta(cur,prev,perLabel){
  if(cur==null||prev==null||prev===0) return '';
  const chg=(cur-prev)/Math.abs(prev)*100, cls=Math.abs(chg)<0.05?'flat':chg>0?'up':'down', ar=chg>0.05?'▲':chg<-0.05?'▼':'—';
  return `<span class="delta ${cls}">${ar} ${Math.abs(chg).toFixed(1)}%</span><span class="k-per">${perLabel}</span>`;
}
function renderKPIs(n){
  const el=document.getElementById('kpis');
  const auN=R.au.monthly.map(netOf), auO=R.au.monthly.map(m=>m.orders), tot=R.totalMonthly, nz=R.nz.monthly.map(netOf), nzO=R.nz.monthly.map(m=>m.orders);
  const au=slices(auN,n), to=slices(tot,n), nzs=slices(nz,n), auOr=slices(auO,n), nzOr=slices(nzO,n);
  /* International is total minus Australia, from two separate ShopifyQL queries.
     It has never gone negative (the smallest month is +$9.7k) but rounding or an
     attribution change between the two could make it so, and the sparkline below
     already clamps at zero — do the same here so the tile and its own sparkline
     cannot disagree about the sign. */
  const auCur=sum(au.cur), totCur=sum(to.cur), intlCur=Math.max(0, totCur-auCur);
  const auPrev=au.prev?sum(au.prev):null, totPrev=to.prev?sum(to.prev):null, intlPrev=(totPrev!=null&&au.prev)?totPrev-sum(au.prev):null;
  const nzCur=sum(nzs.cur), nzPrev=nzs.prev?sum(nzs.prev):null;
  const auOrders=sum(auOr.cur), auAov=auOrders?auCur/auOrders:0;
  // top state over the period
  const st=R.au.states.map(s=>({...s, cur:sum(slices(R.au.stateMonthly[s.abbr],n).cur)})).sort((a,b)=>b.cur-a.cur);
  const top=st[0];
  const perLbl=`vs prior ${n===12?'yr':n+' mo'}`;
  // 12-month monthly series for the KPI sparklines (trend context, independent of the selector)
  const intlMonthly=R.totalMonthly.map((t,i)=>Math.max(0,t-auN[i]));
  const sparks={au:auN, intl:intlMonthly, nz, auOrders:auO};
  el.innerHTML=[
    kpiTile('Australia', money(auCur), `<b>${pct(totCur?auCur/totCur*100:0)}</b> of total`, footDelta(auCur,auPrev,perLbl), true, 'au'),
    kpiTile('International', money(intlCur), `<b>${pct(totCur?intlCur/totCur*100:0)}</b> of total`, footDelta(intlCur,intlPrev,perLbl), false, 'intl'),
    kpiTile('Top State', top?top.abbr:'—', top?`${top.name} · <b>${pct(auCur?top.cur/auCur*100:0)}</b> of AU`:'', '', false),
    kpiTile('New Zealand', money(nzCur), `${numf(sum(nzOr.cur))} orders`, footDelta(nzCur,nzPrev,perLbl), false, 'nz'),
    kpiTile('AU Orders', numf(auOrders), `AOV <b>${money(auAov)}</b>`, footDelta(auOrders, auOr.prev?sum(auOr.prev):null, perLbl), false, 'auOrders'),
    // No "+": api/shopify.js returns every country with net sales above zero, so
    // this is the exact count, and the suffix read as "at least this many".
    kpiTile('Countries', numf(R.countries.length), 'shipped to · 12 mo', '', false),
  ].join('');
  el.querySelectorAll('canvas.spark').forEach(cv=>sparkline(cv, sparks[cv.dataset.key], null));
}

// single-line geo row: share-bar + name · sparkline · net + share (shared by both lists)
function geoRow({name, net, sub, col, barW, title}){
  return `<div class="catrow rg3" title="${title||''}">
    <div class="bar" style="width:${Math.max(barW,1.5)}%;background:linear-gradient(90deg,${col}3a,${col}0f);border-right:2px solid ${col}"></div>
    <div class="cinfo"><div class="cname">${name}</div></div>
    <canvas class="rgspark"></canvas>
    <div class="cright"><span class="cnet">${net}</span><span class="cshare">${sub}</span></div>
  </div>`;
}
function drawSparks(wrap, seriesList){
  wrap.querySelectorAll('.rgspark').forEach((cv,i)=>sparkline(cv, seriesList[i], null));
}
function renderStates(n){
  const wrap=document.getElementById('stateList');
  const list=R.au.states.map(s=>{
    const sl=slices(R.au.stateMonthly[s.abbr],n);
    return {...s, cur:sum(sl.cur), prev:sl.prev?sum(sl.prev):null};
  }).sort((a,b)=>b.cur-a.cur);
  const auTot=list.reduce((a,s)=>a+s.cur,0)||1, maxV=Math.max(...list.map(s=>s.cur),1);
  wrap.innerHTML=list.map(s=>{
    const share=s.cur/auTot*100, col=STATE_COL[s.abbr];
    const chg=(s.prev!=null&&s.prev>0)?(s.cur-s.prev)/s.prev*100:null;
    const chgTxt=chg==null?'':` <span class="${chg>=0?'g-t':'b-t'}">${chg>=0?'+':''}${chg.toFixed(0)}%</span>`;
    return geoRow({name:`${s.abbr} · ${s.name}`, net:money(s.cur), sub:`${pct(share)}${chgTxt}`,
      col, barW:s.cur/maxV*100, title:`${s.name}: ${numf(s.orders)} orders · ${numf(s.items)} units (12 mo)`});
  }).join('');
  drawSparks(wrap, list.map(s=>R.au.stateMonthly[s.abbr]));
}

// AU vs International — stacked area over 12 months. Toggle:
//  split   → Australia vs one International band
//  country → Australia + each top country (US/NZ/UK/CA/Other) stacked
function renderAuIntl(){
  const byCountry = S.auMode==='country';
  const labels=R.months, au=R.au.monthly.map(netOf);
  let series;   // [{label, data, col}] bottom→top
  if(byCountry){
    // clamp the odd refund month (e.g. UK May) to 0 — a stacked composition shouldn't go negative
    series = Object.entries(R.countryMonthly).map(([c,arr])=>({label:c, data:arr.map(v=>Math.max(0,v)), col:COUNTRY_COL[c]||'#7d7576'}));
  } else {
    const intl=R.totalMonthly.map((t,i)=>Math.max(0,t-au[i]));
    series=[{label:'Australia', data:au, col:'#f5eb19'},{label:'International', data:intl, col:'#5ec8ff'}];
  }
  document.getElementById('auIntlNote').textContent = byCountry ? 'net sales by country · 12 mo' : 'net sales · 12 mo';
  const cfg={type:'line', data:{labels, datasets:series.map((s,i)=>({
      label:s.label, data:s.data, borderColor:s.col, backgroundColor:s.col+(byCountry?'cc':'59'),
      fill: i===0?'origin':'-1', borderWidth: byCountry?1:2, tension:.32, pointRadius:0, pointHoverRadius:4, cubicInterpolationMode:'monotone'}))},
    options:{responsive:true, maintainAspectRatio:false, animation:{duration:600}, interaction:{mode:'index',intersect:false},
      scales:{x:{stacked:true, grid:{color:'rgba(255,255,255,0.05)'}, ticks:{color:'#9a9193', font:{size:9.5}}},
              y:{stacked:true, beginAtZero:true, min:0, grid:{color:'rgba(255,255,255,0.05)'}, ticks:{color:'#9a9193', font:{size:9.5}, callback:v=>v>=1000?'$'+(v/1000)+'K':'$'+v}}},
      plugins:{legend:{position:'bottom', labels:{color:'#c9c1c2', boxWidth:9, boxHeight:9, font:{size:byCountry?9:10}, padding:byCountry?6:8, usePointStyle:true}},
        tooltip:{callbacks:{label:i=>{const t=R.totalMonthly[i.dataIndex]; return `${i.dataset.label}: ${money(i.raw)} (${pct(t?i.raw/t*100:0)})`;}}}}}};
  if(charts.auIntl) charts.auIntl.destroy();
  charts.auIntl=new Chart(document.getElementById('auIntlChart'), cfg);
}

// State trends — top 5 states as lines + Other, 12 months.
// Toggle: net $ (lines) or % of total (share of AU that month, 100% stacked area).
function renderStateTrend(){
  const share = S.stateMode==='share';
  const totals=R.au.states.map(s=>({abbr:s.abbr, t:sum(R.au.stateMonthly[s.abbr])})).sort((a,b)=>b.t-a.t);
  const top=totals.slice(0,5).map(s=>s.abbr), rest=totals.slice(5).map(s=>s.abbr);
  const keys=top.concat(rest.length?['Other']:[]);
  const auMonthTot=R.months.map((_,i)=>R.au.states.reduce((a,s)=>a+R.au.stateMonthly[s.abbr][i],0));
  const rawSeries=keys.map(k=> k==='Other'
    ? R.months.map((_,i)=>rest.reduce((a,ab)=>a+R.au.stateMonthly[ab][i],0))
    : R.au.stateMonthly[k]);
  const series=rawSeries.map(arr=>arr.map((v,i)=> share ? (auMonthTot[i]? v/auMonthTot[i]*100 : 0) : v));
  document.getElementById('stateTrendNote').textContent = share ? '% of AU · 12 mo' : 'net sales · 12 mo';
  const cfg={type:'line', data:{labels:R.months, datasets:keys.map((k,i)=>{
      const col=STATE_COL[k]||'#7d7576';
      return {label:k, data:series[i], borderColor:col,
        backgroundColor: share ? col+'cc' : 'transparent', fill: share ? (i===0?'origin':'-1') : false,
        borderWidth: share?1:2.2, tension:.32, pointRadius:0, pointHoverRadius:4, cubicInterpolationMode:'monotone'};})},
    options:{responsive:true, maintainAspectRatio:false, animation:{duration:600}, interaction:{mode:'index',intersect:false},
      scales:{x:{stacked:share, grid:{color:'rgba(255,255,255,0.05)'}, ticks:{color:'#9a9193', font:{size:9}}},
              y:{stacked:share, beginAtZero:true, max:share?100:undefined, grid:{color:'rgba(255,255,255,0.05)'},
                 ticks:{color:'#9a9193', font:{size:9}, callback:v=> share ? v+'%' : (v>=1000?'$'+(v/1000)+'K':'$'+v)}}},
      plugins:{legend:{position:'bottom', labels:{color:'#c9c1c2', boxWidth:8, boxHeight:8, font:{size:9}, padding:5, usePointStyle:true}},
        tooltip:{callbacks:{label:i=>`${i.dataset.label}: ${share?pct(i.raw,1):money(i.raw)}`}}}}};
  if(charts.stateTrend) charts.stateTrend.destroy();
  charts.stateTrend=new Chart(document.getElementById('stateTrend'), cfg);
}

// NZ spotlight — monthly bars + growth callouts
function renderNZ(){
  const nz=R.nz.monthly.map(netOf);
  const cfg={type:'bar', data:{labels:R.months, datasets:[{data:nz,
      backgroundColor:R.months.map((_,i)=>i===R.months.length-1?'#39d98a':'rgba(57,217,138,0.45)'),
      borderColor:'#39d98a', borderWidth:1, borderRadius:3}]},
    options:{responsive:true, maintainAspectRatio:false, animation:{duration:600},
      scales:{x:{grid:{display:false}, ticks:{color:'#9a9193', font:{size:8.5}}},
              y:{beginAtZero:true, grid:{color:'rgba(255,255,255,0.05)'}, ticks:{color:'#9a9193', font:{size:9}, callback:v=>'$'+(v/1000)+'K'}}},
      plugins:{legend:{display:false}, tooltip:{callbacks:{label:i=>`${money(i.raw)} · ${R.nz.monthly[i.dataIndex].orders} orders`}}}}};
  if(charts.nz) charts.nz.destroy();
  charts.nz=new Chart(document.getElementById('nzChart'), cfg);
  const tot12=sum(nz), last=nz[nz.length-1], prev=nz[nz.length-2];
  const mom=(prev!=null&&prev)?(last/prev-1)*100:null;
  const intl12=sum(R.totalMonthly)-sum(R.au.monthly.map(netOf));
  document.getElementById('nzStats').innerHTML=[
    ['12-mo net', money(tot12), `${pct(intl12?tot12/intl12*100:0)} of intl`],
    ['Latest month', money(last), R.months[R.months.length-1]],
    // `(mom>=0?'+':'')` treated null as >=0 and rendered "+—".
    ['MoM growth', mom==null?'—':(mom>=0?'+':'')+pct(mom,0), 'vs prior month'],
    ['Orders (12mo)', numf(sum(R.nz.monthly.map(m=>m.orders))), 'shipped to NZ'],
  ].map(([l,v,s])=>`<div class="nzc"><div class="l">${l}</div><div class="v">${v} <small>${s}</small></div></div>`).join('');
}

// International mix — non-AU countries ranked (12-month totals)
// International mix — non-AU countries with 12-month sparklines (from countryMonthly,
// so every row has a trend; the long tail is folded into "Other")
function renderIntl(){
  const wrap=document.getElementById('intlList');
  const rows=Object.entries(R.countryMonthly).filter(([c])=>c!=='Australia')
    .map(([c,arr])=>({c, net:sum(arr), series:arr})).sort((a,b)=>b.net-a.net);
  const tot=rows.reduce((a,r)=>a+r.net,0)||1, maxV=Math.max(...rows.map(r=>r.net),1);
  wrap.innerHTML=rows.map(r=>{
    const col=COUNTRY_COL[r.c]||'#5ec8ff';
    return geoRow({name:r.c, net:money(r.net), sub:`${pct(r.net/tot*100)} of intl`, col, barW:r.net/maxV*100});
  }).join('');
  drawSparks(wrap, rows.map(r=>r.series));
}

/* ---- wiring / init ---- */
function setLive(mode){ const dot=document.getElementById('liveDot'),txt=document.getElementById('liveText');
  dot.className='dot '+(mode==='live'?'live':mode==='loading'?'loading':'snap');
  txt.textContent=mode==='live'?'Live':mode==='loading'?'Syncing…':'Snapshot'; }
function wire(){
  document.querySelectorAll('#winSeg button').forEach(b=>b.onclick=()=>{
    S.win = parseInt(b.dataset.win,10); render();
  });
  document.querySelectorAll('#stateMode button').forEach(b=>b.onclick=()=>{
    S.stateMode=b.dataset.mode;
    document.querySelectorAll('#stateMode button').forEach(x=>x.classList.toggle('active',x===b));
    renderStateTrend();
  });
  document.querySelectorAll('#auIntlMode button').forEach(b=>b.onclick=()=>{
    S.auMode=b.dataset.mode;
    document.querySelectorAll('#auIntlMode button').forEach(x=>x.classList.toggle('active',x===b));
    renderAuIntl();
  });
  window.addEventListener('resize',()=>{clearTimeout(window._rz);window._rz=setTimeout(render,200);});
}
// Upgrade to live Shopify geo data when the API is reachable; keep the snapshot otherwise.
async function tryLive(){
  setLive('loading');
  try{
    const r=await fetch('/api/shopify?dataset=region'); if(!r.ok) throw 0;
    const j=await r.json(); if(!j||j.error||!j.au||!j.countryMonthly) throw 0;
    R=window.DL_REGION=j;
    document.getElementById('footSource').innerHTML=`Source: ${R.meta.source} · <b>${R.meta.currency}</b> · ${R.meta.window}`;
    render(); setLive('live');
  }catch(e){ setLive('snap'); }   // 404 locally / any error → embedded snapshot
}
(function init(){
  if(!R){ document.getElementById('errBox').classList.add('show'); return; }
  document.getElementById('footSource').innerHTML=`Source: ${R.meta.source} · <b>${R.meta.currency}</b> · ${R.meta.window}`;
  wire(); render(); setLive('snap');
  if(window.DLmotion) DLmotion.entrance();
  tryLive();
})();
