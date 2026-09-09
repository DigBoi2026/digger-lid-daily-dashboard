/* =========================================================================
   DiggerLid — Daily Pulse. "Was yesterday OK?" for one selected day.
   Sources: sheet P&L daily (DL_DATA) + PostHog site signals (DL_PULSE).
   Each signal compares the day against three baselines:
     · 3d  = average of the 3 days before it
     · 30d = average of up to 30 days before it (whatever history exists)
     · wk  = average of the same weekday, previous 4 weeks
   Status (explainable, direction-aware):
     ISSUE  adverse ≥25% vs BOTH 3d and 30d
     WATCH  adverse ≥12% vs both, or ≥25% vs one
     OK     otherwise      LOW = volume too small to judge that day
   ========================================================================= */

const SHEET = window.DL_DATA || null;
const PULSE = window.DL_PULSE || null;
let charts = { ctx: null };
const S = { day: null, ctxMetric: 'revenue' };

/* ---------- formatters ---------- */
const money=(n,c=true)=>{ if(n==null||isNaN(n))return '—';
  if(c){const a=Math.abs(n); if(a>=1e6)return '$'+(n/1e6).toFixed(2)+'M'; if(a>=1e3)return '$'+(n/1e3).toFixed(a>=1e4?0:1)+'K'; return '$'+Math.round(n);}
  return n.toLocaleString('en-AU',{style:'currency',currency:'AUD',maximumFractionDigits:0}); };
const numf=n=>n==null||isNaN(n)?'—':Math.round(n).toLocaleString('en-AU');
const pctf=(n,d=1)=>n==null||isNaN(n)?'—':n.toFixed(d)+'%';
const per1k=n=>n==null||isNaN(n)?'—':n.toFixed(1)+'/1k';
const MONTH=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW=["SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"];
const nice=iso=>{const[,m,d]=iso.split('-').map(Number);return d+' '+MONTH[m-1];};
const dowOf=iso=>DOW[new Date(iso+'T00:00:00Z').getUTCDay()];

/* ---------- series registry ----------
   Every signal exposes {dates, vals, dens} — consecutive daily arrays. */
const sheetDates = SHEET ? SHEET.daily.map(d=>d.date) : [];
const sheetIdx = new Map(sheetDates.map((d,i)=>[d,i]));
/* PENDING vs ZERO — the general rule, replacing a guard that covered one metric.

   This used to read `(key==='ncpa' && !v) ? null : v` with the comment "$0 CPA =
   artifact, not data". That instinct was right and the cause is shared: the P&L
   sheet is filled in stages, so an ad-spend row that has not been typed in yet
   makes every formula under it evaluate to $0.00. New-customer CPA was the only
   metric protected, so it correctly showed "no data" while MER sat at 0.0% and
   was scored as a 100% IMPROVEMENT, and profit margin — computed without the
   missing spend — read 18.3%, "+416% vs 3-day avg", on a day that was closer to
   a 25% loss.

   api/data.js now flags those days (see PENDING vs ZERO there). A flagged value
   contributes nothing: no baseline, no delta, no verdict. It reads "no data",
   which is the truth. */
const PENDING_KEYS = {
  adSpend: ['mer','mer3','roas','cpv','cpp','ncpa','metaTotal','metaNew','totalAds'],
  profit:  ['profit','profitPct','totalExp'],
};
function isPendingFor(rec, key){
  if(!rec || !rec.pending) return false;
  return rec.pending.some(g => (PENDING_KEYS[g]||[]).includes(key));
}
const sheetSeries = key => ({ dates: sheetDates,
  vals: SHEET.daily.map(r=>{
    if(isPendingFor(r, key)) return null;          // waiting on the sheet, not a zero
    const v=r[key]; if(v==null) return null;
    return (key==='ncpa' && !v) ? null : v;        // kept: a $0 CPA is an artifact either way
  }),
  dens: null });

