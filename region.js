/* =========================================================================
   DiggerLid — Region Performance (Shopify shipping geography). Read-only.
   AU vs international, AU state breakdown + trends, NZ spotlight.
   Geo data is monthly, so the period selector maps to whole months.
   ========================================================================= */
let R = window.DL_REGION || null;
/* The DAILY country feed, separate from R. R (shipping-geo) only ever arrives in
   whole months; this one is per-day, which is the only honest basis for a 7-day
   period. It splits into AU / NZ / everything-else and no further — that is the
   deliberate shape of buildGeo, which avoids a sparse GROUP BY country,day. */
let GEO = window.DL_GEO || null;
const MOM = { days: 7 };
const S = { win: 12, off: 0, stateMode: 'net', auMode: 'split', cmp: 'prev' };  // win = months; cmp = prior N months | same N months last year
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
/* The comparison basis. "prev" is the N months immediately before the current
   window; "ly" is the same N months a year earlier — which needs the pull to
   reach 24 months, so on the 12-month snapshot it returns prev=null and the page
   says "no prior year in this pull" rather than comparing to a fragment. */
function cmpSlices(arr, n, cmp){
  const len=arr.length, cur=arr.slice(len-n);
  let prev=null;
  if(cmp==='ly'){ const e=len-12; if(e-n>=0) prev=arr.slice(e-n, e); }
  else { if(len-2*n>=0) prev=arr.slice(len-2*n, len-n); }
  return {cur, prev};
}
/* The charts and sparklines keep showing the most recent 12 months even when the
   pull holds 24 — the extra year is there for the year-ago lookup, not to double
   every bar. */
const V=12;
const tail = a => (a||[]).slice(-V);
const vMonths = () => R.months.slice(-V);
/* WINDOWED VIEWS. Every panel used to render a fixed 12 months no matter which
   period was selected, so "1 MO" moved the KPIs and the state list and left both
   charts, the NZ panel and the country mix showing a year. These honour S.win.
   Charts still need a few points to read as a trend, so they floor at CH_MIN and
   the note states the span actually drawn rather than implying it is the window. */
const CH_MIN = 3;
const chartN = n => Math.max(Number(n) || 12, CH_MIN);
const lastN = (a, k) => (a || []).slice(-k);
const monthsN = k => R.months.slice(-k);
const spanLbl = k => k === 1 ? '1 mo' : k + ' mo';
/* How many months this pull actually holds — the live route returns 24, the
   committed snapshot 12. Never hard-code either. */
const pullMonths = () => (R.months || []).length;
const netOf = m => m.net;

/* ============================ RENDER ============================ */
const cmpLabel = n => S.cmp==='ly'
  ? (n===12 ? 'vs a year earlier' : `vs the same ${n} mo last year`)
  : (n===12 ? 'vs the prior 12 mo' : `vs the prior ${n} mo`);
const noCmpLabel = () => S.cmp==='ly' ? 'no full prior year in this pull' : 'no prior period in this pull';

