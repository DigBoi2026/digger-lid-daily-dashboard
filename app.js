/* =========================================================================
   DiggerLid — Daily Operations Review
   Reads an embedded snapshot (data.js) and, when the sheet is reachable,
   upgrades to a LIVE pull. Read-only — never writes to the sheet.
   ========================================================================= */

const CONFIG = {
  sheetId: "1rAut5J3SoDvH0ObdVuTenqGjiO-u7M6cPpRNQ5Hqpnw",
  // How the dashboard fetches fresh data at runtime:
  //   'auto'  – try a live gviz CSV pull; fall back to the embedded snapshot
  //   'api'   – call a backend proxy (the Vercel path; set apiUrl below)
  //   'off'   – embedded snapshot only
  liveMode: "api",                  // 'api' = Vercel backend (private); 'auto' = client gviz; 'off' = snapshot only
  apiUrl: "/api/data",              // served by api/data.js on Vercel; 404s locally → falls back to snapshot
  refreshMinutes: 30,               // periodic re-pull while the board is open
  // Consolidated ("All Countries") block row indices — must match build_data.py
  rows: {revenue:62,revExGst:65,gstPct:66,orders:68,newOrders:69,items:70,sessions:71,
    cvr:73,newPct:74,ipo:75,aov:76,cpv:77,rpv:78,cpp:79,ncpa:80,metaNew:83,metaTotal:84,
    google:85,tiktok:86,totalAds:88,mer:89,mer3:90,prodCost:92,shipCost:93,packaging:95,
    txnFees:96,merchFees:97,totalVC:98,vcr:99,salaries:101,software:102,office:103,
    totalFC:104,fcr:105,returns:107,returnsPct:108,totalExp:111,profit:112,profitPct:113,
    roas:114,fcRev:115,projSpend:119,fcProfit:123},
  months:["Jan '26","Feb '26","Mar '26","Apr '26","May '26","Jun '26","Jul '26",
    "Aug '26","Sep '26","Oct '26","Nov '26","Dec '26"],
  // Health thresholds  [greenIfBetterThan, amberIfBetterThan]  + direction
  health:{
    profitPct:{good:8, warn:3, dir:'high', label:'Profit %', fmt:'pct'},
    roas:{good:4, warn:3, dir:'high', label:'Sitewide ROAS', fmt:'x'},
    mer:{good:25, warn:30, dir:'low', label:'MER', fmt:'pct'},
    cvr:{good:3, warn:2, dir:'high', label:'Conversion Rate', fmt:'pct'},
    vcr:{good:45, warn:50, dir:'low', label:'Variable Cost Ratio', fmt:'pct'},
  }
};

// Shared math/utilities live in core.js (unit-tested by source/test_core.js).
const { MONTH_ABBR, isoToNice, fmtRange, rollingAvg, periodSlices, aggregate, breakeven, sparkline } = DLcore;

/* ----------------------------- state ----------------------------------- */
// Unified period selector: win ∈ {7,30,90,'12M'} (trailing period ending yesterday); off = periods back.
const S = { win:30, off:0, metric:'rev_spend', live:'snap' };
let DATA = window.DL_DATA || null;
let charts = { wf:null, trend:null };