let pIdx = PULSE ? new Map(PULSE.days.map((d,i)=>[d,i])) : new Map();
function pulseRate(numKey, denKey, mult=1){
  const N=PULSE.series[numKey], D=PULSE.series[denKey];
  return { dates: PULSE.days,
    vals: N.map((n,i)=> (n==null||D[i]==null||!D[i]) ? null : n/D[i]*mult),
    dens: D };
}
const pulseRaw = key => ({ dates: PULSE.days, vals: PULSE.series[key].slice(), dens: null });

/* ---------- baseline engine ---------- */
const mean = a => { const v=a.filter(x=>x!=null); return v.length? v.reduce((x,y)=>x+y,0)/v.length : null; };
function baselines(sig, iso){
  const ser = sig.ser || sig;                 // signals carry series under .ser; ad-hoc calls pass it inline
  const i = ser.dates.indexOf(iso);
  if(i<0) return null;
  const y = ser.vals[i];
  const prev = (from,n) => { const out=[]; for(let k=1;k<=n;k++){ if(from-k<0)break; out.push(ser.vals[from-k]); } return out; };
  const b3 = mean(prev(i,3).slice(0,3));
  const w30 = prev(i,30), n30 = w30.filter(v=>v!=null).length;
  const b30 = n30>=7 ? mean(w30) : null;
  const wk=[]; for(let k=1;k<=4;k++){ const j=i-7*k; if(j>=0) wk.push(ser.vals[j]); }
  const bwk = wk.filter(v=>v!=null).length>=2 ? mean(wk) : null;
  const den = ser.dens ? ser.dens[i] : null;
  return { y, b3, b30, bwk, n30, den };
}
const deltaPct=(y,b)=> (y==null||b==null||!b) ? null : (y-b)/Math.abs(b)*100;
function judge(sig, iso){
  const b = baselines(sig, iso);
  if(!b || b.y==null) return { status:'nodata' };
  const d3=deltaPct(b.y,b.b3), d30=deltaPct(b.y,b.b30), dwk=deltaPct(b.y,b.bwk);
  const adv = d => d==null?null:(sig.dir==='low'? d : -d);           // positive = adverse
  const a3=adv(d3), a30=adv(d30);
  let status='ok';
  if(sig.minDen && b.den!=null && b.den < sig.minDen) status='low';
  else if(a3!=null&&a30!=null&&a3>=25&&a30>=25) status='issue';
  else if((a3!=null&&a30!=null&&a3>=12&&a30>=12) || (a3!=null&&a3>=25) || (a30!=null&&a30>=25)) status='watch';
  return { ...b, d3, d30, dwk, a3, a30, status };
}

/* ---------- signal config ---------- */
function buildSignals(){
  const list=[];
  if(SHEET){
    const s=(key,label,dir,fmt)=>list.push({key,label,dir,fmt,src:'Sheet',ser:sheetSeries(key)});
    s('cvr','Conversion rate','high',v=>pctf(v,2));
    s('sessions','Sessions','high',numf);
    s('rpv','Revenue / visit','high',v=>money(v,false));
    s('aov','Avg order value','high',v=>money(v,false));
    s('mer','MER (spend ÷ revenue)','low',v=>pctf(v,1));
    s('ncpa','New-customer CPA','low',v=>money(v,false));
    s('newPct','New-customer share','high',v=>pctf(v,0));
    s('profitPct','Profit margin','high',v=>pctf(v,1));
  }
  if(PULSE){
    const p=(cfg)=>list.push({...cfg, src:'Site'});
    p({key:'atcRate', label:'Add-to-cart rate', dir:'high', fmt:v=>pctf(v,1), ser:pulseRate('atc','sessions',100), minDen:300});
    p({key:'coStart', label:'Cart → checkout rate', dir:'high', fmt:v=>pctf(v,1), ser:pulseRate('checkoutStarted','atc',100), minDen:60});
    p({key:'coDone', label:'Checkout completion', dir:'high', fmt:v=>pctf(v,0), ser:pulseRate('orders','checkoutStarted',100), minDen:25});
    p({key:'errRate', label:'JS errors', dir:'low', fmt:per1k, ser:pulseRate('errors','pageviews',1000), minDen:500});
    p({key:'rageRate', label:'Rage clicks', dir:'low', fmt:per1k, ser:pulseRate('rageclicks','pageviews',1000), minDen:500});
    p({key:'deadRate', label:'Dead clicks', dir:'low', fmt:per1k, ser:pulseRate('deadclicks','pageviews',1000), minDen:500});
  }
  return list;
}
let SIGNALS = buildSignals();   // rebuilt after a live upgrade (series are captured by value)
const evalAll = iso => SIGNALS.map(sig=>({sig, r: judge(sig, iso)}));

