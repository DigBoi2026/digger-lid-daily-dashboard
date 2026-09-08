/* =========================================================================
   DiggerLid — Performance Marketing (Meta / paid media).
   Reads data.js (window.DL_DATA). Same rolling-window + period-comparison UX
   as Daily Ops, focused on paid-media efficiency. Read-only.
   ========================================================================= */
// Shared math/utilities from core.js (unit-tested by source/test_core.js).
const { MONTH_ABBR, isoToNice, fmtRange, rollingAvg, periodSlices, aggregate, breakeven, sparkline } = DLcore;
const S = { win:30, off:0, metric:'spend_rev', live:'snap' };   // win ∈ {7,30,90,'12M'}
let DATA = window.DL_DATA || null;
let charts = { band:null, trend:null, prosp:null, chan:null };

/* ---- formatters (page-local; differ slightly per page) ---- */
const money=(n,c=false)=>{ if(n==null||isNaN(n))return '—';
  if(c){const a=Math.abs(n); if(a>=1e6)return '$'+(n/1e6).toFixed(2)+'M'; if(a>=1e3)return '$'+(n/1e3).toFixed(a>=1e4?0:1)+'K'; return '$'+Math.round(n);}
  return n.toLocaleString('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0}); };
const pct=(n,d=1)=>n==null||isNaN(n)?'—':n.toFixed(d)+'%';
const numf=n=>n==null||isNaN(n)?'—':Math.round(n).toLocaleString('en-AU');
const xroas=n=>n==null||isNaN(n)?'—':n.toFixed(2)+'x';
const yesterdayISO=()=>{const t=new Date();t.setDate(t.getDate()-1);t.setHours(0,0,0,0);return t.toISOString().slice(0,10);};

const BETTER={metaTotal:'neutral',metaNew:'neutral',totalAds:'neutral',mer:'low',ncpa:'low',cpp:'low',
  roas:'high',revenue:'high',newOrders:'high',newPct:'high',profit:'high'};
function deltaEl(cur,prev,key){
  if(cur==null||prev==null||prev===0) return '<span class="delta flat">—</span>';
  const chg=(cur-prev)/Math.abs(prev)*100, dir=BETTER[key]||'high';
  let cls='flat';
  if(Math.abs(chg)<0.05) cls='flat'; else if(dir==='neutral') cls='flat';
  else cls=(dir==='high'?chg>0:chg<0)?'up':'down';
  const ar=chg>0.05?'▲':chg<-0.05?'▼':'—';
  return `<span class="delta ${cls}">${ar} ${Math.abs(chg).toFixed(1)}%</span>`;
}
function clampToYesterday(){
  const maxISO=(yesterdayISO()<DATA.meta.latestDataDate)?yesterdayISO():DATA.meta.latestDataDate;
  let idx=DATA.daily.length-1;
  for(let i=DATA.daily.length-1;i>=0;i--){if(DATA.daily[i].date<=maxISO){idx=i;break;}}
  return idx;
}
function ctx(){
  if(S.win==='12M'){
    const list=DATA.monthly;
    return {rec:aggregate(list),prev:null,series:list,prevSeries:null,gran:'month',
      title:'Last 12 months',sub:'2026 YTD',periodLabel:'2026 YTD',win:'12M'};
  }
  const P=S.win, sl=periodSlices(DATA.daily, clampToYesterday(), P, S.off);
  S.off=sl.off;
  const cur=sl.cur, prevSeries=sl.prev;
  return {rec:aggregate(cur),prev:prevSeries.length?aggregate(prevSeries):null,series:cur,prevSeries,gran:'day',
    title:fmtRange(cur[0].date,cur[cur.length-1].date),
    sub:`${P}-day period${S.off?` · ${S.off} back`:''}`,periodLabel:`vs prior ${P}d`,win:P};
}

/* ============================ RENDER ============================ */
function render(){
  if(!DATA||!DATA.daily||!DATA.daily.length){document.getElementById('errBox').classList.add('show');return;}
  const c=ctx();
  renderHeader(c); renderKPIs(c); renderBand(c); renderTrend(c); renderAcq(c); renderFunnel(); renderStageRoas(); renderFooter();
  if(window.DLmotion) DLmotion.countUpAll();
}
function renderHeader(c){
  document.getElementById('navDate').textContent=c.title;
  document.getElementById('navDow').textContent=c.sub;
  document.getElementById('throughVal').textContent=isoToNice(DATA.meta.latestDataDate)+' 2026';
  const prevB=document.getElementById('prevBtn'), nextB=document.getElementById('nextBtn');
  if(S.win==='12M'){ prevB.disabled=true; nextB.disabled=true; }
  else { const P=S.win, end=clampToYesterday(); nextB.disabled=S.off<=0; prevB.disabled=(end-(S.off+1)*P+1)<0; }
}
function kpiTile(lbl,val,sub,foot,accent,sparkKey){
  return `<div class="kpi ${accent?'accent':''}"><div class="k-head"><div class="k-lbl">${lbl}</div>
    <div class="k-val">${val}</div><div class="k-sub">${sub||''}</div></div>
    <div class="k-foot">${foot||''}</div>
    ${sparkKey?`<canvas class="spark" data-key="${sparkKey}"></canvas>`:''}</div>`;
}
function renderKPIs(c){
  const r=c.rec,p=c.prev,el=document.getElementById('kpis');
  const per=`<span class="k-per">${c.periodLabel}</span>`, foot=(a,b,k)=>deltaEl(a,b,k)+per;
  const bk=breakeven(r);
  const share=r.metaTotal?(r.metaNew/r.metaTotal*100):0;
  el.innerHTML=[
    kpiTile('Total Meta Spend',money(r.metaTotal,true),`Total ads <b>${money(r.totalAds,true)}</b>`,foot(r.metaTotal,p&&p.metaTotal,'metaTotal'),true,'metaTotal'),
    kpiTile('Sitewide ROAS',xroas(r.roas),`MER <b>${pct(r.mer)}</b>`,foot(r.roas,p&&p.roas,'roas'),false,'roas'),
    kpiTile('MER',pct(r.mer),bk?`b/e <b class="${bk.zone}-t">${pct(bk.full,0)}</b>`:'',foot(r.mer,p&&p.mer,'mer'),false,'mer'),
    kpiTile('New-Cust CPA',money(r.ncpa),`All-cust CPP <b>${money(r.cpp)}</b>`,foot(r.ncpa,p&&p.ncpa,'ncpa'),false,'ncpa'),
    kpiTile('Prospecting Spend',money(r.metaNew,true),`<b>${pct(share,0)}</b> of Meta spend`,foot(r.metaNew,p&&p.metaNew,'metaNew'),false,'metaNew'),
    kpiTile('New Customers',numf(r.newOrders),`<b>${pct(r.newPct,0)}</b> of orders`,foot(r.newOrders,p&&p.newOrders,'newOrders'),false,'newOrders'),
  ].join('');
  el.querySelectorAll('canvas.spark').forEach(cv=>{
    const key=cv.dataset.key;
    sparkline(cv, c.series.map(d=>d[key]), c.prevSeries?c.prevSeries.map(d=>d[key]):null);
  });
}

/* ---- MER breakeven band ---- */
function renderBand(c){
  const s=c.series, Y=id=>s.map(d=>d[id]);
  const beFull=s.map(d=>{const b=breakeven(d);return b?b.full:null;});
  const beCash=s.map(d=>{const b=breakeven(d);return b?b.contrib:null;});
  const merv=Y('mer');
  const cap=Math.ceil(Math.max(60,...merv.filter(v=>v!=null),...beCash.filter(v=>v!=null))*1.05/10)*10;
  const labels=s.map(d=>c.gran==='day'?isoToNice(d.date):d.month);
  const ds=[
    {label:'Profit breakeven',data:beFull,borderColor:'rgba(57,217,138,.55)',borderDash:[5,3],borderWidth:1.5,pointRadius:0,fill:'origin',backgroundColor:'rgba(57,217,138,.10)',tension:.2,order:9},
    {label:'Cash breakeven',data:beCash,borderColor:'rgba(255,176,32,.55)',borderDash:[5,3],borderWidth:1.5,pointRadius:0,fill:'-1',backgroundColor:'rgba(255,176,32,.13)',tension:.2,order:9},
    {label:'',data:s.map(()=>cap),borderWidth:0,pointRadius:0,fill:'-1',backgroundColor:'rgba(255,90,82,.10)',order:9},
    {label:'MER %',data:merv,borderColor:'#f5eb19',borderWidth:2.5,pointRadius:0,tension:.3,order:1},
  ];
  const cfg={type:'line',data:{labels,datasets:ds},options:{responsive:true,maintainAspectRatio:false,animation:{duration:500},
    interaction:{mode:'index',intersect:false},
    plugins:{legend:{display:true,labels:{color:'#c9c1c2',boxWidth:10,font:{size:10},filter:it=>!!it.text}},
      tooltip:{filter:i=>!!i.dataset.label,callbacks:{label:i=>i.dataset.label+': '+pct(i.raw)}}},
    scales:{y:{min:0,max:cap,grid:{color:'rgba(255,255,255,.05)'},ticks:{color:'#9a9193',font:{size:9},callback:v=>v+'%'}},
      x:{grid:{display:false},ticks:{color:'#9a9193',font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12}}}}};
  if(charts.band) charts.band.destroy();
  charts.band=new Chart(document.getElementById('merBand'),cfg);
  const bk=breakeven(c.rec);
  document.getElementById('beVal').textContent=bk?pct(bk.full,1):'—';
  const sc=document.getElementById('signalCell'), sv=document.getElementById('signalVal');
  sv.textContent=bk?bk.signal:'—';
  sc.className='eq-cell'; if(bk){ sv.className='v '+bk.zone+'-t'; }
  document.getElementById('bandNote').textContent=bk?`MER ${pct(bk.mer)} · headroom ${bk.headroom>=0?'+':''}${bk.headroom.toFixed(1)}pt`:'MER vs breakeven';
}

/* ---- trend ---- */
function renderTrend(c){
  const s=c.series, Y=id=>s.map(d=>d[id]);
  const labels=s.map(d=>c.gran==='day'?isoToNice(d.date):d.month);
  const baseX={grid:{display:false},ticks:{color:'#9a9193',font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12}};
  let ds=[],scales={},rollKey=null,rollFmt='money';
  if(S.metric==='spend_rev'){
    ds=[{type:'bar',label:'Revenue',data:Y('revenue'),backgroundColor:'rgba(245,235,25,.85)',yAxisID:'y',borderRadius:3,order:2},
        {type:'bar',label:'Meta Spend',data:Y('metaTotal'),backgroundColor:'rgba(125,117,118,.9)',yAxisID:'y',borderRadius:3,order:2},
        {type:'line',label:'MER %',data:Y('mer'),borderColor:'#efe9e9',yAxisID:'y1',tension:.3,pointRadius:0,borderWidth:2,order:1}];
    scales={y:{position:'left',grid:{color:'rgba(255,255,255,.05)'},ticks:{color:'#9a9193',font:{size:9},callback:v=>money(v,true)}},
      y1:{position:'right',grid:{display:false},ticks:{color:'#efe9e9',font:{size:9},callback:v=>v+'%'}},x:baseX};
  } else if(S.metric==='roas'){
    rollKey='roas'; rollFmt='x';
    ds=[{type:'line',label:'ROAS',data:Y('roas'),borderColor:'#39d98a',backgroundColor:'rgba(57,217,138,.12)',fill:true,tension:.3,pointRadius:0,borderWidth:2.5,order:1}];
    scales={y:{grid:{color:'rgba(255,255,255,.05)'},ticks:{color:'#39d98a',font:{size:9},callback:v=>v+'x'}},x:baseX};
  } else if(S.metric==='cpa'){
    rollKey='ncpa';
    ds=[{type:'bar',label:'New-Cust CPA',data:Y('ncpa'),backgroundColor:'rgba(245,235,25,.8)',borderRadius:3,order:2}];
    scales={y:{grid:{color:'rgba(255,255,255,.05)'},ticks:{color:'#9a9193',font:{size:9},callback:v=>money(v,true)}},x:baseX};
  } else { // prospecting %
    const prospShare=s.map(d=>d.metaTotal?d.metaNew/d.metaTotal*100:null);
    ds=[{type:'line',label:'Prospecting %',data:prospShare,borderColor:'#c98bff',backgroundColor:'rgba(201,139,255,.15)',fill:true,tension:.3,pointRadius:0,borderWidth:2.5}];
    scales={y:{min:0,max:100,grid:{color:'rgba(255,255,255,.05)'},ticks:{color:'#c98bff',font:{size:9},callback:v=>v+'%'}},x:baseX};
  }
  if(c.gran==='day' && rollKey && s.length>=10){
    ds.push({type:'line',label:'7-day avg',data:rollingAvg(Y(rollKey),7),borderColor:'#ff8a4a',borderDash:[5,4],pointRadius:0,borderWidth:2,tension:.35,order:0});
  }
  document.getElementById('trendSpan').textContent = c.win==='12M' ? '· last 12 months' : `· ${c.win}-day period`;
  const cfg={data:{labels,datasets:ds},options:{responsive:true,maintainAspectRatio:false,animation:{duration:500},
    interaction:{mode:'index',intersect:false},
    plugins:{legend:{display:true,labels:{color:'#c9c1c2',boxWidth:10,font:{size:10},filter:it=>!!it.text}},
      tooltip:{filter:i=>!!i.dataset.label,callbacks:{label:i=>{const dl=i.dataset.label,v=i.raw;
        if(/ROAS/.test(dl)) return dl+': '+xroas(v);
        if(/avg/.test(dl)) return dl+': '+(rollFmt==='x'?xroas(v):money(v));
        if(/%/.test(dl)) return dl+': '+pct(v);
        return dl+': '+money(v);}}}},
    scales}};
  if(charts.trend) charts.trend.destroy();
  charts.trend=new Chart(document.getElementById('perfTrend'),cfg);
}

/* ---- acquisition grid ---- */
function renderAcq(c){
  const r=c.rec,p=c.prev;
  document.getElementById('acqNote').textContent=c.sub;
  const cell=(l,v,s)=>`<div class="mcell"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s||''}</div></div>`;
  document.getElementById('acqGrid').innerHTML=
    cell('New Customers',numf(r.newOrders),`${deltaEl(r.newOrders,p&&p.newOrders,'newOrders')} ${c.periodLabel}`)+
    cell('New-Cust CPA',money(r.ncpa),`${deltaEl(r.ncpa,p&&p.ncpa,'ncpa')}`)+
    cell('New-Customer %',pct(r.newPct,0),'of all orders')+
    cell('Prospecting Spend',money(r.metaNew,true),`${r.metaTotal?pct(r.metaNew/r.metaTotal*100,0):'—'} of Meta`);
}

/* ---- Funnel Mix (Meta campaign export, classified by naming convention) ----
   The live sheet has no campaign tags, so this panel is sourced from the latest
   Meta Ads Manager export. Rules: TOF | Creative Testing → Prospecting;
   TOM (+ MOF mid-funnel) → Warm Remarketing; BOF → Hot Remarketing. */
const META_CAMPAIGNS = {
  window: "21 Apr – 20 May 2026",
  rows: [
    {name:'THS - AU - Conversions/Sales (NEW)', spend:594.06, rev:4991.78},
    {name:'🦘 AU #5 MOF - All Mid - All Placements', spend:3674.69, rev:18332.27},
    {name:'🦘 AU - ASC - RS - TOM - Covers', spend:10734.43, rev:50950.41},
    {name:'🦘AU - ASC - RS - TOM - Grease', spend:27104.14, rev:95448.74},
    {name:'🦘AU - ASC - RS - TOM - Accessories', spend:6187.52, rev:21136.86},
    {name:'🎨 Creative Testing - ABO - Broad', spend:27246.38, rev:105139.68},
    {name:'🦘AU - ASC - RS - TOF - Broad - Excl.', spend:44132.2, rev:54888.35}
  ]
};
function funnelStage(name){
  const n=name||'';
  if(/\bBOF\b/i.test(n)) return 'hot';
  if(/\bTOM\b/i.test(n) || /\bMOF\b/i.test(n)) return 'warm';   // TOM warm remarketing; MOF = mid-funnel warm
  if(/\bTOF\b/i.test(n) || /creative testing/i.test(n)) return 'prospecting';
  return 'other';
}
const FUNNEL=[
  {key:'prospecting',name:'Prospecting',tags:'TOF · Creative Testing',col:'#f5eb19'},
  {key:'warm',name:'Warm Remarketing',tags:'TOM · MOF',col:'#ff8a4a'},
  {key:'hot',name:'Hot Remarketing',tags:'BOF',col:'#ff5a52'},
  {key:'other',name:'Other',tags:'untagged',col:'#7d7576'}
];
function renderFunnel(){
  document.getElementById('funnelNote').textContent = 'Meta campaigns · '+META_CAMPAIGNS.window;
  const buck={};
  META_CAMPAIGNS.rows.forEach(r=>{const k=funnelStage(r.name);
    const b=buck[k]||(buck[k]={spend:0,rev:0,n:0}); b.spend+=r.spend; b.rev+=r.rev; b.n++;});
  const tot=Object.values(buck).reduce((a,b)=>a+b.spend,0)||1;
  const maxSp=Math.max(...Object.values(buck).map(b=>b.spend),1);
  document.getElementById('funnelWrap').innerHTML = FUNNEL.filter(f=>buck[f.key]).map(f=>{
    const b=buck[f.key], roas=b.spend?b.rev/b.spend:0, share=b.spend/tot*100;
    return `<div class="catrow">
      <div class="bar" style="width:${Math.max(b.spend/maxSp*100,2)}%;background:linear-gradient(90deg,${f.col}3a,${f.col}0f);border-right:2px solid ${f.col}"></div>
      <div class="cinfo"><div class="cname">${f.name}</div>
        <div class="cmeta">${f.tags} · ${b.n} camp · ROAS ${roas.toFixed(2)}x</div></div>
      <div class="cright"><div class="cnet">${money(b.spend,true)}</div>
        <div class="cshare">${pct(share,0)} of spend</div></div>
    </div>`;
  }).join('');
}

/* ---- ROAS by funnel stage (from the Meta campaign snapshot) ----
   Aggregates the classified campaigns into stages and shows ROAS (attributed
   revenue ÷ spend) per stage. Single-period snapshot — same source as Funnel Mix. */
const roasBarLabels = {
  id:'roasBarLabels',
  afterDatasetsDraw(chart){
    const {ctx}=chart, meta=chart.getDatasetMeta(0);
    ctx.save(); ctx.fillStyle='#e9e4e5'; ctx.font='700 1.35cqh sans-serif';
    ctx.textBaseline='middle';
    chart.data.datasets[0].data.forEach((v,i)=>{
      const bar=meta.data[i]; if(!bar) return;
      ctx.font=`700 ${Math.round(chart.height*0.075)}px "Roboto Condensed",sans-serif`;
      ctx.fillText(v.toFixed(2)+'×', bar.x+6, bar.y);
    });
    ctx.restore();
  }
};
function renderStageRoas(){
  document.getElementById('stageRoasNote').textContent = 'Meta campaigns · '+META_CAMPAIGNS.window;
  const buck={};
  META_CAMPAIGNS.rows.forEach(r=>{const k=funnelStage(r.name);
    const b=buck[k]||(buck[k]={spend:0,rev:0,n:0}); b.spend+=r.spend; b.rev+=r.rev; b.n++;});
  const stages=FUNNEL.filter(f=>buck[f.key] && f.key!=='other');   // untagged isn't a funnel stage
  const roas=stages.map(f=>buck[f.key].spend?buck[f.key].rev/buck[f.key].spend:0);
  const maxR=Math.max(...roas,1);
  const cfg={type:'bar',
    data:{labels:stages.map(f=>f.name),
      datasets:[{data:roas, backgroundColor:stages.map(f=>f.col+'d0'), borderColor:stages.map(f=>f.col),
        borderWidth:1.5, borderRadius:4, barPercentage:0.72}]},
    options:{indexAxis:'y', responsive:true, maintainAspectRatio:false, animation:{duration:600},
      layout:{padding:{right:34}},
      scales:{
        x:{beginAtZero:true, suggestedMax:maxR*1.18, grid:{color:'rgba(255,255,255,0.05)'},
           ticks:{color:'#9a9193', font:{size:10}, callback:v=>v+'×'}},
        y:{grid:{display:false}, ticks:{color:'#c9c1c2', font:{size:11, weight:'700'}}}},
      plugins:{legend:{display:false},
        tooltip:{callbacks:{label:i=>{const b=buck[stages[i.dataIndex].key];
          return ` ${i.raw.toFixed(2)}× ROAS · spend ${money(b.spend,true)} · rev ${money(b.rev,true)} · ${b.n} camp`;}}}}},
    plugins:[roasBarLabels]};
  if(charts.chan) charts.chan.destroy();
  charts.chan=new Chart(document.getElementById('stageRoas'),cfg);
}

function renderFooter(){
  document.getElementById('footSource').innerHTML=`Source: ${DATA.meta.source} · <b>${DATA.meta.currency||'AUD'}</b>`;
}

/* ---- live / wiring / init ---- */
function setLive(mode){ S.live=mode; const dot=document.getElementById('liveDot'),txt=document.getElementById('liveText');
  dot.className='dot '+(mode==='live'?'live':mode==='loading'?'loading':'snap'); txt.textContent=mode==='live'?'Live':mode==='loading'?'Syncing…':'Snapshot'; }
function wire(){
  document.getElementById('prevBtn').onclick=()=>{ if(document.getElementById('prevBtn').disabled)return; S.off++; render(); };
  document.getElementById('nextBtn').onclick=()=>{ if(document.getElementById('nextBtn').disabled)return; S.off=Math.max(0,S.off-1); render(); };
  document.querySelectorAll('#winSeg button').forEach(b=>b.onclick=()=>{ document.querySelectorAll('#winSeg button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); const v=b.dataset.win; S.win=v==='12M'?'12M':parseInt(v,10); S.off=0; render(); });
  document.querySelectorAll('#chartTabs button').forEach(b=>b.onclick=()=>{ document.querySelectorAll('#chartTabs button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); S.metric=b.dataset.metric; renderTrend(ctx()); });
  window.addEventListener('keydown',e=>{ if(e.key==='ArrowLeft')document.getElementById('prevBtn').click(); if(e.key==='ArrowRight')document.getElementById('nextBtn').click(); });
  window.addEventListener('resize',()=>{clearTimeout(window._rz);window._rz=setTimeout(render,200);});
}
(function init(){
  if(!DATA){document.getElementById('errBox').classList.add('show');return;}
  setLive('snap'); wire(); render();
  if(window.DLmotion) DLmotion.entrance();
})();