/* --------------------------- formatters -------------------------------- */
const money = (n, compact=false) => {
  if (n==null || isNaN(n)) return '—';
  if (compact){
    const a=Math.abs(n);
    if (a>=1e6) return '$'+(n/1e6).toFixed(2)+'M';
    if (a>=1e3) return '$'+(n/1e3).toFixed(a>=1e4?0:1)+'K';
    return '$'+Math.round(n);
  }
  return n.toLocaleString('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0});
};
const pct = (n,d=1) => n==null||isNaN(n) ? '—' : n.toFixed(d)+'%';
const numf = (n) => n==null||isNaN(n) ? '—' : Math.round(n).toLocaleString('en-AU');
const xroas = (n) => n==null||isNaN(n) ? '—' : n.toFixed(2)+'x';

function todayISO(){ const t=new Date(); t.setHours(0,0,0,0); return t.toISOString().slice(0,10); }
function yesterdayISO(){ const t=new Date(); t.setDate(t.getDate()-1); t.setHours(0,0,0,0); return t.toISOString().slice(0,10); }

/* --------------------------- CSV parsing (live) ------------------------ */
function parseCSV(t){
  const rows=[]; let cur=[], c='', q=false;
  for(let i=0;i<t.length;i++){const ch=t[i];
    if(ch==='"'){ if(q&&t[i+1]==='"'){c+='"';i++;} else q=!q; }
    else if(ch===','&&!q){cur.push(c);c='';}
    else if(ch==='\n'&&!q){cur.push(c);rows.push(cur);cur=[];c='';}
    else if(ch==='\r'){}
    else c+=ch;}
  if(c!==''||cur.length){cur.push(c);rows.push(cur);}
  return rows;
}
const toNum = v => { if(v==null) return null; const s=String(v).replace(/[$,%\s]/g,''); if(s===''||s==='-')return null; const n=parseFloat(s); return isNaN(n)?null:Math.round(n*100)/100; };

function parseMonthDaily(rows, monthNum){
  const header=rows[0]||[], dow=rows[1]||[];
  const dayCols=[];
  header.forEach((h,ci)=>{ if(/^\s*\d{1,2}\s+[A-Za-z]{3}\s*$/.test(h)) dayCols.push(ci); });
  const out=[];
  for(const ci of dayCols){
    const dn=parseInt(header[ci].trim(),10);
    const iso=`2026-${String(monthNum).padStart(2,'0')}-${String(dn).padStart(2,'0')}`;
    const rec={date:iso,label:header[ci].trim(),dow:(dow[ci]||'').trim()};
    for(const k in CONFIG.rows){ const r=CONFIG.rows[k]; rec[k]= rows[r]&&ci<rows[r].length ? toNum(rows[r][ci]) : null; }
    if(rec.revenue||rec.sessions) out.push(rec);
  }
  return out;
}

async function fetchSheet(sheetName){
  const url=`https://docs.google.com/spreadsheets/d/${CONFIG.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res=await fetch(url,{credentials:'include'});
  if(!res.ok) throw new Error('HTTP '+res.status);
  const txt=await res.text();
  if(txt.trim().startsWith('<')) throw new Error('not-csv'); // login/redirect page
  return parseCSV(txt);
}

async function tryLiveRefresh(manual=false){
  if(CONFIG.liveMode==='off') return;
  setLive('loading');
  try{
    let daily=[], monthly=DATA.monthly;
    if(CONFIG.liveMode==='api' && CONFIG.apiUrl){
      const r=await fetch(CONFIG.apiUrl); if(!r.ok) throw new Error('api');
      const j=await r.json();
      // MERGE (don't replace): keep the embedded 6-month history so 90D still works,
      // overlay the freshly-pulled recent days, and refresh monthly + latest-date.
      const map=new Map(DATA.daily.map(d=>[d.date,d]));
      (j.daily||[]).forEach(d=>map.set(d.date,d));
      DATA.daily=[...map.values()].sort((a,b)=>a.date<b.date?-1:1);
      if(j.monthly&&j.monthly.length) DATA.monthly=j.monthly;
      if(j.meta&&j.meta.latestDataDate) DATA.meta.latestDataDate=j.meta.latestDataDate;
      afterData('live'); return;
    }
    // auto: pull the two most-recent months that could hold "up-to-yesterday" data
    const y=new Date(yesterdayISO());
    const wantMonths=[...new Set([y.getMonth(), (y.getMonth()+11)%12])]; // this + prev
    for(const mIdx of wantMonths.sort((a,b)=>a-b)){
      try{
        const rows=await fetchSheet(CONFIG.months[mIdx]);
        daily=daily.concat(parseMonthDaily(rows, mIdx+1));
      }catch(e){/* skip month */}
    }
    if(!daily.length) throw new Error('no-live-days');
    // merge: keep embedded history, overlay/extend with freshly pulled days
    const map=new Map(DATA.daily.map(d=>[d.date,d]));
    daily.forEach(d=>map.set(d.date,d));
    DATA.daily=[...map.values()].sort((a,b)=>a.date<b.date?-1:1);
    DATA.meta.latestDataDate=DATA.daily[DATA.daily.length-1].date;
    afterData('live');
  }catch(e){
    setLive('snap');
    if(manual) flashTip(document.getElementById('livePill'),
      "Live pull blocked (the sheet is private to this browser session). The board is showing the embedded snapshot. See README for enabling always-on live data.");
  }
}

/* ----------------------------- data access ----------------------------- */
function clampToYesterday(){
  const maxISO = (yesterdayISO() < DATA.meta.latestDataDate) ? yesterdayISO() : DATA.meta.latestDataDate;
  let idx = DATA.daily.length-1;
  for(let i=DATA.daily.length-1;i>=0;i--){ if(DATA.daily[i].date<=maxISO){ idx=i; break; } }
  return idx;
}
function ctx(){
  if(S.win==='12M'){                                   // 12-month view — monthly granularity
    const list=DATA.monthly;
    return {rec:aggregate(list), prev:null, series:list, prevSeries:null, gran:'month',
      title:'Last 12 months', sub:'2026 YTD', periodLabel:'2026 YTD', win:'12M'};
  }
  const P=S.win, sl=periodSlices(DATA.daily, clampToYesterday(), P, S.off);
  S.off=sl.off;                                          // reflect any clamping back into state
  const cur=sl.cur, prevSeries=sl.prev;
  const rec=aggregate(cur), prev=prevSeries.length?aggregate(prevSeries):null;
  return {rec, prev, series:cur, prevSeries, gran:'day',
    title:fmtRange(cur[0].date,cur[cur.length-1].date),
    sub:`${P}-day period${S.off?` · ${S.off} back`:''}`, periodLabel:`vs prior ${P}d`, win:P};
}


/* --------------------------- delta helper ------------------------------ */
const BETTER = {revenue:'high',orders:'high',newOrders:'high',items:'high',sessions:'high',
  cvr:'high',newPct:'high',aov:'high',rpv:'high',profit:'high',profitPct:'high',roas:'high',
  metaTotal:'neutral',totalAds:'neutral',mer:'low',mer3:'low',cpp:'low',ncpa:'low',cpv:'low',
  vcr:'low',fcr:'low',returnsPct:'low'};
function deltaEl(cur,prev,key,fmt){
  if(cur==null||prev==null||prev===0) return '<span class="delta flat">—</span>';
  const chg=(cur-prev)/Math.abs(prev)*100;
  const dir=BETTER[key]||'high';
  let cls='flat';
  if(Math.abs(chg)<0.05) cls='flat';
  else if(dir==='neutral') cls='flat';                 // magnitude only, no good/bad colour
  else { const good = dir==='high' ? chg>0 : chg<0; cls = good?'up':'down'; }
  const arrow = chg>0.05?'▲':chg<-0.05?'▼':'—';
  return `<span class="delta ${cls}">${arrow} ${Math.abs(chg).toFixed(1)}%</span>`;
}

/* ============================ RENDER ================================== */
function render(){
  if(!DATA || !DATA.daily || !DATA.daily.length){ document.getElementById('errBox').classList.add('show'); return; }
  const c=ctx();
  renderHeader(c);
  renderKPIs(c);
  renderWaterfall(c);
  renderTrend(c);
  renderPace(c);
  renderHealth(c);
  renderFooter(c);
  if(window.DLmotion) DLmotion.countUpAll();
}

function renderHeader(c){
  document.getElementById('navDate').textContent=c.title;
  document.getElementById('navDow').textContent=c.sub;
  document.getElementById('throughVal').textContent=isoToNice(DATA.meta.latestDataDate)+" 2026";
  // ‹ › step the trailing period back/forward; disabled for 12M (only 2026 data)
  const prevB=document.getElementById('prevBtn'), nextB=document.getElementById('nextBtn');
  if(S.win==='12M'){ prevB.disabled=true; nextB.disabled=true; }
  else {
    const P=S.win, end=clampToYesterday();
    nextB.disabled = S.off<=0;
    prevB.disabled = (end-(S.off+1)*P+1) < 0;   // not enough history for an earlier period
  }
}

function kpiTile(lbl,val,sub,foot,accent,sparkKey){
  return `<div class="kpi ${accent?'accent':''}">
    <div class="k-head">
      <div class="k-lbl">${lbl}</div>
      <div class="k-val">${val}</div>
      <div class="k-sub">${sub||''}</div>
    </div>
    <div class="k-foot">${foot||''}</div>
    ${sparkKey?`<canvas class="spark" data-key="${sparkKey}"></canvas>`:''}
  </div>`;
}
function renderKPIs(c){
  const r=c.rec, p=c.prev;
  const el=document.getElementById('kpis');
  // every tile shows the comparison-period label next to its arrow
  const per=`<span class="k-per">${c.periodLabel}</span>`;
  const foot=(cur,prev,key)=>deltaEl(cur,prev,key)+per;
  const tiles=[
    kpiTile('Revenue', money(r.revenue,true), money(r.revenue), foot(r.revenue,p&&p.revenue,'revenue'), true,'revenue'),
    kpiTile('Net Profit', money(r.profit,true), `Margin <b>${pct(r.profitPct)}</b>`, foot(r.profit,p&&p.profit,'profit'), false,'profit'),
    kpiTile('Meta Ad Spend', money(r.metaTotal,true), `<b>${pct((r.metaTotal/r.revenue)*100)}</b> of revenue`, foot(r.metaTotal,p&&p.metaTotal,'metaTotal'), false,'metaTotal'),
    kpiTile('Sitewide ROAS', xroas(r.roas), `MER <b>${pct(r.mer)}</b>`, foot(r.roas,p&&p.roas,'roas'), false,'roas'),
    kpiTile('Orders', numf(r.orders), `AOV <b>${money(r.aov)}</b>`, foot(r.orders,p&&p.orders,'orders'), false,'orders'),
    kpiTile('Conversion Rate', pct(r.cvr,2), `Sessions <b>${numf(r.sessions)}</b>`, foot(r.cvr,p&&p.cvr,'cvr'), false,'cvr'),
  ];
  el.innerHTML=tiles.join('');
  // sparkline: current period (bright) overlaid with the previous comparison period (faded)
  el.querySelectorAll('canvas.spark').forEach(cv=>{
    const key=cv.dataset.key;
    sparkline(cv, c.series.map(d=>d[key]), c.prevSeries?c.prevSeries.map(d=>d[key]):null);
  });
}

/* ------------------------- waterfall (day P&L) ------------------------ */
function renderWaterfall(c){
  const r=c.rec;
  document.getElementById('eqNote').textContent =
    c.win==='12M' ? '12-month P&L' : `${c.win}-day P&L`;
  document.getElementById('eqRev').textContent = money(r.revExGst!=null?r.revExGst:r.revenue);
  const profEl=document.getElementById('eqProfit');
  profEl.textContent = money(r.profit);
  profEl.parentElement.classList.toggle('profit', true);
  const base = r.revExGst!=null?r.revExGst:r.revenue;
  const ads=r.totalAds||0, vc=r.totalVC||0, fc=r.totalFC||0, profit=r.profit||0;
  const c1=base-ads, c2=c1-vc, c3=c2-fc;
  const data=[ [0,base], [c1,base], [c2,c1], [c3,c2], [0,Math.max(profit,0)] ];
  const labels=['Revenue','− Ad Spend','− Variable','− Fixed','= Profit'];
  const colors=['#f5eb19','#ff5a52','#ff8a4a','#c98bff', profit>=0?'#39d98a':'#ff5a52'];
  const cfg={
    type:'bar',
    data:{labels,datasets:[{data,backgroundColor:colors,borderRadius:4,barPercentage:0.82,categoryPercentage:0.9}]},
    options:{
      responsive:true,maintainAspectRatio:false,animation:{duration:600},
      plugins:{legend:{display:false},tooltip:{callbacks:{label:(i)=>{
        const seg=['Revenue (ex GST)','Ad spend','Variable costs','Fixed costs','Net profit'][i.dataIndex];
        const raw=[base,ads,vc,fc,profit][i.dataIndex];
        return seg+': '+money(raw);
      }}}},
      scales:{
        x:{grid:{display:false},ticks:{color:'#c9c1c2',font:{size:10}}},
        y:{grid:{color:'rgba(255,255,255,.05)'},ticks:{color:'#9a9193',font:{size:10},callback:v=>money(v,true)}}
      }
    },
    plugins:[valueLabelPlugin([base,-ads,-vc,-fc,profit])]
  };
  if(charts.wf) charts.wf.destroy();
  charts.wf=new Chart(document.getElementById('waterfall'),cfg);
}
function valueLabelPlugin(vals){
  return {id:'vlab',afterDatasetsDraw(chart){
    const {ctx}=chart; const meta=chart.getDatasetMeta(0);
    ctx.save(); ctx.font='700 10px "Roboto Condensed",sans-serif'; ctx.textAlign='center';
    meta.data.forEach((bar,i)=>{
      ctx.fillStyle=(i===4? '#39d98a':'#fff');
      ctx.fillText(money(vals[i],true), bar.x, bar.y-4);
    });
    ctx.restore();
  }};
}

/* ------------------------------ trend chart --------------------------- */
function renderTrend(c){
  const s=c.series;
  const labels=s.map(d=> c.gran==='day'? isoToNice(d.date) : d.month);
  const Y=(id)=>s.map(d=>d[id]);
  const yell='#f5eb19', grey='#7d7576', white='#efe9e9', green='#39d98a', purp='#c98bff';
  let datasets=[], scales={};
  const baseX={grid:{display:false},ticks:{color:'#9a9193',font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12}};
  if(S.metric==='rev_spend'){
    datasets=[
      {type:'bar',label:'Revenue',data:Y('revenue'),backgroundColor:'rgba(245,235,25,.85)',yAxisID:'y',order:2,borderRadius:3},
      {type:'bar',label:'Meta Spend',data:Y('metaTotal'),backgroundColor:'rgba(125,117,118,.9)',yAxisID:'y',order:2,borderRadius:3},
      {type:'line',label:'MER %',data:Y('mer'),borderColor:white,backgroundColor:white,yAxisID:'y1',tension:.3,pointRadius:0,borderWidth:2,order:1},
    ];
    scales={y:{position:'left',grid:{color:'rgba(255,255,255,.05)'},ticks:{color:'#9a9193',font:{size:9},callback:v=>money(v,true)}},
      y1:{position:'right',grid:{display:false},ticks:{color:'#efe9e9',font:{size:9},callback:v=>v+'%'}},x:baseX};
  } else if(S.metric==='mer'){
    // Breakeven MER band: green zone (scale) ≤ profit b/e < amber (hold) ≤ cash b/e < red (burn)
    const beFull=s.map(d=>{const b=breakeven(d);return b?b.full:null;});
    const beCash=s.map(d=>{const b=breakeven(d);return b?b.contrib:null;});
    const merv=Y('mer');
    const cap=Math.ceil(Math.max(60, ...merv.filter(v=>v!=null), ...beCash.filter(v=>v!=null))*1.05/10)*10;
    datasets=[
      {type:'line',label:'Profit breakeven',data:beFull,borderColor:'rgba(57,217,138,.55)',borderDash:[5,3],borderWidth:1.5,yAxisID:'y',pointRadius:0,fill:'origin',backgroundColor:'rgba(57,217,138,.10)',tension:.2,order:9},
      {type:'line',label:'Cash breakeven',data:beCash,borderColor:'rgba(255,176,32,.55)',borderDash:[5,3],borderWidth:1.5,yAxisID:'y',pointRadius:0,fill:'-1',backgroundColor:'rgba(255,176,32,.13)',tension:.2,order:9},
      {type:'line',label:'',data:s.map(()=>cap),borderWidth:0,yAxisID:'y',pointRadius:0,fill:'-1',backgroundColor:'rgba(255,90,82,.10)',order:9},
      {type:'line',label:'MER %',data:merv,borderColor:yell,yAxisID:'y',tension:.3,pointRadius:0,borderWidth:2.5,order:1},
      {type:'line',label:'ROAS',data:Y('roas'),borderColor:'#5ec8ff',yAxisID:'y1',tension:.3,pointRadius:0,borderWidth:2,order:1},
    ];
    scales={y:{position:'left',min:0,max:cap,grid:{color:'rgba(255,255,255,.05)'},ticks:{color:'#9a9193',font:{size:9},callback:v=>v+'%'}},
      y1:{position:'right',grid:{display:false},ticks:{color:'#39d98a',font:{size:9},callback:v=>v+'x'}},x:baseX};
  } else if(S.metric==='profit'){
    datasets=[
      {type:'bar',label:'Profit',data:Y('profit'),backgroundColor:s.map(d=>d.profit>=0?'rgba(57,217,138,.85)':'rgba(255,90,82,.85)'),yAxisID:'y',borderRadius:3},
      {type:'line',label:'Profit %',data:Y('profitPct'),borderColor:white,yAxisID:'y1',tension:.3,pointRadius:0,borderWidth:2},
    ];
    scales={y:{position:'left',grid:{color:'rgba(255,255,255,.05)'},ticks:{color:'#9a9193',font:{size:9},callback:v=>money(v,true)}},
      y1:{position:'right',grid:{display:false},ticks:{color:'#efe9e9',font:{size:9},callback:v=>v+'%'}},x:baseX};
  } else { // traffic
    datasets=[
      {type:'bar',label:'Sessions',data:Y('sessions'),backgroundColor:'rgba(125,117,118,.9)',yAxisID:'y',borderRadius:3},
      {type:'line',label:'CVR %',data:Y('cvr'),borderColor:yell,yAxisID:'y1',tension:.3,pointRadius:0,borderWidth:2.5},
    ];
    scales={y:{position:'left',grid:{color:'rgba(255,255,255,.05)'},ticks:{color:'#9a9193',font:{size:9},callback:v=>numf(v)}},
      y1:{position:'right',grid:{display:false},ticks:{color:'#f5eb19',font:{size:9},callback:v=>v+'%'}},x:baseX};
  }
  // 7-day rolling-average overlay (only meaningful on daily periods with enough points)
  if(c.gran==='day' && s.length>=10){
    const rollKey={rev_spend:'revenue',profit:'profit',traffic:'sessions'}[S.metric];
    if(rollKey){
      datasets.push({type:'line',label:'7-day avg',data:rollingAvg(Y(rollKey),7),
        borderColor:'#ff8a4a',borderDash:[5,4],backgroundColor:'transparent',yAxisID:'y',
        tension:.35,pointRadius:0,borderWidth:2,order:0});
    }
  }
  const periodTxt = c.win==='12M' ? '· last 12 months' : `· ${c.win}-day period`;
  if(S.metric==='mer'){
    const b=breakeven(c.rec);
    document.getElementById('trendSpan').textContent = b
      ? `· b/e ${b.full.toFixed(0)}% profit · ${b.contrib.toFixed(0)}% cash → ${b.signal}`
      : periodTxt;
  } else {
    document.getElementById('trendSpan').textContent = periodTxt;
  }
  const cfg={data:{labels,datasets},options:{
    responsive:true,maintainAspectRatio:false,animation:{duration:500},
    interaction:{mode:'index',intersect:false},
    plugins:{legend:{display:true,labels:{color:'#c9c1c2',boxWidth:10,font:{size:10},filter:(it)=>!!it.text}},
      tooltip:{filter:(i)=>!!i.dataset.label, callbacks:{label:(i)=>{
        const dl=i.dataset.label, v=i.raw;
        if(/ROAS/.test(dl)) return dl+': '+xroas(v);
        if(/avg/.test(dl)) return dl+': '+(S.metric==='traffic'?numf(v):money(v));
        if(/Sessions/.test(dl)) return dl+': '+numf(v);
        if(/%|breakeven|MER/i.test(dl)) return dl+': '+pct(v);
        return dl+': '+money(v);
      }}}},
    scales
  }};
  if(charts.trend) charts.trend.destroy();
  charts.trend=new Chart(document.getElementById('trend'),cfg);
}

/* ------------------------------ pace vs forecast ---------------------- */
// Pace bar: the fill grows toward the white FORECAST line (which sits at LINE% of the
// track). Fill reaching the line = 100% of forecast; past it = ahead, short = behind.
// A "»" overflow marker appears when attainment runs off the visible scale.
const PACE_LINE = 66.7;                              // forecast (100% attainment) position, % of track
function paceRow(name, actual, forecast, fmtFn, betterLow=false){
  const has = forecast!=null && forecast>0;
  const ratio = has ? actual/forecast : null;
  const attain = has ? ratio*100 : null;
  // good = at/above forecast (revenue/profit) OR at/below forecast (spend)
  const good = has ? (betterLow ? actual<=forecast : actual>=forecast) : true;
  const barCol = !has ? 'var(--muted)' : good ? 'var(--good)' : 'var(--warn)';
  const fillPct = has ? Math.min(100, ratio*PACE_LINE) : 0;
  const over = has && ratio*PACE_LINE > 100;        // ran off the scale
  const unit = betterLow ? 'budget' : 'target';
  const sub = has
    ? `${fmtFn(actual)} · <b class="${good?'g-t':'a-t'}">${attain.toFixed(0)}% of ${fmtFn(forecast)} ${unit}</b>`
    : `${fmtFn(actual)} · no forecast`;
  return `<div class="pace-row">
    <div class="pr-top"><span class="nm">${name}</span><span class="vv">${fmtFn(actual)}</span></div>
    <div class="track" title="${has?`Fill reaches the line at 100% of ${unit} (${fmtFn(forecast)})`:''}">
      <i style="width:${fillPct}%;background:${barCol}"></i>
      <div class="fc-mark" style="left:${PACE_LINE}%"></div>
      ${over?`<span class="ovf">»</span>`:''}
    </div>
    <div class="pr-sub">${sub}</div>
  </div>`;
}
function renderPace(c){
  const wrap=document.getElementById('paceWrap');
  document.getElementById('paceNote').textContent = c.win==='12M' ? '2026 YTD vs forecast' : `${c.win}-day period vs forecast`;
  const sum=(k)=>c.series.reduce((a,d)=>a+(d[k]||0),0);
  const rev=sum('revenue'), revF=sum('fcRev'), spend=sum('metaTotal'), spendF=sum('projSpend'),
        prof=sum('profit'), profF=sum('fcProfit');
  wrap.innerHTML =
    paceRow('Revenue', rev, revF, (v)=>money(v,true), false) +
    paceRow('Meta Spend', spend, spendF, (v)=>money(v,true), true) +
    paceRow('Profit', prof, profF, (v)=>money(v,true), false);
}

/* ------------------------------ health check -------------------------- */
function renderHealth(c){
  const r=c.rec, wrap=document.getElementById('healthWrap');
  const rows=Object.entries(CONFIG.health).map(([key,cfg])=>{
    const v=r[key];
    let status='b';
    if(v!=null){
      if(cfg.dir==='high') status = v>=cfg.good?'g': v>=cfg.warn?'a':'b';
      else status = v<=cfg.good?'g': v<=cfg.warn?'a':'b';
    }
    const val = cfg.fmt==='pct'?pct(v): cfg.fmt==='x'?xroas(v): numf(v);
    const state={g:'OK',a:'WATCH',b:'ACT'}[status];
    // Explain the actual check: the benchmark band, and (when not green) why it tripped.
    const hi = cfg.dir==='high';
    const fmtT = t => cfg.fmt==='pct'?t+'%' : cfg.fmt==='x'? t+'×' : numf(t);
    const band = hi ? `good ≥ ${fmtT(cfg.good)} · watch ≥ ${fmtT(cfg.warn)}`
                    : `good ≤ ${fmtT(cfg.good)} · watch ≤ ${fmtT(cfg.warn)}`;
    const th = status==='a' ? cfg.good : cfg.warn;
    const sub = status==='g' ? band
      : `${hi?'below':'above'} the ${fmtT(th)} ${status==='a'?'target':'action line'} · ${band}`;
    return `<div class="hrow" role="listitem" aria-label="${cfg.label}: ${val}, ${state}. ${sub}">
      <span class="hdot ${status}"></span>
      <span class="hnm"><span class="hlbl">${cfg.label}</span><span class="hsub">${sub}</span></span>
      <span class="hval ${status}-t">${val}</span>
      <small class="hstate ${status}-t">${state}</small></div>`;
  });
  // Spend signal from the breakeven-MER band (distinguishes amber "hold" from red "pull back")
  const bk=breakeven(r);
  if(bk) rows.push(`<div class="hrow" role="listitem" aria-label="Spend signal: ${bk.signal}">
      <span class="hdot ${bk.zone}"></span>
      <span class="hnm">Spend Signal · MER vs b/e</span>
      <small class="hstate ${bk.zone}-t" style="grid-column:3 / -1;justify-self:end">${bk.signal}</small></div>`);
  wrap.innerHTML=rows.join('');
}

/* ------------------------------ footer -------------------------------- */
function renderFooter(c){
  document.getElementById('footSource').innerHTML =
    `Source: ${DATA.meta.source} · <b>${DATA.currency||'AUD'}</b>`;
  document.getElementById('footNote').innerHTML =
    (S.live==='live'?'● Live pull':'● Snapshot '+(DATA.meta.snapshotDate||'')) + ' · read-only, never writes to the sheet';
}

/* ------------------------------ live status --------------------------- */
function setLive(mode){
  S.live=mode;
  const dot=document.getElementById('liveDot'), txt=document.getElementById('liveText');
  dot.className='dot '+(mode==='live'?'live':mode==='loading'?'loading':'snap');
  txt.textContent = mode==='live'?'Live':mode==='loading'?'Syncing…':'Snapshot';
}
function afterData(mode){
  DATA.daily.sort((a,b)=>a.date<b.date?-1:1);
  setLive(mode);
  render();
}

/* ------------------------------ tooltip ------------------------------- */
function flashTip(anchor,text){
  const tip=document.getElementById('tip');
  const rc=anchor.getBoundingClientRect();
  tip.textContent=text; tip.style.display='block';
  tip.style.left=Math.max(8,rc.left-160)+'px'; tip.style.top=(rc.bottom+8)+'px';
  clearTimeout(tip._t); tip._t=setTimeout(()=>tip.style.display='none',6000);
}

/* ------------------------------ events -------------------------------- */
function wire(){
  document.getElementById('prevBtn').onclick=()=>{ if(document.getElementById('prevBtn').disabled)return; S.off++; render(); };
  document.getElementById('nextBtn').onclick=()=>{ if(document.getElementById('nextBtn').disabled)return; S.off=Math.max(0,S.off-1); render(); };
  document.querySelectorAll('#chartTabs button').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('#chartTabs button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active'); S.metric=b.dataset.metric; renderTrend(ctx());
  });
  document.querySelectorAll('#winSeg button').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('#winSeg button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const v=b.dataset.win; S.win = v==='12M'?'12M':parseInt(v,10); S.off=0; render();
  });
  document.getElementById('livePill').onclick=()=>tryLiveRefresh(true);
  window.addEventListener('keydown',e=>{
    if(e.key==='ArrowLeft') document.getElementById('prevBtn').click();
    if(e.key==='ArrowRight') document.getElementById('nextBtn').click();
  });
  window.addEventListener('resize',()=>{ clearTimeout(window._rz); window._rz=setTimeout(render,200); });
}

/* ------------------------------ init ---------------------------------- */
(function init(){
  if(!DATA){ document.getElementById('errBox').classList.add('show'); return; }
  DATA.currency = DATA.meta.currency;
  setLive('snap');
  wire();
  render();
  if(window.DLmotion) DLmotion.entrance();
  // attempt a live upgrade shortly after first paint
  setTimeout(()=>tryLiveRefresh(false), 400);
  if(CONFIG.refreshMinutes>0) setInterval(()=>tryLiveRefresh(false), CONFIG.refreshMinutes*60000);
})();