/* ---------- day navigation ---------- */
const computeAllDays = () => [...new Set([...sheetDates, ...(PULSE?PULSE.days:[])])].sort();
let allDays = computeAllDays();
function rebuildIndexes(){                     // after a live upgrade of either source
  sheetIdx.clear(); sheetDates.forEach((d,i)=>sheetIdx.set(d,i));
  pIdx = PULSE ? new Map(PULSE.days.map((d,i)=>[d,i])) : new Map();
  allDays = computeAllDays();
}
function defaultDay(){
  // newest day with ANY data across both sources (site signals usually run ahead of the sheet).
  return allDays.length ? allDays[allDays.length-1] : null;
}

/* ============================ RENDER ============================ */
function render(){
  if(!S.day){ document.getElementById('errBox').classList.add('show'); return; }
  const iso=S.day, evals=evalAll(iso);
  document.getElementById('navDate').textContent = nice(iso);
  document.getElementById('navDow').textContent = dowOf(iso)+' · DAILY PULSE';
  const newest = PULSE ? PULSE.days[PULSE.days.length-1] : sheetDates[sheetDates.length-1];
  document.getElementById('throughVal').textContent = nice(newest);
  document.getElementById('jumpNewest').classList.toggle('show', iso < newest);
  const i=allDays.indexOf(iso);
  document.getElementById('prevBtn').disabled = i<=0;
  document.getElementById('nextBtn').disabled = i>=allDays.length-1;
  renderVerdict(evals, iso); renderKPIs(iso); renderSignals(evals, iso);
  renderFunnel(iso); renderHealth(iso); renderChannels(iso); renderCtx(iso);
  document.getElementById('footSource').innerHTML =
    `Sources: ${SHEET?SHEET.meta.source:'—'} · ${PULSE?PULSE.meta.source+' (tracking from '+nice(PULSE.meta.trackedFrom)+')':''}`;
  if(window.DLmotion) DLmotion.countUpAll();
}

/* ---- verdict banner ---- */
function renderVerdict(evals, iso){
  const scored = evals.filter(e=>['ok','watch','issue'].includes(e.r.status));
  const issues = scored.filter(e=>e.r.status==='issue');
  const watches = scored.filter(e=>e.r.status==='watch');
  const dot=document.getElementById('vDot'), head=document.getElementById('vHead'),
        sub=document.getElementById('vSub'), right=document.getElementById('vRight');
  const worst = (e)=>{ const a=Math.max(e.r.a3||0,e.r.a30||0);
    return `${e.sig.label} ${e.r.d3!=null?fmtDelta(e.r.d3,e.sig.dir,true):''} vs 3-day avg`; };
  if(issues.length){
    dot.style.color='var(--bad)'; dot.style.background='var(--bad)';
    head.textContent = `${issues.length} issue${issues.length>1?'s':''} detected — worth a look today`;
    sub.textContent = issues.slice(0,2).map(worst).join(' · ') + (issues.length>2?` · +${issues.length-2} more`:'');
  } else if(watches.length){
    dot.style.color='var(--warn)'; dot.style.background='var(--warn)';
    head.textContent = `No critical issues — ${watches.length} metric${watches.length>1?'s':''} drifting`;
    sub.textContent = watches.slice(0,3).map(e=>e.sig.label).join(' · ')+' moved against trend; see below';
  } else if(scored.length){
    dot.style.color='var(--good)'; dot.style.background='var(--good)';
    head.textContent = 'All clear — no unusual movement';
    sub.textContent = 'Every tracked signal is within its normal range for this day';
  } else {
    dot.style.color='var(--muted)'; dot.style.background='var(--muted)';
    head.textContent = 'Not enough data for this day';
    sub.textContent = 'Step to a day with data, or connect the live sources';
  }
  const sheetHas = sheetIdx.has(iso);
  if(!sheetHas && SHEET) sub.textContent += ` · business metrics end ${nice(sheetDates[sheetDates.length-1])} (site signals only)`;
  right.innerHTML = [
    issues.length ? `<span class="v-chip b-t">${issues.length} ISSUE${issues.length>1?'S':''}</span>` : '',
    watches.length ? `<span class="v-chip a-t">${watches.length} WATCH</span>` : '',
    `<span class="v-chip g-t">${scored.filter(e=>e.r.status==='ok').length} OK</span>`
  ].join('');
}
function fmtDelta(d,dir,signedWord=false){
  if(d==null) return '—';
  const s=(d>=0?'+':'')+d.toFixed(0)+'%';
  return s;
}

