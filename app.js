/* =========================================================================
   DiggerLid — Daily Operations Review
   Reads an embedded snapshot (data.js) and, when the sheet is reachable,
   upgrades to a LIVE pull. Read-only — never writes to the sheet.
   ========================================================================= */

const CONFIG = {
  sheetId: "1rAut5J3SoDvH0ObdVuTenqGjiO-u7M6cPpRNQ5Hqpnw",   // reference only; the backend reads the sheet
  /* How the dashboard fetches fresh data at runtime:
       'api'  – call the backend route (the only supported path)
       'off'  – embedded snapshot only

     There used to be an 'auto' mode that pulled the sheet straight from the
     browser over gviz CSV and parsed it with a hardcoded row map. It is gone.
     It required the sheet to be world-readable, which is the exact exposure the
     password gate exists to prevent, and its row map had drifted onto an empty
     country block — the same drift that froze this board. Dead code that
     silently returns wrong financials is worse than no fallback. */
  liveMode: "api",
  apiUrl: "/api/data",              // served by api/data.js; unreachable locally → snapshot
  refreshMinutes: 30,               // periodic re-pull while the board is open
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
const { MONTH_ABBR, isoToNice, fmtRange, rollingAvg, periodSlices, aggregate, breakeven, sparkline,
        isPending, pendingMode, pendingLabel } = DLcore;

/* ----------------------------- state ----------------------------------- */
// Unified period selector: win ∈ {3,7,30,90,'YTD'} (trailing period ending yesterday); off = periods back.
// 'YTD' is not a trailing 12 months: the sheet is a calendar-2026 workbook, so the
// monthly roll-up only ever holds this year's months. The button says what it does.
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

async function tryLiveRefresh(manual=false){
  if(CONFIG.liveMode==='off') return;
  setLive('loading');
  try{
    const r=await fetch(CONFIG.apiUrl); if(!r.ok) throw new Error('http-'+r.status);
    const j=await r.json();
    // A 200 with no rows is not a live pull. The route can reach the sheet and
    // still extract nothing (blank month tab, shifted row offsets), and treating
    // that as success showed a green "Live" pill over empty trailing windows.
    // Throw so the catch below falls back to the snapshot and says "Snapshot".
    if(!(j.daily||[]).length) throw new Error('api-no-rows');
    // MERGE (don't replace): keep the embedded history so 90D and the
    // year-to-date roll-up still work, overlay the freshly-pulled recent days,
    // and refresh monthly + latest-date.
    const map=new Map(DATA.daily.map(d=>[d.date,d]));
    (j.daily||[]).forEach(d=>map.set(d.date,d));
    DATA.daily=[...map.values()].sort((a,b)=>a.date<b.date?-1:1);
    if(j.monthly&&j.monthly.length) DATA.monthly=j.monthly;
    if(j.meta&&j.meta.latestDataDate) DATA.meta.latestDataDate=j.meta.latestDataDate;
    afterData('live');
  }catch(e){
    setLive('snap');
    if(manual) flashTip(document.getElementById('livePill'),
      `Live pull failed (${e.message}). The board is showing the embedded snapshot. `+
      `Check /api/health — it reports which credentials the deployment actually has.`);
  }
}

// Year covered by the monthly roll-up. Derived, not hardcoded, so the label stays
// true when the workbook rolls over to a new calendar year.
function ytdYear(list){
  // Monthly rows carry label ("Sep 2026"), not an ISO date — read the year off that.
  for(let i=(list||[]).length-1;i>=0;i--){
    const m=/\b(20\d{2})\b/.exec(list[i].label||'');
    if(m) return m[1];
  }
  return String(new Date().getFullYear());
}

/* ----------------------------- data access ----------------------------- */
function clampToYesterday(){
  const maxISO = (yesterdayISO() < DATA.meta.latestDataDate) ? yesterdayISO() : DATA.meta.latestDataDate;
  let idx = DATA.daily.length-1;
  for(let i=DATA.daily.length-1;i>=0;i--){ if(DATA.daily[i].date<=maxISO){ idx=i; break; } }
  return idx;
}
// The oldest period is usually shorter than P days, because periodSlices clamps
// at the start of the data rather than reaching past it. Say so, instead of
// labelling an 11-day slice a "30-day period".
function periodSub(P, days, off){
  const back = off ? ` · ${off} back` : '';
  return days < P ? `${days} of ${P} days${back}` : `${P}-day period${back}`;
}
function ctx(){
  if(S.win==='YTD'){                                   // year-to-date — monthly granularity
    const list=DATA.monthly;
    const yr=ytdYear(list);
    return {rec:aggregate(list), prev:null, series:list, prevSeries:null, gran:'month',
      title:`${yr} year to date`, sub:`${list.length} month${list.length===1?'':'s'}`,
      periodLabel:`${yr} YTD`, win:'YTD'};
  }
  const P=S.win, sl=periodSlices(DATA.daily, clampToYesterday(), P, S.off);
  S.off=sl.off;                                          // reflect any clamping back into state
  const cur=sl.cur, prevSeries=sl.prev;
  const rec=aggregate(cur), prev=prevSeries.length?aggregate(prevSeries):null;
  return {rec, prev, series:cur, prevSeries, gran:'day',
    title:fmtRange(cur[0].date,cur[cur.length-1].date),
    sub:periodSub(P, cur.length, S.off), periodLabel:`vs prior ${P}d`, win:P};
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
  const thr=document.getElementById('throughVal');
  thr.textContent=isoToNice(DATA.meta.latestDataDate)+" 2026";
  /* Say so when the newest day is only half entered. Without this the board
     looks fully up to date while its ad-spend metrics are running off a blank
     cell, and the reader has no way to tell. */
  const pend=c.rec&&c.rec.pending;
  const note=document.getElementById('pendNote');
  if(pend){
    const days=pend.dates.map(d=>isoToNice(d)).join(', ');
    note.textContent=`ad spend not yet entered for ${days}`;
    note.hidden=false; thr.classList.add('pending');
  } else { note.hidden=true; thr.classList.remove('pending'); }
  // ‹ › step the trailing period back/forward; disabled for YTD (one year of data)
  const prevB=document.getElementById('prevBtn'), nextB=document.getElementById('nextBtn');
  if(S.win==='YTD'){ prevB.disabled=true; nextB.disabled=true; }
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
  const adMode=pendingMode(r,'adSpend');          // 'blank' | 'qualify' | null
  const adPending=adMode==='blank';               // too much missing to show a figure
  const pendFoot=`<span class="delta flat">—</span><span class="k-per">${pendingLabel(r)}</span>`;
  // Below the suppression threshold the figure still stands; it just carries how
  // much of the window is outstanding, so nobody reads it as final.
  const qFoot=adMode==='qualify'?`<span class="delta flat">—</span><span class="k-per">${pendingLabel(r)}</span>`:null;
  const tiles=[
    kpiTile('Revenue', money(r.revenue,true), money(r.revenue), foot(r.revenue,p&&p.revenue,'revenue'), true,'revenue'),
    // Profit IS the sheet's own number, but it was computed without the missing
    // spend, so it is overstated rather than absent — shown, and labelled.
    kpiTile('Net Profit', money(r.profit,true),
      isPending(r,'profit') ? 'provisional — excludes pending spend' : `Margin <b>${pct(r.profitPct)}</b>`,
      isPending(r,'profit') ? pendFoot : foot(r.profit,p&&p.profit,'profit'), false,'profit'),
    // Ad spend and everything divided by it are blanked while the sheet is
    // mid-entry, rather than reported against a partial total.
    adPending
      ? kpiTile('Meta Ad Spend', 'pending', 'not yet entered', pendFoot, false, null)
      : kpiTile('Meta Ad Spend', money(r.metaTotal,true),
          adMode==='qualify' ? `<b>${pct((r.metaTotal/r.revenue)*100)}</b> of revenue · so far` : `<b>${pct((r.metaTotal/r.revenue)*100)}</b> of revenue`,
          qFoot||foot(r.metaTotal,p&&p.metaTotal,'metaTotal'), false,'metaTotal'),
    adPending
      ? kpiTile('Sitewide ROAS', 'pending', 'MER pending', pendFoot, false, null)
      : kpiTile('Sitewide ROAS', xroas(r.roas), `MER <b>${pct(r.mer)}</b>`,
          qFoot||foot(r.roas,p&&p.roas,'roas'), false,'roas'),
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
    c.win==='YTD' ? 'Year-to-date P&L' : `${c.win}-day P&L`;
  document.getElementById('eqRev').textContent = money(r.revExGst!=null?r.revExGst:r.revenue);
  const profEl=document.getElementById('eqProfit');
  profEl.textContent = money(r.profit);
  /* The cascade above is drawn from a partial ad-spend total while spend is
     pending, so this figure is the sheet's own but provisional. Say so here as
     well as on the KPI tile — read on its own, a green "= Profit" cell is the
     most convincing number on the page. */
  const pl=document.getElementById('eqProfitLbl');
  if(pl) pl.textContent = isPending(c.rec,'profit') ? 'Net Profit · provisional' : 'Net Profit';
  profEl.parentElement.classList.toggle('profit', true);
  const base = r.revExGst!=null?r.revExGst:r.revenue;
  const ads=r.totalAds||0, vc=r.totalVC||0, fc=r.totalFC||0, profit=r.profit||0;
  const c1=base-ads, c2=c1-vc, c3=c2-fc;
  /* A loss used to draw nothing: the final bar was [0, max(profit,0)], so a
     negative profit collapsed to zero height while the label above it printed
     the negative figure. Draw it downward from zero instead, in red. */
  const data=[ [0,base], [c1,base], [c2,c1], [c3,c2], profit>=0?[0,profit]:[profit,0] ];
  const adLbl = isPending(c.rec,'adSpend') ? '− Ad Spend (pending)' : '− Ad Spend';
  const labels=['Revenue',adLbl,'− Variable','− Fixed','= Profit'];
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
      // axis colour matches the ROAS line it scales (#5ec8ff), not the breakeven band
      y1:{position:'right',grid:{display:false},ticks:{color:'#5ec8ff',font:{size:9},callback:v=>v+'x'}},x:baseX};
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
      /* Feed the mean the 6 days BEFORE the window and drop them from the
         result, so the first plotted point is a true 7-day average. Computed
         over the window alone, the first point was a 1-day "average" — 73% high
         on the 30-day revenue view — and the next five were short. */
      const LEAD=6, first=DATA.daily.findIndex(d=>d.date===s[0].date);
      const lead=Math.max(0, Math.min(LEAD, first));
      const feed=DATA.daily.slice(first-lead, first+s.length).map(d=>d[rollKey]);
      datasets.push({type:'line',label:'7-day avg',data:rollingAvg(feed,7,lead),
        borderColor:'#ff8a4a',borderDash:[5,4],backgroundColor:'transparent',yAxisID:'y',
        tension:.35,pointRadius:0,borderWidth:2,order:0});
    }
  }
  const periodTxt = c.win==='YTD' ? '· year to date' : `· ${c.win}-day period`;
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
  document.getElementById('paceNote').textContent = c.win==='YTD' ? `${c.periodLabel} vs forecast` : `${c.win}-day period vs forecast`;
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
  const AD_KEYS=['mer','roas'];                    // both divide by ad spend
  /* Withhold the traffic light only when the underlying figure is withheld. With
     one day of thirty outstanding the MER moves under a point, so a WATCH is
     still a WATCH — and blanking it would hide a real signal to guard against a
     rounding error. With one day of three it moved 12 points, which is the case
     this threshold exists for. */
  const adPending=pendingMode(r,'adSpend')==='blank';
  const adQualified=pendingMode(r,'adSpend')==='qualify';
  const rows=Object.entries(CONFIG.health).map(([key,cfg])=>{
    const v=r[key];
    /* Three states, not two. A metric with no value is not a failing metric:
       status started at 'b' and only moved if v!=null, so a blank rendered as a
       red ACT — a false alarm indistinguishable from a real one. Anything
       waiting on the sheet, or simply absent, is now neutral. */
    const waiting = adPending && AD_KEYS.includes(key);
    let status = (v==null || waiting) ? 'n' : null;
    if(status===null){
      if(cfg.dir==='high') status = v>=cfg.good?'g': v>=cfg.warn?'a':'b';
      else status = v<=cfg.good?'g': v<=cfg.warn?'a':'b';
    }
    const val = status==='n' ? (waiting?'pending':'—')
              : cfg.fmt==='pct'?pct(v): cfg.fmt==='x'?xroas(v): numf(v);
    const state={g:'OK',a:'WATCH',b:'ACT',n:waiting?'PENDING':'NO DATA'}[status];
    // Explain the actual check: the benchmark band, and (when not green) why it tripped.
    const hi = cfg.dir==='high';
    const fmtT = t => cfg.fmt==='pct'?t+'%' : cfg.fmt==='x'? t+'×' : numf(t);
    const band = hi ? `good ≥ ${fmtT(cfg.good)} · watch ≥ ${fmtT(cfg.warn)}`
                    : `good ≤ ${fmtT(cfg.good)} · watch ≤ ${fmtT(cfg.warn)}`;
    const th = status==='a' ? cfg.good : cfg.warn;
    const q = (adQualified && AD_KEYS.includes(key)) ? pendingLabel(r)+' · ' : '';
    const sub = status==='n'
        ? (waiting ? 'waiting on ad spend in the sheet · '+band : 'no value for this period · '+band)
      : status==='g' ? q+band
      : `${q}${hi?'below':'above'} the ${fmtT(th)} ${status==='a'?'target':'action line'} · ${band}`;
    return `<div class="hrow" role="listitem" aria-label="${cfg.label}: ${val}, ${state}. ${sub}">
      <span class="hdot ${status}"></span>
      <span class="hnm"><span class="hlbl">${cfg.label}</span><span class="hsub">${sub}</span></span>
      <span class="hval ${status}-t">${val}</span>
      <small class="hstate ${status}-t">${state}</small></div>`;
  });
  // Spend signal from the breakeven-MER band (distinguishes amber "hold" from red "pull back")
  const bk=breakeven(r);
  if(!bk && adPending) rows.push(`<div class="hrow" role="listitem" aria-label="Spend signal: pending">
      <span class="hdot n"></span>
      <span class="hnm"><span class="hlbl">Spend Signal · MER vs b/e</span><span class="hsub">held back until ad spend is entered — a partial total reads as headroom</span></span>
      <small class="hstate n-t" style="grid-column:3 / -1;justify-self:end">PENDING</small></div>`);
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
    const v=b.dataset.win; S.win = v==='YTD'?'YTD':parseInt(v,10); S.off=0; render();
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