function render(){
  if(!R){ document.getElementById('errBox').classList.add('show'); return; }
  const n = Number(S.win) || 12;
  document.getElementById('winLabel').textContent = WLABEL[n] || `LAST ${n} MONTHS`;
  document.getElementById('throughVal').textContent = R.months[R.months.length-1];
  document.querySelectorAll('#winSeg button').forEach(b=>b.classList.toggle('active', parseInt(b.dataset.win,10)===n));
  document.querySelectorAll('#cmpSeg button').forEach(b=>b.classList.toggle('active', b.dataset.cmp===S.cmp));
  const stTest=cmpSlices([0].concat(Array(R.months.length-1).fill(0)), n, S.cmp);
  document.getElementById('stateNote').textContent =
    (stTest.prev ? `net · share · ${cmpLabel(n)}` : `net · share · ${noCmpLabel()}`) + ' · sparkline 12 mo';
  /* One failing panel used to take every panel after it down with it: if the
     AU/Intl chart threw, the state trend, NZ and country mix kept last pass's
     figures under this pass's headline. Isolate each, as gpam.js does. */
  const safe=(name,fn)=>{ try{ fn(); }catch(e){ console.error('region: '+name+' failed', e); } };
  safe('kpis',()=>renderKPIs(n)); safe('states',()=>renderStates(n));
  safe('auIntl',()=>renderAuIntl(n)); safe('stateTrend',()=>renderStateTrend(n));
  safe('nz',()=>renderNZ(n)); safe('intl',()=>renderIntl(n)); safe('momentum',()=>renderMomentum());
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
  const au=cmpSlices(auN,n,S.cmp), to=cmpSlices(tot,n,S.cmp), nzs=cmpSlices(nz,n,S.cmp), auOr=cmpSlices(auO,n,S.cmp), nzOr=cmpSlices(nzO,n,S.cmp);
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
  const st=R.au.states.map(s=>({...s, cur:sum(cmpSlices(R.au.stateMonthly[s.abbr],n,S.cmp).cur)})).sort((a,b)=>b.cur-a.cur);
  const top=st[0];
  const perLbl=cmpLabel(n);
  // 12-month monthly series for the KPI sparklines (trend context, independent of the selector)
  const intlMonthly=R.totalMonthly.map((t,i)=>Math.max(0,t-auN[i]));
  const sparks={au:tail(auN), intl:tail(intlMonthly), nz:tail(nz), auOrders:tail(auO)};
  el.innerHTML=[
    kpiTile('Australia', money(auCur), `<b>${pct(totCur?auCur/totCur*100:0)}</b> of total`, footDelta(auCur,auPrev,perLbl), true, 'au'),
    kpiTile('International', money(intlCur), `<b>${pct(totCur?intlCur/totCur*100:0)}</b> of total`, footDelta(intlCur,intlPrev,perLbl), false, 'intl'),
    kpiTile('Top State', top?top.abbr:'—', top?`${top.name} · <b>${pct(auCur?top.cur/auCur*100:0)}</b> of AU`:'', '', false),
    kpiTile('New Zealand', money(nzCur), `${numf(sum(nzOr.cur))} orders`, footDelta(nzCur,nzPrev,perLbl), false, 'nz'),
    kpiTile('AU Orders', numf(auOrders), `AOV <b>${money(auAov)}</b>`, footDelta(auOrders, auOr.prev?sum(auOr.prev):null, perLbl), false, 'auOrders'),
    // No "+": api/shopify.js returns every country with net sales above zero, so
    // this is the exact count, and the suffix read as "at least this many".
    // R.countries is the whole-pull country list, not the window — label it so.
    kpiTile('Countries', numf(R.countries.length), `shipped to · ${spanLbl(pullMonths())} pull`, '', false),
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
    const sl=cmpSlices(R.au.stateMonthly[s.abbr],n,S.cmp);
    return {...s, cur:sum(sl.cur), prev:sl.prev?sum(sl.prev):null};
  }).sort((a,b)=>b.cur-a.cur);
  const auTot=list.reduce((a,s)=>a+s.cur,0)||1, maxV=Math.max(...list.map(s=>s.cur),1);
  wrap.innerHTML=list.map(s=>{
    const share=s.cur/auTot*100, col=STATE_COL[s.abbr];
    const chg=(s.prev!=null&&s.prev>0)?(s.cur-s.prev)/s.prev*100:null;
    const chgTxt=chg==null?'':` <span class="${chg>=0?'g-t':'b-t'}">${chg>=0?'+':''}${chg.toFixed(0)}%</span>`;
    return geoRow({name:`${s.abbr} · ${s.name}`, net:money(s.cur), sub:`${pct(share)}${chgTxt}`,
      col, barW:s.cur/maxV*100,
      // orders/units come from the whole-pull state query, not the window, so say which.
      title:`${s.name}: ${money(s.cur)} over ${spanLbl(n)} · ${numf(s.orders)} orders · ${numf(s.items)} units across the whole ${spanLbl(pullMonths())} pull`});
  }).join('');
  drawSparks(wrap, list.map(s=>tail(R.au.stateMonthly[s.abbr])));
}