/* ---- KPI strip (sheet, day vs 3d avg, 14-day spark) ---- */
function renderKPIs(iso){
  const el=document.getElementById('kpis');
  const hasSheet = sheetIdx.has(iso), hasPulse = PULSE && pIdx.has(iso);
  // Each tile: sheet series first; if the sheet doesn't cover the day, fall back to the
  // PostHog equivalent where one exists (labelled "site"), else say so plainly.
  const pulseSessions = hasPulse ? pulseRaw('sessions') : null;
  const pulseOrders   = hasPulse ? pulseRaw('orders')   : null;
  const pulseCvr      = hasPulse ? pulseRate('orders','sessions',100) : null;
  const tiles=[
    {lbl:'Revenue',    fmt:v=>money(v,true), dir:'high', accent:true,  sheet:'revenue'},
    {lbl:'Meta Spend', fmt:v=>money(v,true), dir:null,                 sheet:'metaTotal'},
    {lbl:'Net Profit', fmt:v=>money(v,true), dir:'high',               sheet:'profit'},
    {lbl:'Orders',     fmt:numf,             dir:'high',               sheet:'orders',   alt:pulseOrders},
    {lbl:'Sessions',   fmt:numf,             dir:'high',               sheet:'sessions', alt:pulseSessions},
    {lbl:'Conversion', fmt:v=>pctf(v,2),     dir:'high',               sheet:'cvr',      alt:pulseCvr},
  ];
  const sparks=[];
  el.innerHTML = tiles.map((t,ti)=>{
    let ser=null, tag='';
    if(hasSheet) ser=sheetSeries(t.sheet);
    else if(t.alt){ ser=t.alt; tag=' · site'; }
    if(!ser) return `<div class="kpi"><div class="k-head"><div class="k-lbl">${t.lbl}</div>
      <div class="k-val">—</div><div class="k-sub">no sheet data</div></div><div class="k-foot"></div></div>`;
    const b=judge({ser, dir:t.dir||'high'}, iso);
    const y=b.y, d3=b.d3;
    const cls = t.dir==null ? 'flat' : (d3==null?'flat' : (t.dir==='high'? (d3>=0?'up':'down') : (d3<=0?'up':'down')));
    const ar = d3==null?'—':(d3>=0?'▲':'▼');
    sparks.push({ti, ser});
    // Distinguish "the sheet hasn't been filled in yet" from "there is no such
    // number". A bare dash reads as a fault; "pending" reads as a queue.
    const row = hasSheet ? SHEET.daily[sheetIdx.get(iso)] : null;
    const waiting = y==null && isPendingFor(row, t.sheet);
    return `<div class="kpi ${t.accent?'accent':''}"><div class="k-head"><div class="k-lbl">${t.lbl}${tag}</div>
      <div class="k-val">${y==null?(waiting?'pending':'—'):t.fmt(y)}</div>
      <div class="k-sub">${waiting?'not yet entered':'&nbsp;'}</div></div>
      <div class="k-foot"><span class="delta ${cls}">${ar} ${d3==null?'—':Math.abs(d3).toFixed(1)+'%'}</span><span class="k-per">${waiting?'awaiting sheet entry':'vs 3-day avg'}</span></div>
      <canvas class="spark" data-ti="${ti}"></canvas></div>`;
  }).join('');
  el.querySelectorAll('canvas.spark').forEach(cv=>{
    const s=sparks.find(x=>String(x.ti)===cv.dataset.ti); if(!s) return;
    const i=s.ser.dates.indexOf(iso);
    DLcore.sparkline(cv, s.ser.vals.slice(Math.max(0,i-13), i+1), null);
  });
}

