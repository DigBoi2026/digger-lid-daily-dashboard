/* =========================================================================
   DiggerLid — Meta Ads vs Benchmarks. Read-only.

   Every Meta line × audience tier against the v5.2 framework: Target CPA
   (healthy 15% margin), Kill CPA (break-even on 12-month LTV), Kill ROAS on
   Meta's own basis, and the top-of-funnel equivalents (Cost per ATC), for the
   selected window against the equal window before. The benchmarks are
   DERIVED on load from the framework's source inputs (lib/meta_bench.js) —
   never typed — and every estimated or policy figure is marked as such.

   SOURCES. Live: /api/meta (Marketing API insights, daily, by ad set, mapped
   to line × tier by name). Fallback: the committed 90-day snapshot from the
   framework package — totals only, so windows and deltas are unavailable and
   the page says so. The sheet (data.js) supplies the live new-customer CPA
   haircut: Meta shows blended CPA; the targets are calibrated to new-customer
   CPA, which the P&L puts 30–40% higher.
   ========================================================================= */
const SNAP = window.DL_META_SNAPSHOT || null;
const SHEET = window.DL_DATA || null;
const B = DLmeta.deriveAll();
let LIVE = null;                                  // /api/meta payload when configured
const S = { win: '7', line: null, tier: null, ref: 'econ', stage: 'all' };
/* Funnel stages, in the team's own naming. MOF and BOF are one stage. */
const STAGE_DEFS = [['all','All stages','every campaign'], ['TOF','TOF','top of funnel'], ['TOM','TOM','creative tests'], ['MOF','MOF / BOF','warm · closing']];
const stageOfRow = r => r._stage !== undefined ? r._stage : (r._stage = DLmeta.stageOf(r.campaign, r.adset));
const inStage = r => S.stage === 'all' || stageOfRow(r) === S.stage;
/* Live rows in the selected stage. Every reader of daily data goes through this,
   so the board, the chart and the streaks all agree on what "TOF" means. */
const liveRows = () => live() ? LIVE.rows.filter(inStage) : [];
let charts = { mt: null };

/* ---- formatters ---- */
const money=(n,c=true)=>{ if(n==null||isNaN(n))return '—';
  if(c){const a=Math.abs(n); if(a>=1e6)return '$'+(n/1e6).toFixed(2)+'M'; if(a>=1e3)return '$'+(n/1e3).toFixed(a>=1e4?0:1)+'K'; return '$'+Math.round(n);}
  return n.toLocaleString('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0}); };
const d0=n=>n==null||isNaN(n)?'—':'$'+Math.round(n).toLocaleString('en-AU');
const d2=n=>n==null||isNaN(n)?'—':'$'+n.toFixed(2);
const numf=n=>n==null||isNaN(n)?'—':Math.round(n).toLocaleString('en-AU');
const pct=(n,d=1)=>n==null||isNaN(n)?'—':n.toFixed(d)+'%';
const xr=n=>n==null||isNaN(n)?'—':n.toFixed(2)+'×';
const MONTH=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const nice=iso=>{const[,m,d]=iso.split('-').map(Number);return d+' '+MONTH[m-1];};
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10);};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ---- data ---- */
const live = () => !!(LIVE && LIVE.configured && LIVE.rows && LIVE.rows.length);
function windowRange(){
  if(!live()) return null;
  const end = LIVE.rows.reduce((a,r)=>r.date>a?r.date:a, '');
  const n = parseInt(S.win,10);
  const prev = { start: addDays(end, -(2*n-1)), end: addDays(end, -n) };
  /* A comparison against a prior window the pull only partly covers is a
     comparison against a fragment — "▲ 979%" on 90 days when the pull had ten
     days of the prior ninety. The prior window is dropped unless the data
     covers at least 90% of its days. */
  const first = LIVE.rows.reduce((a,r)=>r.date<a?r.date:a, '9999');
  const have = LIVE.rows.reduce((set,r)=>{ if(r.date>=prev.start && r.date<=prev.end) set.add(r.date); return set; }, new Set()).size;
  const covered = have >= Math.ceil(n*0.9);
  return { start: addDays(end, -(n-1)), end, prev: covered ? prev : null, prevPartial: !covered, first };
}
const inRange = (r, rg) => r.date >= rg.start && r.date <= rg.end;
/* Rows for the window: live daily rows filtered to the range, or the snapshot's
   90-day totals as a single pseudo-day. */