// AU vs International — stacked area over 12 months. Toggle:
//  split   → Australia vs one International band
//  country → Australia + each top country (US/NZ/UK/CA/Other) stacked
function renderAuIntl(n){
  const byCountry = S.auMode==='country';
  const k=chartN(n);
  const labels=monthsN(k), au=lastN(R.au.monthly.map(netOf),k), totV=lastN(R.totalMonthly,k);
  let series;   // [{label, data, col}] bottom→top
  if(byCountry){
    // clamp the odd refund month (e.g. UK May) to 0 — a stacked composition shouldn't go negative
    series = Object.entries(R.countryMonthly).map(([c,arr])=>({label:c, data:lastN(arr,k).map(v=>Math.max(0,v)), col:COUNTRY_COL[c]||'#7d7576'}));
  } else {
    const intl=totV.map((t,i)=>Math.max(0,t-au[i]));
    series=[{label:'Australia', data:au, col:'#f5eb19'},{label:'International', data:intl, col:'#5ec8ff'}];
  }
  document.getElementById('auIntlNote').textContent =
    (byCountry ? 'net sales by country · ' : 'net sales · ') + spanLbl(k) + (k>Number(n) ? ` (window ${spanLbl(Number(n))})` : '');
  const cfg={type:'line', data:{labels, datasets:series.map((s,i)=>({
      label:s.label, data:s.data, borderColor:s.col, backgroundColor:s.col+(byCountry?'cc':'59'),
      fill: i===0?'origin':'-1', borderWidth: byCountry?1:2, tension:.32, pointRadius:0, pointHoverRadius:4, cubicInterpolationMode:'monotone'}))},
    options:{responsive:true, maintainAspectRatio:false, animation:{duration:600}, interaction:{mode:'index',intersect:false},
      scales:{x:{stacked:true, grid:{color:'rgba(255,255,255,0.05)'}, ticks:{color:'#9a9193', font:{size:9.5}}},
              y:{stacked:true, beginAtZero:true, min:0, grid:{color:'rgba(255,255,255,0.05)'}, ticks:{color:'#9a9193', font:{size:9.5}, callback:v=>v>=1000?'$'+(v/1000)+'K':'$'+v}}},
      plugins:{legend:{position:'bottom', labels:{color:'#c9c1c2', boxWidth:9, boxHeight:9, font:{size:byCountry?9:10}, padding:byCountry?6:8, usePointStyle:true}},
        tooltip:{callbacks:{label:i=>{const t=totV[i.dataIndex]; return `${i.dataset.label}: ${money(i.raw)} (${pct(t?i.raw/t*100:0)})`;}}}}}};
  if(charts.auIntl) charts.auIntl.destroy();
  charts.auIntl=new Chart(document.getElementById('auIntlChart'), cfg);
}