/* ---- signals table ---- */
function renderSignals(evals, iso){
  const order={issue:0, watch:1, ok:2, low:3, nodata:4};
  const rows=[...evals].sort((a,b)=>order[a.r.status]-order[b.r.status]);
  document.getElementById('sigList').innerHTML = rows.map(({sig,r})=>{
    if(r.status==='nodata') return `<div class="sigrow"><span class="hdot" style="background:var(--line)"></span>
      <span class="snm">${sig.label}<span class="src">${sig.src}</span></span>
      <span class="sval num dim">—</span><span class="sdelta num dim">no data</span><span></span><span></span></div>`;
    const dotCls = r.status==='issue'?'b':r.status==='watch'?'a':r.status==='low'?'':'g';
    const cell=(d)=>{ if(d==null) return `<span class="sdelta num dim">—</span>`;
      const adverse = sig.dir==='low' ? d>0 : d<0;
      const cls = Math.abs(d)<5 ? 'dim' : adverse ? 'b-t' : 'g-t';
      return `<span class="sdelta num ${cls}">${d>=0?'+':''}${d.toFixed(0)}%</span>`; };
    const note = r.status==='issue'||r.status==='watch'
      ? `<div class="snote">${sig.dir==='low'?'higher':'lower'} than normal — ${r.d3!=null?fmtDelta(r.d3)+' vs 3-day':''}${r.d30!=null?' · '+fmtDelta(r.d30)+' vs 30-day':''}${r.n30<30?' ('+r.n30+'d of history)':''}</div>` : '';
    return `<div class="sigrow ${r.status}">
      <span class="hdot ${dotCls}" ${r.status==='low'?'style="background:var(--line)"':''}></span>
      <span class="snm">${sig.label}<span class="src">${sig.src}</span></span>
      <span class="sval num">${sig.fmt(r.y)}</span>
      ${cell(r.d3)}${cell(r.d30)}${cell(r.dwk)}
      ${note}
    </div>`;
  }).join('');
}