function rowsFor(rg){
  if(live()) return liveRows().filter(r=>inRange(r, rg));
  return (SNAP.rows||[]).map(r=>Object.assign({date:SNAP.meta.asOf}, r));
}
/* Group rows by line × tier, roll each up, attach benchmarks and verdicts. */
function board(rg, prevRg){
  const cur = rowsFor(rg), prev = prevRg && live() ? rowsFor(prevRg) : null;
  const key = r => r.line+'|'+r.tier;
  const groups = {};
  cur.forEach(r=>{ (groups[key(r)] = groups[key(r)] || {line:r.line, tier:r.tier, rows:[], prev:[]}).rows.push(r); });
  (prev||[]).forEach(r=>{ if(groups[key(r)]) groups[key(r)].prev.push(r); });
  return Object.values(groups).map(g=>{
    const roll = DLmeta.rollup(g.rows), pr = g.prev.length ? DLmeta.rollup(g.prev) : null;
    const bench = B[g.line] || null;
    const v = DLmeta.verdict(roll, bench, g.tier);
    return Object.assign(g, { roll, prev: pr, bench, tier_b: bench && bench.tiers ? bench.tiers[g.tier] : null, v });
  }).sort((a,b)=>b.roll.spend-a.roll.spend);
}
/* The sheet's own new-customer CPA ÷ blended CPA over the window — the live
   haircut. Falls back to the framework's 1.30–1.40 when the sheet has no
   entered spend in the window. */
function haircut(rg){
  /* The P&L's New Customer CPA is ALL spend over NEW orders, so against blended
     CPA (all spend over all orders) the ratio is simply orders ÷ new orders —
     January: $85 vs $62, 1.37. Read over the window from the sheet; the
     framework's 1.35 stands in when the sheet has no days there. */
  const rows = SHEET && SHEET.daily ? SHEET.daily.filter(d=> rg ? (d.date>=rg.start && d.date<=rg.end) : true).filter(d=>d.orders>0 && d.newOrders>0) : [];
  const o = rows.reduce((a,d)=>a+(d.orders||0),0), n = rows.reduce((a,d)=>a+(d.newOrders||0),0);
  if(o && n && rows.length>=3) return { ratio: o/n, newPct: n/o*100, days: rows.length, live: true };
  return { ratio: 1.35, live: false };
}
const deltaEl=(cur,prev,dir)=>{ if(cur==null||prev==null||!prev) return '<span class="delta flat">—</span>';
  const chg=(cur-prev)/Math.abs(prev)*100; const good = dir==='low' ? chg<0 : chg>0;
  const cls=Math.abs(chg)<0.05?'flat':good?'up':'down'; const ar=chg>0.05?'▲':chg<-0.05?'▼':'—';
  return `<span class="delta ${cls}">${ar} ${Math.abs(chg).toFixed(0)}%</span>`; };
const chip = st => `<span class="vchip v-${st.toLowerCase()}">${st}</span>`;

/* ============================ RENDER ============================ */
function render(){
  if(!SNAP && !live()){ document.getElementById('errBox').classList.add('show'); return; }
  const rg = windowRange();
  const rows = board(rg, rg && rg.prev);
  renderHeader(rg);
  renderStages(rg);
  renderKPIs(rows, rg);
  renderBoard(rows, rg);
  renderFunnel(rows, rg);
  renderAlerts(rows, rg);
  renderRef();
  renderFooter(rg);
  if(window.DLmotion) DLmotion.countUpAll();
}
function renderHeader(rg){
  const isLive = live();
  document.querySelectorAll('#winSeg button').forEach(b=>{ b.classList.toggle('active', b.dataset.win===S.win); b.disabled=!isLive; });
  document.getElementById('winLabel').textContent = isLive ? (S.win==='90'?'LAST 90 DAYS':`LAST ${S.win} DAYS`) : '90-DAY SNAPSHOT';
  document.getElementById('winDates').textContent = isLive
    ? (rg.prev ? `${nice(rg.start)}–${nice(rg.end)} · VS ${nice(rg.prev.start)}–${nice(rg.prev.end)}` : `${nice(rg.start)}–${nice(rg.end)} · NO FULL PRIOR PERIOD IN THE PULL`).toUpperCase()
    : (SNAP.meta.window||'').toUpperCase()+' · NO DAILY DETAIL';
  document.getElementById('throughVal').textContent = isLive ? nice(rg.end) : nice(SNAP.meta.asOf);
  document.getElementById('throughPend').textContent = isLive
    ? (LIVE.unmapped && LIVE.unmapped.length ? `${LIVE.unmapped.length} ad set${LIVE.unmapped.length>1?'s':''} unmapped → Multi/Broad` : 'all ad sets mapped to a line')
    : 'snapshot · connect Meta';
}
/* The rail: spend in the window per stage, so the choice is informed before
   it is made. In snapshot mode there are no campaign names to read, so the
   buttons are shown but disabled. */
