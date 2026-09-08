/* Offline test: runs the /api/data parsers against the real CSV exports
   (which mirror what the Sheets API returns with FORMATTED_VALUE). */
const fs = require('fs');
const path = require('path');
const api = require('../api/data.js');

function parseCSV(t){
  const rows=[]; let cur=[], c='', q=false;
  for(let i=0;i<t.length;i++){const ch=t[i];
    if(ch==='"'){ if(q&&t[i+1]==='"'){c+='"';i++;} else q=!q; }
    else if(ch===','&&!q){cur.push(c);c='';}
    else if(ch==='\n'&&!q){cur.push(c);rows.push(cur);cur=[];c='';}
    else if(ch==='\r'){} else c+=ch;}
  if(c!==''||cur.length){cur.push(c);rows.push(cur);}
  return rows;
}
const read = f => parseCSV(fs.readFileSync(path.join(__dirname, f), 'utf8'));

const jun = api.parseDaily(read('dl_jun.csv'), 6);
const may = api.parseDaily(read('dl_may.csv'), 5);
const monthly = api.parseMonthly(read('dl_monthly.csv'));

const find = (a,k,v)=>a.find(x=>x[k]===v);
const j1 = find(jun,'date','2026-06-01');
const j30 = find(jun,'date','2026-06-30');
const jan = find(monthly,'month','Jan');

let ok = true;
function check(name, got, want){
  const pass = Math.abs(got-want) < 1;
  if(!pass) ok = false;
  console.log(`${pass?'✓':'✗'} ${name}: ${got} (want ~${want})`);
}
console.log(`Parsed: may=${may.length}d jun=${jun.length}d monthly=${monthly.length}mo`);
check('Jun 1 revenue', j1 && j1.revenue, 16701.63);
check('Jun 1 MER %',   j1 && j1.mer, 26.28);
check('Jun 1 ROAS',    j1 && j1.roas, 3.81);
check('Jun 30 revenue',j30 && j30.revenue, 121560.54);
check('Jun 30 profit', j30 && j30.profit, 38239 /* approx */);
check('Jan revenue',   jan && jan.revenue, 262703.95);
check('Jun month rev', find(monthly,'month','Jun').revenue, 877046.91);
console.log(ok ? '\nALL PASS — serverless parser matches the snapshot.' : '\nFAILED — check row indices.');
process.exit(ok?0:1);