/* ---- funnel + site health (pulse) ---- */
function hRow(label, val, delta, dir){
  const adverse = delta==null?null:(dir==='low'? delta>0 : delta<0);
  const cls = delta==null?'':Math.abs(delta)>=25&&adverse?'b':Math.abs(delta)>=12&&adverse?'a':'g';
  const tcls = cls? cls+'-t':'';
  return `<div class="hrow"><span class="hdot ${cls||'g'}" ${delta==null?'style="background:var(--line)"':''}></span>
    <span class="hnm">${label}</span>
    <span class="hval">${val}</span>
    <small class="hstate ${tcls}" ${delta==null?'style="border-color:var(--line);color:var(--muted)"':''}>${delta==null?'—':(delta>=0?'+':'')+delta.toFixed(0)+'%'}</small></div>`;
}
function renderFunnel(iso){
  const wrap=document.getElementById('funnelWrap');
  if(!PULSE || !pIdx.has(iso)){ wrap.innerHTML=`<div class="hrow"><span class="hdot" style="background:var(--line)"></span><span class="hnm" style="grid-column:2/-1">No site data for this day (tracking from ${PULSE?nice(PULSE.meta.trackedFrom):'—'})</span></div>`; return; }
  const rows=[['Session → cart','atc','sessions',100,1],['Cart → checkout','checkoutStarted','atc',100,1],
    ['Checkout → order','orders','checkoutStarted',100,0],['Session → order','orders','sessions',100,2]];
  wrap.innerHTML = rows.map(([lbl,n,d,m,dec])=>{
    const ser=pulseRate(n,d,m), b=judge({...{dir:'high'}, dates:ser.dates, vals:ser.vals, dens:ser.dens}, iso);
    return hRow(lbl, b.y==null?'—':b.y.toFixed(dec)+'%', b.d3, 'high');
  }).join('');
}
function renderHealth(iso){
  const wrap=document.getElementById('healthWrap');
  if(!PULSE || !pIdx.has(iso)){ wrap.innerHTML=`<div class="hrow"><span class="hdot" style="background:var(--line)"></span><span class="hnm" style="grid-column:2/-1">No site data for this day</span></div>`; return; }
  const i=pIdx.get(iso);
  const rows=[['JS errors','errors'],['Rage clicks','rageclicks'],['Dead clicks','deadclicks']];
  wrap.innerHTML = rows.map(([lbl,key])=>{
    const ser=pulseRate(key,'pageviews',1000), b=judge({dir:'low', dates:ser.dates, vals:ser.vals, dens:ser.dens}, iso);
    const raw=PULSE.series[key][i];
    return hRow(`${lbl} <small style="color:var(--muted)">· ${raw==null?'—':numf(raw)}</small>`,
      b.y==null?'—':b.y.toFixed(1)+'/1k', b.d3, 'low');
  }).join('');
}

/* ---- channels ---- */
function renderChannels(iso){
  const wrap=document.getElementById('chanList');
  if(!PULSE || !pIdx.has(iso)){ wrap.innerHTML=`<div class="catrow"><div class="cinfo"><div class="cname">No site data for this day</div></div></div>`; return; }
  // Channel attribution (the sessions table) can lag a few hours, so yesterday's split
  // may not be materialised yet. If the day totals 0, fall back to the latest day that has it.
  const dayTot = idx => Object.values(PULSE.channels).reduce((a,v)=>a+(v[idx]||0),0);
  let i=pIdx.get(iso), useIso=iso;
  if(dayTot(i)===0){ let j=i-1; while(j>=0 && dayTot(j)===0) j--; if(j>=0){ i=j; useIso=PULSE.days[j]; } }
  document.getElementById('chanNote').textContent = useIso===iso
    ? 'sessions · day vs 3-day avg'
    : `attribution pending — showing ${nice(useIso)}`;
  const rows=Object.entries(PULSE.channels).map(([name,vals])=>{
    const b=judge({dir:'high', dates:PULSE.days, vals}, useIso);
    return {name, y:vals[i], d3:b.d3};
  }).filter(r=>r.y!=null).sort((a,b)=>b.y-a.y);
  const max=Math.max(...rows.map(r=>r.y),1);
  wrap.innerHTML = rows.map(r=>{
    const adverse=r.d3!=null&&r.d3<=-15, bad=r.d3!=null&&r.d3<=-30;
    const dcls=bad?'b-t':adverse?'a-t':(r.d3!=null&&r.d3>=15?'g-t':'');
    return `<div class="catrow">
      <div class="bar" style="width:${Math.max(r.y/max*100,1.5)}%"></div>
      <div class="cinfo"><div class="cname">${r.name}</div></div>
      <div class="cright"><div class="cnet">${numf(r.y)}</div>
        <div class="cshare ${dcls}">${r.d3==null?'—':(r.d3>=0?'+':'')+r.d3.toFixed(0)+'% vs 3d'}</div></div>
    </div>`;
  }).join('');
}