function renderStages(rg){
  const wrap=document.getElementById('stageList'), note=document.getElementById('stageNote');
  if(!wrap) return;
  const isLive = live();
  const win = isLive ? LIVE.rows.filter(r=>inRange(r, rg)) : [];
  const total = win.reduce((a,r)=>a+(r.spend||0),0);
  const spendOf = id => win.reduce((a,r)=> a + ((id==='all' || stageOfRow(r)===id) ? (r.spend||0) : 0), 0);
  const other = isLive ? win.reduce((a,r)=> a + (stageOfRow(r)==null ? (r.spend||0) : 0), 0) : 0;
  wrap.innerHTML = STAGE_DEFS.map(([id,k,n])=>{
    const sp = spendOf(id), share = total ? sp/total*100 : null;
    const v = !isLive ? '<span>snapshot</span>' : id==='all' ? `<b>${money(sp)}</b>` : `<b>${money(sp)}</b> <span>· ${share!=null?share.toFixed(0):'—'}%</span>`;
    return `<button class="stbtn${S.stage===id?' on':''}" data-stage="${id}" ${isLive?'':'disabled'} title="${id==='all'?'Every campaign':'Campaigns whose name contains '+k.replace(' / ',' or ')}">
      <div class="st-k">${k}</div><div class="st-n">${n}</div><div class="st-v">${v}</div></button>`;
  }).join('');
  wrap.querySelectorAll('.stbtn').forEach(b=>b.onclick=()=>{ S.stage=b.dataset.stage; S.line=null; render(); });
  note.textContent = !isLive ? 'needs live names'
    : other > 0 ? `${money(other)} · ${(other/total*100).toFixed(0)}% of spend has no stage in its name` : 'by campaign name';
  note.title = other > 0 ? 'Campaigns with none of TOF, TOM, MOF or BOF in the name are counted under All stages only' : '';
}
function renderKPIs(rows, rg){
  const el=document.getElementById('kpis');
  const all = DLmeta.rollup(rows.flatMap(g=>g.rows)), prev = live() && rg.prev ? DLmeta.rollup(rows.flatMap(g=>g.prev)) : null;
  const hc = haircut(rg);
  const bl = B.blended;
  const ncpa = all.cpa!=null ? all.cpa*hc.ratio : null;
  const prosp = DLmeta.rollup(rows.filter(g=>g.tier==='Prospecting').flatMap(g=>g.rows));
  const per = `<span class="k-per">${live() ? (rg.prev ? 'vs prior '+S.win+' days' : 'no full prior period') : 'snapshot · no comparison'}</span>`;
  const tile=(lbl,val,sub,foot,cls)=>`<div class="kpi ${cls||''}"><div class="k-head"><div class="k-lbl">${lbl}</div><div class="k-val">${val}</div><div class="k-sub">${sub||''}</div></div><div class="k-foot">${foot||''}</div></div>`;
  const cpaCls = all.cpa==null?'' : ncpa>bl.kill ? 'bad' : ncpa>bl.target ? 'warn' : 'good';
  el.innerHTML = [
    tile('Meta Spend', money(all.spend), `${numf(all.purchases)} purchases · ${live() ? all.days+' day'+(all.days===1?'':'s') : '90-day snapshot'}`, (prev?deltaEl(all.spend,prev.spend,'neutral'):'<span class="delta flat">—</span>')+per, 'accent'),
    tile('Blended CPA', d0(all.cpa), `new-cust est. <b>${d0(ncpa)}</b> · ×${hc.ratio.toFixed(2)} ${hc.live?`(${hc.newPct.toFixed(0)}% of orders new, sheet)`:'framework default'}`, (prev?deltaEl(all.cpa,prev.cpa,'low'):'<span class="delta flat">—</span>')+`<span class="k-per">target ${d0(bl.target)} · kill ${d0(bl.kill)} (new-cust)</span>`, cpaCls),
    tile('ROAS (Meta)', xr(all.roas), `revenue ${money(all.revenue)} · AOV ${d0(all.aov)}`, (prev?deltaEl(all.roas,prev.roas,'high'):'<span class="delta flat">—</span>')+`<span class="k-per">blended kill ~${xr(bl.killRoasMeta)}</span>`, all.roas!=null && all.roas<bl.killRoasMeta ? 'bad':''),
    tile('Cost per ATC', d2(all.costPerAtc), `${numf(all.atc)} adds to cart · prospecting ${d2(prosp.costPerAtc)}`, (prev?deltaEl(all.costPerAtc,prev.costPerAtc,'low'):'<span class="delta flat">—</span>')+`<span class="k-per">leads CPA by 3–7 days</span>`),
    tile('ATC → Purchase', pct(all.atcToPurchase), `prospecting ${pct(prosp.atcToPurchase)} · baseline 28.4%`, (prev?deltaEl(all.atcToPurchase,prev.atcToPurchase,'high'):'<span class="delta flat">—</span>')+per),
    tile('LPV → ATC', pct(all.lpvToAtc), `${numf(all.lpv)} landing views · CPV ${d2(all.cpv)}`, (prev?deltaEl(all.lpvToAtc,prev.lpvToAtc,'high'):'<span class="delta flat">—</span>')+`<span class="k-per">retargeting should run 2–3× prospecting</span>`),
  ].join('');
}
function renderBoard(rows, rg){
  const wrap=document.getElementById('board');
  if(rows.length && !rows.some(g=>g.line===S.line && g.tier===S.tier)){ S.line=rows[0].line; S.tier=rows[0].tier; }
  document.getElementById('boardNote').textContent = `${rows.length} line × tier combinations · sorted by spend · ${live() ? (rg.prev ? 'vs prior period' : 'no full prior period in the pull') : '90-day snapshot'}${S.stage==='all'?'':' · '+STAGE_DEFS.find(d=>d[0]===S.stage)[1]+' campaigns only'} · click a row`;
  let html=`<div class="thead mt"><div>Line · tier</div><div class="num">Spend</div><div class="num">Purch</div><div class="num">CPA</div><div class="num">Target</div><div class="num">Kill</div><div class="num">ROAS / kill</div><div class="num">Cost/ATC / kill</div><div class="num">LPV→ATC</div><div>Status</div></div>`;
  html += rows.map(g=>{
    const b=g.bench, tb=g.tier_b, r=g.roll, p=g.prev;
    const sel = g.line===S.line && g.tier===S.tier;
    const tgt = b && b.target!=null ? d0(b.target) : (b && b.kill!=null ? '<span class="dim">INFEAS</span>' : '—');
    const kill = b && b.kill!=null ? d0(b.kill)+(b.policy?'<sup title="policy cap, not break-even">†</sup>':'')+(b.id==='Coupler'?'<sup title="own economics, not the Grease cap">‡</sup>':'') : '—';
    const roasCls = r.roas!=null && b && b.killRoasMeta ? (r.roas<b.killRoasMeta?'b-t':'g-t') : '';
    const catcCls = r.costPerAtc!=null && tb && tb.killCostPerAtc ? (r.costPerAtc>tb.killCostPerAtc?'b-t': tb.targetCostPerAtc && r.costPerAtc<=tb.targetCostPerAtc ? 'g-t':'a-t') : '';
    const lpvCls = r.lpvToAtc!=null && tb && tb.lpvToAtc ? (r.lpvToAtc < tb.lpvToAtc*0.8 ? 'b-t' : '') : '';
    return `<div class="trow mt ${sel?'sel':''}" data-line="${esc(g.line)}" data-tier="${esc(g.tier)}" title="${esc(g.v.rule||'')}">
      <div><div class="pname">${esc(b?b.label:g.line)}</div><div class="pcat">${esc(g.tier)}${tb&&tb.est?' · <span class="est">est</span>':''}</div></div>
      <div class="num">${money(r.spend)}<div class="sub">${p?deltaEl(r.spend,p.spend,'neutral'):''}</div></div>
      <div class="num dim">${numf(r.purchases)}</div>
      <div class="num">${d0(r.cpa)}<div class="sub">${p?deltaEl(r.cpa,p.cpa,'low'):''}</div></div>
      <div class="num dim">${tgt}</div>
      <div class="num dim">${kill}</div>
      <div class="num ${roasCls}">${xr(r.roas)}<div class="sub dim">${b&&b.killRoasMeta?xr(b.killRoasMeta):'—'}</div></div>
      <div class="num ${catcCls}">${d2(r.costPerAtc)}<div class="sub dim">${tb&&tb.killCostPerAtc?d0(tb.killCostPerAtc):'—'}</div></div>
      <div class="num ${lpvCls}">${pct(r.lpvToAtc)}<div class="sub dim">${tb&&tb.lpvToAtc?'base '+pct(tb.lpvToAtc):'—'}</div></div>
      <div>${chip(g.v.status)}</div>
    </div>`;
  }).join('');
  wrap.innerHTML=html;
  wrap.querySelectorAll('.trow.mt').forEach(el=>el.onclick=()=>{ S.line=el.dataset.line; S.tier=el.dataset.tier; render(); });
}
/* The selected line's funnel, each stage against its benchmark, and the daily
   CPA / Cost-per-ATC series against the Kill and Target lines. */