// State trends — top 5 states as lines + Other, 12 months.
// Toggle: net $ (lines) or % of total (share of AU that month, 100% stacked area).
function renderStateTrend(n){
  const share = S.stateMode==='share';
  const k=chartN(n);
  const totals=R.au.states.map(s=>({abbr:s.abbr, t:sum(lastN(R.au.stateMonthly[s.abbr],k))})).sort((a,b)=>b.t-a.t);
  const top=totals.slice(0,5).map(s=>s.abbr), rest=totals.slice(5).map(s=>s.abbr);
  const keys=top.concat(rest.length?['Other']:[]);
  const SM={}; R.au.states.forEach(s=>SM[s.abbr]=lastN(R.au.stateMonthly[s.abbr],k));
  const lbl=monthsN(k);
  const auMonthTot=lbl.map((_,i)=>R.au.states.reduce((a,s)=>a+SM[s.abbr][i],0));
  const rawSeries=keys.map(k=> k==='Other'
    ? lbl.map((_,i)=>rest.reduce((a,ab)=>a+SM[ab][i],0))
    : SM[k]);
  const series=rawSeries.map(arr=>arr.map((v,i)=> share ? (auMonthTot[i]? v/auMonthTot[i]*100 : 0) : v));
  document.getElementById('stateTrendNote').textContent =
    (share ? '% of AU · ' : 'net sales · ') + spanLbl(k) + (k>Number(n) ? ` (window ${spanLbl(Number(n))})` : '');
  const cfg={type:'line', data:{labels:lbl, datasets:keys.map((k,i)=>{
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
function renderNZ(n){
  const k=chartN(n), w=Number(n)||12;
  const nz=lastN(R.nz.monthly.map(netOf),k), nzV=R.nz.monthly.slice(-k), lbl=monthsN(k);
  document.getElementById('nzNote').textContent = `New Zealand · ${spanLbl(w)}` + (k>w ? ` · chart ${spanLbl(k)}` : '');
  const cfg={type:'bar', data:{labels:lbl, datasets:[{data:nz,
      backgroundColor:lbl.map((_,i)=>i===lbl.length-1?'#39d98a':'rgba(57,217,138,0.45)'),
      borderColor:'#39d98a', borderWidth:1, borderRadius:3}]},
    options:{responsive:true, maintainAspectRatio:false, animation:{duration:600},
      scales:{x:{grid:{display:false}, ticks:{color:'#9a9193', font:{size:8.5}}},
              y:{beginAtZero:true, grid:{color:'rgba(255,255,255,0.05)'}, ticks:{color:'#9a9193', font:{size:9}, callback:v=>'$'+(v/1000)+'K'}}},
      plugins:{legend:{display:false}, tooltip:{callbacks:{label:i=>`${money(i.raw)} · ${nzV[i.dataIndex].orders} orders`}}}}};
  if(charts.nz) charts.nz.destroy();
  charts.nz=new Chart(document.getElementById('nzChart'), cfg);
  /* Every figure here is the SELECTED window. The orders tile used to sum
     R.nz.monthly whole — 24 months on a live pull — under a "(12mo)" label. */
  const last=nz[nz.length-1], prev=nz[nz.length-2];
  const mom=(prev!=null&&prev)?(last/prev-1)*100:null;
  const netWin=sum(lastN(R.nz.monthly.map(netOf),w));
  const ordWin=sum(lastN(R.nz.monthly,w).map(m=>m.orders));
  const intlWin=sum(lastN(R.totalMonthly,w))-sum(lastN(R.au.monthly.map(netOf),w));
  document.getElementById('nzStats').innerHTML=[
    [`Net · ${spanLbl(w)}`, money(netWin), `${pct(intlWin?netWin/intlWin*100:0)} of intl`],
    ['Latest month', money(last), monthsN(1)[0]],
    // `(mom>=0?'+':'')` treated null as >=0 and rendered "+—".
    ['MoM growth', mom==null?'—':(mom>=0?'+':'')+pct(mom,0), 'vs prior month'],
    [`Orders · ${spanLbl(w)}`, numf(ordWin), 'shipped to NZ'],
  ].map(([l,v,s])=>`<div class="nzc"><div class="l">${l}</div><div class="v">${v} <small>${s}</small></div></div>`).join('');

}

// International mix — non-AU countries ranked (12-month totals)
// International mix — non-AU countries with 12-month sparklines (from countryMonthly,
// so every row has a trend; the long tail is folded into "Other")
function renderIntl(n){
  const wrap=document.getElementById('intlList'), w=Number(n)||12;
  /* Totals follow the window; the sparkline keeps its 12-month run so a short
     window still shows where the country has been. */
  const rows=Object.entries(R.countryMonthly).filter(([c])=>c!=='Australia')
    .map(([c,arr])=>({c, net:sum(lastN(arr,w)), series:tail(arr)})).sort((a,b)=>b.net-a.net);
  const tot=rows.reduce((a,r)=>a+r.net,0)||1, maxV=Math.max(...rows.map(r=>r.net),1);
  wrap.innerHTML=rows.map(r=>{
    const col=COUNTRY_COL[r.c]||'#5ec8ff';
    return geoRow({name:r.c, net:money(r.net), sub:`${pct(r.net/tot*100)} of intl`, col, barW:r.net/maxV*100,
      title:`${r.c}: ${money(r.net)} over ${spanLbl(w)} · sparkline ${spanLbl(Math.min(V,pullMonths()))}`});
  }).join('');
  drawSparks(wrap, rows.map(r=>r.series));
  const note=document.getElementById('intlNote'); if(note) note.textContent = `net sales · ${spanLbl(w)} · sparkline ${spanLbl(Math.min(V,pullMonths()))}`;
}

/* Weekly momentum — the last N days against the N days before them, by country.
   Daily, so a 7-day period here means seven days and not a month wearing a day's
   label (which is why the day buttons were removed from the month selector). */
function momSlices(daily, d){
  const rows = daily || [];
  return { cur: rows.slice(-d), prev: rows.length >= 2*d ? rows.slice(-2*d, -d) : null };
}
function renderMomentum(){
  const wrap=document.getElementById('momList'), note=document.getElementById('momNote');
  if(!wrap) return;
  document.querySelectorAll('#momSeg button').forEach(b=>b.classList.toggle('active', +b.dataset.days===MOM.days));
  const daily = GEO && Array.isArray(GEO.daily) ? GEO.daily : [];
  const d = MOM.days;
  if(daily.length < d){
    wrap.innerHTML=`<div class="momempty">Daily country figures come from the live feed. The committed snapshot on this page is monthly only, so momentum fills in once <code>/api/shopify?dataset=geo</code> is reachable.</div>`;
    note.textContent='daily feed unavailable'; return;
  }
  const {cur, prev} = momSlices(daily, d);
  const S_=(rows,k)=>rows.reduce((a,r)=>a+(+r[k]||0),0);
  const defs=[['Australia','au'],['New Zealand','nz'],['International','other'],['Total','total']];
  const deltas=defs.map(([,k])=>{ const c=S_(cur,k), p=prev?S_(prev,k):null; return p!=null?c-p:0; });
  const maxAbs=Math.max(1,...deltas.map(Math.abs));
  wrap.innerHTML=defs.map(([label,k],i)=>{
    const c=S_(cur,k), p=prev?S_(prev,k):null, dv=p!=null?c-p:null;
    const chg=(p!=null&&p!==0)?(c-p)/Math.abs(p)*100:null;
    const w=dv!=null?Math.abs(dv)/maxAbs*50:0, neg=dv!=null&&dv<0;
    const cls=dv==null?'':neg?'down':'up';
    return `<div class="momrow ${cls}${k==='total'?' tot':''}" title="${label}: ${money(c,false)} in the last ${d} days${p!=null?` vs ${money(p,false)} the ${d} days before`:''}">
      <div class="mom-n">${label}<i>${money(c)}${p!=null?` vs ${money(p)}`:''}</i></div>
      <div class="mom-t"><s></s><i style="left:${(neg?50-w:50).toFixed(1)}%;width:${w.toFixed(1)}%"></i></div>
      <div class="mom-v">${chg==null?'—':(chg>=0?'+':'')+chg.toFixed(1)+'%'}<small>${dv==null?'no prior '+d+'d':(dv>=0?'+':'')+money(dv)}</small></div>
    </div>`;
  }).join('');
  const lastDay = daily[daily.length-1].date;
  note.textContent = prev ? `${d}d vs prev ${d}d · to ${lastDay}` : `${d}d · no prior ${d}d in the feed`;
}

/* ---- wiring / init ---- */
function setLive(mode){ const dot=document.getElementById('liveDot'),txt=document.getElementById('liveText');
  dot.className='dot '+(mode==='live'?'live':mode==='loading'?'loading':'snap');
  txt.textContent=mode==='live'?'Live':mode==='loading'?'Syncing…':'Snapshot'; }
function wire(){
  document.querySelectorAll('#winSeg button').forEach(b=>b.onclick=()=>{
    S.win = parseInt(b.dataset.win,10); render();
  });
  document.querySelectorAll('#cmpSeg button').forEach(b=>b.onclick=()=>{ S.cmp=b.dataset.cmp; render(); });
  document.querySelectorAll('#momSeg button').forEach(b=>b.onclick=()=>{ MOM.days=+b.dataset.days; renderMomentum(); });
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
    R=window.DL_REGION=j; DLcore.stampSnapshotAge(null);   // live now — age no longer the story
    document.getElementById('footSource').innerHTML=`Source: ${R.meta.source} · <b>${R.meta.currency}</b> · ${R.meta.window}`;
    render(); setLive('live');
  }catch(e){ setLive('snap'); }   // 404 locally / any error → embedded snapshot
}
/* The daily feed is a second, independent route: the page is fully usable from the
   monthly snapshot without it, so a failure here only leaves the momentum panel
   in its stated empty state. */
async function tryGeo(){
  try{
    const r=await fetch('/api/shopify?dataset=geo'); if(!r.ok) throw 0;
    const j=await r.json(); if(!j || j.error || !Array.isArray(j.daily) || !j.daily.length) throw 0;
    GEO=window.DL_GEO=j; renderMomentum();
  }catch(e){ /* keep the empty state the panel already renders */ }
}
(function init(){
  if(!R){ document.getElementById('errBox').classList.add('show'); return; }
  document.getElementById('footSource').innerHTML=`Source: ${R.meta.source} · <b>${R.meta.currency}</b> · ${R.meta.window}`;
  wire(); render(); setLive('snap');
  DLcore.stampSnapshotAge(R.meta);   // say how old the fallback is, on the pill
  if(window.DLmotion) DLmotion.entrance();
  tryLive(); tryGeo();
})();