/* ---- day-in-context chart ---- */
const CTX_METRICS=[
  {key:'revenue', label:'Revenue', src:'sheet', fmt:v=>'$'+(v/1000).toFixed(0)+'K'},
  {key:'sessions', label:'Sessions', src:'sheet', fmt:v=>numf(v)},
  {key:'atcRate', label:'ATC rate', src:'pulse', fmt:v=>v.toFixed(1)+'%'},
  {key:'errRate', label:'Errors', src:'pulse', fmt:v=>v.toFixed(0)+'/1k'},
];
function ctxSeries(m){
  if(m.src==='sheet') return sheetSeries(m.key);
  if(m.key==='atcRate') return pulseRate('atc','sessions',100);
  return pulseRate('errors','pageviews',1000);
}
function renderCtx(iso){
  const m=CTX_METRICS.find(x=>x.key===S.ctxMetric)||CTX_METRICS[0];
  document.getElementById('ctxSeg').innerHTML=CTX_METRICS.map(x=>
    `<button data-m="${x.key}" class="${x.key===S.ctxMetric?'active':''}">${x.label}</button>`).join('');
  document.querySelectorAll('#ctxSeg button').forEach(b=>b.onclick=()=>{S.ctxMetric=b.dataset.m; renderCtx(S.day);});
  let ser=ctxSeries(m), i=ser.dates.indexOf(iso);
  if(i<0 || ser.vals[i]==null){
    // selected metric has no data this day — auto-switch to the first metric that does
    const alt=CTX_METRICS.find(x=>{ const s=ctxSeries(x); const j=s.dates.indexOf(iso); return j>=0 && s.vals[j]!=null; });
    if(alt && alt.key!==m.key){ S.ctxMetric=alt.key; return renderCtx(iso); }
  }
  const wrap=document.getElementById('ctxWrap');
  if(i<0){ if(charts.ctx){charts.ctx.destroy();charts.ctx=null;} wrap.querySelector('canvas').getContext('2d').clearRect(0,0,9999,9999); return; }
  const from=Math.max(0,i-29);
  const labels=ser.dates.slice(from,i+1).map(nice), data=ser.vals.slice(from,i+1);
  const b=judge({dir:'high',dates:ser.dates,vals:ser.vals}, iso);
  const cfg={type:'bar', data:{labels, datasets:[
      {data, backgroundColor:data.map((_,k)=>k===data.length-1?'#f5eb19':'rgba(245,235,25,0.28)'),
       borderColor:data.map((_,k)=>k===data.length-1?'#f5eb19':'transparent'), borderWidth:1, borderRadius:2, order:2},
      ...(b.b30!=null?[{type:'line', data:Array(labels.length).fill(b.b30), borderColor:'rgba(255,255,255,0.55)',
        borderDash:[6,4], borderWidth:1.4, pointRadius:0, order:1, label:'30d avg'}]:[]),
      ...(b.b3!=null?[{type:'line', data:Array(labels.length).fill(b.b3), borderColor:'rgba(255,138,74,0.8)',
        borderDash:[2,3], borderWidth:1.4, pointRadius:0, order:0, label:'3d avg'}]:[])
    ]},
    options:{responsive:true, maintainAspectRatio:false, animation:{duration:500},
      scales:{x:{grid:{display:false}, ticks:{color:'#9a9193', font:{size:8.5}, maxTicksLimit:10}},
              y:{beginAtZero:true, grid:{color:'rgba(255,255,255,0.05)'}, ticks:{color:'#9a9193', font:{size:9}}}},
      plugins:{legend:{display:b.b30!=null||b.b3!=null, position:'bottom',
          labels:{color:'#9a9193', boxWidth:14, boxHeight:2, font:{size:9},
            filter:it=>it.text==='30d avg'||it.text==='3d avg'}},
        tooltip:{callbacks:{label:c=> c.dataset.label ? `${c.dataset.label}: ${m.fmt(c.raw)}` : m.fmt(c.raw)}}}}};
  if(charts.ctx) charts.ctx.destroy();
  charts.ctx=new Chart(document.getElementById('ctxChart'), cfg);
}