function renderFunnel(rows, rg){
  const g = rows.find(x=>x.line===S.line && x.tier===S.tier) || rows[0];
  const wrap=document.getElementById('funnel');
  if(!g){ wrap.innerHTML=''; return; }
  const b=g.bench, tb=g.tier_b, r=g.roll, p=g.prev;
  document.getElementById('funnelLine').textContent = `${b?b.label:g.line} · ${g.tier}`;
  document.getElementById('funnelNote').textContent = (b && b.action) ? b.action : 'cost per landing view → add to cart → purchase';
  const cell=(lbl,val,bench,delta,cls)=>`<div class="fcell ${cls||''}"><div class="l">${lbl}</div><div class="v">${val}</div><div class="s">${bench||''}</div><div class="s">${delta||''}</div></div>`;
  const vsCls=(a,lim,above)=> a==null||lim==null?'' : (above ? (a>lim?'bad':'good') : (a<lim?'bad':'good'));
  wrap.innerHTML = [
    cell('CPV', d2(r.cpv), tb&&tb.cpv?`base ${d2(tb.cpv)}`:'no baseline', p?deltaEl(r.cpv,p.cpv,'low'):'', tb&&tb.cpv&&r.cpv!=null?(r.cpv>tb.cpv*1.2?'warn':''):''),
    cell('LPV → ATC', pct(r.lpvToAtc), tb&&tb.lpvToAtc?`base ${pct(tb.lpvToAtc)}`:'no baseline', p?deltaEl(r.lpvToAtc,p.lpvToAtc,'high'):'', tb&&tb.lpvToAtc&&r.lpvToAtc!=null?(r.lpvToAtc<tb.lpvToAtc*0.8?'bad':''):''),
    cell('Cost / ATC', d2(r.costPerAtc), tb&&tb.killCostPerAtc?`kill ${d0(tb.killCostPerAtc)}${tb.targetCostPerAtc?' · target '+d0(tb.targetCostPerAtc):''}`:'no benchmark', p?deltaEl(r.costPerAtc,p.costPerAtc,'low'):'', tb&&tb.killCostPerAtc?vsCls(r.costPerAtc,tb.killCostPerAtc,true):''),
    cell('ATC → Purchase', pct(r.atcToPurchase), tb?`framework ${pct(tb.atcToPurchase)}${tb.est?' (est)':''}`:'—', p?deltaEl(r.atcToPurchase,p.atcToPurchase,'high'):'', ''),
    cell('CPA', d0(r.cpa), b&&b.kill!=null?`kill ${d0(b.kill)}${b.target!=null?' · target '+d0(b.target):' · INFEASIBLE'}`:'no benchmark', p?deltaEl(r.cpa,p.cpa,'low'):'', b&&b.kill!=null?vsCls(r.cpa,b.kill,true):''),
    cell('ROAS (Meta)', xr(r.roas), b&&b.killRoasMeta?`kill ${xr(b.killRoasMeta)}`:'—', p?deltaEl(r.roas,p.roas,'high'):'', b&&b.killRoasMeta?vsCls(r.roas,b.killRoasMeta,false):''),
  ].join('');
  renderChart(g, rg);
}
function renderChart(g, rg){
  const note=document.getElementById('chartNote');
  if(charts.mt){ charts.mt.destroy(); charts.mt=null; }
  if(!live()){ note.textContent='Daily CPA and Cost per ATC against the Kill and Target lines appear here once Meta is connected — the snapshot has no daily detail.'; return; }
  /* 7-day rolling, so a single day with two purchases does not spike the line;
     the rules themselves read 3-day and 24-hour windows in the alerts panel. */
  const daysBack = Math.max(parseInt(S.win,10), 28);
  const start = addDays(rg.end, -(daysBack-1));
  const daily = liveRows().filter(r=>r.line===g.line && r.tier===g.tier && r.date>=start && r.date<=rg.end);
  const byDate={}; daily.forEach(r=>{ const d=byDate[r.date]||(byDate[r.date]={spend:0,atc:0,purchases:0}); d.spend+=r.spend; d.atc+=r.atc; d.purchases+=r.purchases; });
  const dates=[]; for(let d=start; d<=rg.end; d=addDays(d,1)) dates.push(d);
  const roll = (k, den) => dates.map((d,i)=>{ let s=0,n=0; for(let j=Math.max(0,i-6); j<=i; j++){ const x=byDate[dates[j]]; if(x){ s+=x.spend; n+=x[den]; } } return n? s/n : null; });
  const cpa=roll('spend','purchases'), catc=roll('spend','atc');
  const b=g.bench, tb=g.tier_b;
  const line=(label,data,color,dash,axis)=>Object.assign({type:'line',label,data,borderColor:color,borderWidth:dash?1.4:2.4,pointRadius:0,tension:.3,yAxisID:axis,spanGaps:true}, dash?{borderDash:dash}:{});
  const ds=[ line('CPA (7-day)',cpa,'#f5eb19',null,'y'), line('Cost / ATC (7-day)',catc,'#5ec8ff',null,'y1') ];
  if(b&&b.kill!=null) ds.push(line('Kill CPA',dates.map(()=>b.kill),'rgba(255,90,82,.8)',[6,4],'y'));
  if(b&&b.target!=null) ds.push(line('Target CPA',dates.map(()=>b.target),'rgba(57,217,138,.8)',[6,4],'y'));
  if(tb&&tb.killCostPerAtc) ds.push(line('Kill Cost/ATC',dates.map(()=>tb.killCostPerAtc),'rgba(94,200,255,.5)',[2,3],'y1'));
  const inWin = dates.map(d=> d>=rg.start);
  charts.mt = new Chart(document.getElementById('mtChart'), { data:{labels:dates.map(nice), datasets:ds},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:400},interaction:{mode:'index',intersect:false},
      scales:{ x:{grid:{display:false},ticks:{color:'#9a9193',font:{size:9},maxTicksLimit:10,callback:(v,i)=> inWin[i]? nice(dates[i]) : ''}},
               y:{position:'left',beginAtZero:true,grid:{color:'rgba(255,255,255,.05)'},ticks:{color:'#f5eb19',font:{size:9},callback:v=>'$'+v}},
               y1:{position:'right',beginAtZero:true,grid:{display:false},ticks:{color:'#5ec8ff',font:{size:9},callback:v=>'$'+v}} },
      plugins:{legend:{position:'bottom',labels:{color:'#c9c1c2',boxWidth:10,boxHeight:2,font:{size:9},padding:6}},
               tooltip:{callbacks:{label:i=>`${i.dataset.label}: $${i.raw==null?'—':i.raw.toFixed(i.raw<20?2:0)}`}}}}});
  note.textContent = `7-day rolling · ${nice(start)}–${nice(rg.end)} · the window is the right-hand ${S.win} days · Cost per ATC leads CPA by 3–7 days`;
}
/* The daily rules, applied: PAUSE on a Kill breach, WATCH on a top-of-funnel
   breach, plus the 3-day streaks the framework asks for when the data is daily. */