/* ---- live upgrade (sheet API; pulse API is a follow-up) ---- */
function setLive(mode,note){ const dot=document.getElementById('liveDot'),txt=document.getElementById('liveText'),
    pill=document.getElementById('livePill');
  const cls=mode==='live'?'live':mode==='loading'?'loading':mode==='partial'?'partial':'snap';
  dot.className='dot '+cls;
  txt.textContent=mode==='live'?'Live':mode==='loading'?'Syncing…':mode==='partial'?'Partial':'Snapshot';
  if(pill) pill.title = note || 'Data source status'; }
async function tryLive(){
  setLive('loading');
  let sheetLive=false, pulseLive=false;
  const onNewest = S.day===defaultDay();
  // Sheet P&L (Daily Ops source)
  if(SHEET){
    try{
      const r=await fetch('/api/data');
      if(r.ok){ const j=await r.json();
        if(j&&j.daily&&j.daily.length){
          const map=new Map(SHEET.daily.map(d=>[d.date,d]));
          j.daily.forEach(d=>map.set(d.date,d));
          SHEET.daily=[...map.values()].sort((a,b)=>a.date<b.date?-1:1);
          sheetDates.length=0; sheetDates.push(...SHEET.daily.map(d=>d.date));
          sheetLive=true;
        } }
    }catch(e){}
  }
  // PostHog site signals
  if(PULSE){
    try{
      const r=await fetch('/api/pulse');
      if(r.ok){ const j=await r.json();
        if(j&&j.days&&j.series&&!j.error){
          PULSE.days=j.days; PULSE.series=j.series;
          if(j.channels && Object.keys(j.channels).length) PULSE.channels=j.channels;
          if(j.meta) PULSE.meta={...PULSE.meta, ...j.meta};
          pulseLive=true;
        } }
    }catch(e){}
  }
  // A source only counts as "expected" if the page actually has that dataset.
  const want = (SHEET?1:0) + (PULSE?1:0), got = (sheetLive?1:0) + (pulseLive?1:0);
  if(got){ rebuildIndexes(); SIGNALS=buildSignals(); if(onNewest) S.day=defaultDay(); render(); }
  if(!got){ setLive('snap'); return; }
  if(got===want){ setLive('live'); return; }
  // Partial: at least one source refreshed but another is down. Never claim "Live"
  // here — the sheet P&L half of this page would be stale or blank while the pill
  // says otherwise. Name the failed source so the gap is explainable at a glance.
  const stale = !sheetLive ? 'sheet P&L' : 'site signals';
  const asOf  = !sheetLive && SHEET && sheetDates.length ? ' (frozen at '+sheetDates[sheetDates.length-1]+')' : '';
  setLive('partial', 'Partial refresh — '+stale+' unavailable'+asOf+'. Showing the embedded snapshot for that source.');
}

/* ---- wiring / init ---- */
function step(dir){ const i=allDays.indexOf(S.day)+dir;
  if(i>=0&&i<allDays.length){ S.day=allDays[i]; render(); } }
(function init(){
  if(!SHEET && !PULSE){ document.getElementById('errBox').classList.add('show'); return; }
  S.day = defaultDay();
  document.getElementById('prevBtn').onclick=()=>step(-1);
  document.getElementById('nextBtn').onclick=()=>step(1);
  document.getElementById('jumpNewest').onclick=()=>{ S.day = allDays[allDays.length-1]; render(); };
  window.addEventListener('keydown',e=>{ if(e.key==='ArrowLeft')step(-1); if(e.key==='ArrowRight')step(1); });
  window.addEventListener('resize',()=>{clearTimeout(window._rz);window._rz=setTimeout(render,200);});
  render(); setLive('snap');
  if(window.DLmotion) DLmotion.entrance();
  tryLive();
  // Keep it current: re-pull every 20 min, and whenever the tab regains focus. tryLive
  // rebuilds the day list and (if the viewer is on the newest day) jumps to the new
  // previous-full-day — so a tab left open across the daily rollover self-updates.
  setInterval(tryLive, 20*60*1000);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) tryLive(); });
})();