function renderAlerts(rows, rg){
  const wrap=document.getElementById('alerts');
  const order={PAUSE:0,WATCH:1,OPTIMISE:2,SCALE:3,LOW:4,NONE:5};
  const items=[];
  rows.forEach(g=>{
    if(g.v.status==='NONE'||g.v.status==='LOW') return;
    let extra='';
    if(live() && g.bench && g.bench.kill!=null){
      const dates=[]; for(let d=addDays(rg.end,-6); d<=rg.end; d=addDays(d,1)) dates.push(d);
      const byDate={}; liveRows().filter(r=>r.line===g.line&&r.tier===g.tier).forEach(r=>{ const x=byDate[r.date]||(byDate[r.date]={s:0,p:0,a:0}); x.s+=r.spend; x.p+=r.purchases; x.a+=r.atc; });
      const dailyCpa = dates.map(d=> byDate[d]&&byDate[d].p ? byDate[d].s/byDate[d].p : null);
      const dailyCatc = dates.map(d=> byDate[d]&&byDate[d].a ? byDate[d].s/byDate[d].a : null);
      const sc = DLmeta.streak(dailyCpa, g.bench.kill, true), sa = g.tier_b&&g.tier_b.killCostPerAtc ? DLmeta.streak(dailyCatc, g.tier_b.killCostPerAtc, true) : 0;
      if(sc>=1) extra += ` · CPA above Kill ${sc} day${sc>1?'s':''} running`;
      if(sa>=3) extra += ` · Cost/ATC above Kill ${sa} days running`;
    }
    items.push({ st:g.v.status, name:`${g.bench?g.bench.label:g.line} · ${g.tier}`, rule:(g.v.rule||'')+extra, spend:g.roll.spend });
  });
  items.sort((a,b)=>order[a.st]-order[b.st] || b.spend-a.spend);
  document.getElementById('alertNote').textContent = `${items.filter(i=>i.st==='PAUSE').length} pause · ${items.filter(i=>i.st==='WATCH').length} watch · ${items.filter(i=>i.st==='SCALE').length} scale candidates` + (live()?'':' · snapshot: 90-day averages, not today');
  wrap.innerHTML = items.length ? items.slice(0,8).map(i=>{
    const dot = i.st==='PAUSE'?'b':i.st==='WATCH'?'a':i.st==='SCALE'?'g':'';
    return `<div class="hrow alert"><span class="hdot ${dot||'n'}"></span><span class="hnm"><b>${esc(i.name)}</b><small>${esc(i.rule)}</small></span><span class="hval">${chip(i.st)}</span></div>`;
  }).join('') : `<div class="hrow"><span class="hdot n"></span><span class="hnm" style="grid-column:2/-1">Nothing to act on in this window</span></div>`;
}
function renderRef(){
  const wrap=document.getElementById('refWrap');
  document.querySelectorAll('#refSeg button').forEach(b=>b.classList.toggle('active', b.dataset.ref===S.ref));
  if(S.ref==='econ'){
    const ids=['Diggershield','Pro Enclosure','Excavator Covers','Draw Bar','Pro Mats','Grease','Coupler','Accessories'];
    let h=`<div class="thead mt2"><div>Line</div><div class="num">Cohort</div><div class="num">Entry rev</div><div class="num">LTV</div><div class="num">Margin</div><div class="num">Kill</div><div class="num">Target</div><div class="num">Kill ROAS</div><div>Note</div></div>`;
    h+=ids.map(id=>{ const b=B[id]; return `<div class="trow mt2"><div class="pname">${esc(b.label)}</div>
      <div class="num dim">${b.n?numf(b.n)+' · '+b.months+'mo':'—'}</div><div class="num dim">${d0(b.entryRev)}</div><div class="num dim">${b.ltvMult?b.ltvMult.toFixed(2)+'×':'—'}</div>
      <div class="num dim">${pct(b.margin*100,0)}</div><div class="num">${d0(b.kill)}${b.policy?'†':''}</div><div class="num">${b.target!=null?d0(b.target):'<span class="dim">INFEAS</span>'}</div><div class="num dim">${xr(b.killRoasMeta)}</div>
      <div class="note">${esc(b.note||'')}</div></div>`; }).join('');
    h+=`<div class="refnote">Kill = 12-mo contribution per acquisition · Target = Kill − $${DLmeta.PARAMS.fixedPerOrder} × orders/acq − 15% × 12-mo revenue · Kill ROAS = first-order gross AOV ÷ Kill · † policy cap · fixed $43 / $60 moves Targets by ±$8–10 · targets are new-customer CPA (P&L: 30–40% above blended)</div>`;
    wrap.innerHTML=h; return;
  }
  if(S.ref==='xsell'){
    const X=SNAP.crossPurchase, cats=X.categories.filter(c=>c!=='Hauler');
    let h=`<div class="xhead"><div>entry ↓ then →</div>${cats.map(c=>`<div>${esc(c.replace('Excavator ','Ex ').replace('Pro Enclosure','Pro Encl'))}</div>`).join('')}</div>`;
    h+=cats.map(e=>{ const row=X.rows[e]; if(!row) return `<div class="xrow"><div class="xl">${esc(e)}</div>${cats.map(()=>'<div class="xc dim">—</div>').join('')}</div>`;
      return `<div class="xrow"><div class="xl">${esc(e)} <small>n=${numf(row.n)}</small></div>${cats.map(c=>{ const v=row.attach[c]; const a=v==null?0:Math.min(1,v/21); const diag=c===e;
        return `<div class="xc ${diag?'diag':''}" style="background:rgba(245,235,25,${(a*0.55).toFixed(2)})">${v==null?'—':v.toFixed(1)+'%'}</div>`; }).join('')}</div>`; }).join('');
    h+=`<div class="refnote">% of new customers (entry row) who bought the column category in a later order within 12 months · diagonal = repeat of own category · Grease is the only universal attach (5–8%) · nothing feeds up into Pro Enclosure, Diggershield or Pro Mats (≤2%) — do not inflate acquisition value with imagined upgrade paths</div>`;
    wrap.innerHTML=h; return;
  }
  wrap.innerHTML = `<div class="rules">
    <div><b>Top of funnel (leading, cheap to move)</b><ul>
      <li>Cost per ATC above its Kill line for 3+ days → tighten bid or pause; the CPA breach follows within a week</li>
      <li>LPV→ATC down 20%+ vs baseline → landing page or creative, not bidding</li>
      <li>CPV up while LPV→ATC holds → audience saturation; refresh or expand</li>
      <li>Retargeting LPV→ATC should run 2–3× prospecting; if not, the audience is stale</li></ul></div>
    <div><b>Purchase (the verdict)</b><ul>
      <li>CPA above Kill for 24 hours → PAUSE the ad set. Not monitor. Every day above Kill is money burnt</li>
      <li>CPA between Target and Kill → optimise creative or audience, don’t pause</li>
      <li>CPA at or under Target → scale in 30–50% steps, 7–14 days apart (Diggershield 14–21)</li>
      <li>Meta-reported ROAS below Kill ROAS for 3+ days → pause; same rule, different lens</li>
      <li>Meta shows blended CPA; targets are new-customer CPA. Multiply by the haircut (×1.3–1.4, live from the sheet on this page) before comparing</li></ul></div>
    <div><b>Never</b><ul>
      <li>cold-prospect Grease Packs, Accessories, or Coupler above $26</li>
      <li>bid above Kill “to test” — Kill is break-even</li>
      <li>use the 12-month economics ROAS for daily pausing — use the Meta basis shown here</li>
      <li>assume cross-sell into Pro Enclosure, Diggershield or Pro Mats — the data says it does not happen</li></ul></div>
  </div>`;
}
function renderFooter(rg){
  const src = live() ? `${LIVE.meta.source} · account ${LIVE.meta.account}` : SNAP.meta.source;
  document.getElementById('footSource').innerHTML = `Source: ${esc(src)} · benchmarks derived from the v5.2 cohort (N=${numf(DLmeta.PARAMS.cohortN)}, entered ${DLmeta.PARAMS.cohortEntered}) · fixed $${DLmeta.PARAMS.fixedPerOrder}/order · 15% margin · <b>AUD</b>`;
}

/* ---- live / wiring / init ---- */
function setLive(mode, note){ const dot=document.getElementById('liveDot'),txt=document.getElementById('liveText'),pill=document.getElementById('livePill');
  dot.className='dot '+(mode==='live'?'live':mode==='loading'?'loading':'snap'); txt.textContent=mode==='live'?'Live Meta':mode==='loading'?'Syncing…':'Snapshot';
  if(pill) pill.title = note || 'Data source status'; }
async function tryLive(){
  setLive('loading');
  try{
    const r=await fetch('/api/meta'); if(!r.ok) throw new Error('http-'+r.status);
    const j=await r.json(); if(j.error) throw new Error(j.error);
    if(!j.configured){ setLive('snap','Meta is not connected: set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID in Vercel. Showing the framework’s 90-day snapshot.'); return; }
    if(!(j.rows||[]).length) throw new Error('no rows');
    LIVE=j; S.line=null; render(); setLive('live', `Meta Marketing API · ${j.meta.rows} ad-set days · through ${j.meta.until}`);
  }catch(e){ setLive('snap','Live Meta unavailable ('+(e.message||e)+') — showing the 90-day snapshot.'); }
}
(function init(){
  if(!SNAP){ document.getElementById('errBox').classList.add('show'); return; }
  document.querySelectorAll('#winSeg button').forEach(b=>b.onclick=()=>{ if(b.disabled) return; S.win=b.dataset.win; render(); });
  document.querySelectorAll('#refSeg button').forEach(b=>b.onclick=()=>{ S.ref=b.dataset.ref; renderRef(); });
  window.addEventListener('resize',()=>{clearTimeout(window._rz);window._rz=setTimeout(render,200);});
  render(); setLive('snap');
  if(window.DLmotion) DLmotion.entrance();
  tryLive();
})();
