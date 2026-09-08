/* build_region.js — assemble region_data.js from ShopifyQL geo pulls
   (shipping_country / shipping_region, net_sales, 12 months to Jun 2026).
   Validates AU state totals vs state-month sums, then emits region_data.js. */
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'region_data.js');

const MONTHS = ["2025-07-01","2025-08-01","2025-09-01","2025-10-01","2025-11-01","2025-12-01",
                "2026-01-01","2026-02-01","2026-03-01","2026-04-01","2026-05-01","2026-06-01"];
const MLABEL = ["Jul '25","Aug '25","Sep '25","Oct '25","Nov '25","Dec '25",
                "Jan '26","Feb '26","Mar '26","Apr '26","May '26","Jun '26"];
const mIdx = Object.fromEntries(MONTHS.map((m,i)=>[m,i]));

// fresh total net_sales per month (all countries) = catMonthly sums
const totalMonthly = [251725.60,233532.58,189695.00,324727.29,650840.68,256287.66,
                      239596.45,298748.71,301354.30,331417.84,400329.33,778274.51];

// country 12-month totals (net)
const countries = [
  ["Australia",3761498.63],["United States",164031.85],["New Zealand",135950.24],
  ["United Kingdom",66848.99],["Canada",57853.62],["France",13750.11],["Italy",13544.28],
  ["Switzerland",9695.88],["Portugal",8451.72],["Germany",5781.87],["Ireland",3421.04],
  ["Austria",3311.23],["Croatia",2799.44],["Spain",2485.72]
];

// AU state 12-month totals: [name, abbr, net, orders, items]
const auStateTotals = [
  ["New South Wales","NSW",1124437.56,4278,38072],
  ["Queensland","QLD",978605.94,3567,34349],
  ["Victoria","VIC",750987.61,2890,24736],
  ["Western Australia","WA",455457.15,1600,15070],
  ["South Australia","SA",262865.42,954,8235],
  ["Tasmania","TAS",117101.96,373,2918],
  ["Australian Capital Territory","ACT",39087.57,147,1201],
  ["Northern Territory","NT",32955.42,102,1193]
];
const ABBR = Object.fromEntries(auStateTotals.map(r=>[r[0],r[1]]));

// AU & NZ net + orders by month
const countryMonth = [
  ["New Zealand","2025-07-01",15570.92,27],["Australia","2025-07-01",213975.79,635],
  ["New Zealand","2025-08-01",13771.75,30],["Australia","2025-08-01",203957.9,619],
  ["Australia","2025-09-01",171250.49,588],["New Zealand","2025-09-01",8962.32,20],
  ["New Zealand","2025-10-01",17201.43,43],["Australia","2025-10-01",268776.04,964],
  ["Australia","2025-11-01",481360.67,1854],["New Zealand","2025-11-01",34119.78,73],
  ["New Zealand","2025-12-01",2984.86,7],["Australia","2025-12-01",200705.49,822],
  ["New Zealand","2026-01-01",5819.87,12],["Australia","2026-01-01",196851.37,716],
  ["Australia","2026-02-01",263013.35,937],["New Zealand","2026-02-01",9364.42,20],
  ["Australia","2026-03-01",288751.32,1009],["New Zealand","2026-03-01",3780.96,11],
  ["Australia","2026-04-01",319071.3,1033],["New Zealand","2026-04-01",3152.89,6],
  ["New Zealand","2026-05-01",4323.17,8],["Australia","2026-05-01",390627.95,1532],
  ["New Zealand","2026-06-01",16897.87,40],["Australia","2026-06-01",747322.6,3146]
];

// AU state net by month
const stateMonth = [
  ["Northern Territory","2025-07-01",1331.81],["Western Australia","2025-07-01",22944.86],["Queensland","2025-07-01",55078],["Tasmania","2025-07-01",7012.84],["New South Wales","2025-07-01",64222.37],["Australian Capital Territory","2025-07-01",2774.48],["Victoria","2025-07-01",47544.14],["South Australia","2025-07-01",13067.29],
  ["Queensland","2025-08-01",55209.46],["New South Wales","2025-08-01",65553.89],["Australian Capital Territory","2025-08-01",453.64],["Tasmania","2025-08-01",6123.23],["South Australia","2025-08-01",8453.48],["Western Australia","2025-08-01",29026.61],["Victoria","2025-08-01",37958.56],["Northern Territory","2025-08-01",1179.03],
  ["Victoria","2025-09-01",27938.4],["Australian Capital Territory","2025-09-01",1530.98],["Queensland","2025-09-01",46348.17],["Western Australia","2025-09-01",18123.92],["Tasmania","2025-09-01",4702.61],["Northern Territory","2025-09-01",680],["South Australia","2025-09-01",7789.71],["New South Wales","2025-09-01",64136.7],
  ["Victoria","2025-10-01",50691.9],["Northern Territory","2025-10-01",2810.99],["Tasmania","2025-10-01",9757.14],["Queensland","2025-10-01",66709.51],["New South Wales","2025-10-01",85037.67],["Australian Capital Territory","2025-10-01",6088.3],["Western Australia","2025-10-01",31211.38],["South Australia","2025-10-01",16469.15],
  ["Western Australia","2025-11-01",54406.69],["Northern Territory","2025-11-01",3039.29],["Tasmania","2025-11-01",19272.79],["Queensland","2025-11-01",119935.4],["Australian Capital Territory","2025-11-01",5051.67],["Victoria","2025-11-01",108468.43],["New South Wales","2025-11-01",136010.18],["South Australia","2025-11-01",35176.22],
  ["Tasmania","2025-12-01",9994.88],["Queensland","2025-12-01",57090.51],["Western Australia","2025-12-01",23368.28],["Northern Territory","2025-12-01",541.91],["Australian Capital Territory","2025-12-01",2059.22],["New South Wales","2025-12-01",52851.03],["South Australia","2025-12-01",12463.74],["Victoria","2025-12-01",42335.92],
  ["Australian Capital Territory","2026-01-01",3034.86],["South Australia","2026-01-01",17211.98],["Northern Territory","2026-01-01",2152.63],["New South Wales","2026-01-01",60890.12],["Queensland","2026-01-01",46971.1],["Western Australia","2026-01-01",24574.15],["Victoria","2026-01-01",38724.3],["Tasmania","2026-01-01",3292.23],
  ["Tasmania","2026-02-01",4396.25],["New South Wales","2026-02-01",84303.02],["South Australia","2026-02-01",16862.47],["Australian Capital Territory","2026-02-01",1269.08],["Northern Territory","2026-02-01",1453.99],["Western Australia","2026-02-01",38832.67],["Queensland","2026-02-01",69637.78],["Victoria","2026-02-01",46258.09],
  ["Victoria","2026-03-01",56288.77],["Northern Territory","2026-03-01",1955.52],["New South Wales","2026-03-01",93266.84],["Queensland","2026-03-01",67843.28],["South Australia","2026-03-01",22805.15],["Tasmania","2026-03-01",5866.36],["Western Australia","2026-03-01",37138.09],["Australian Capital Territory","2026-03-01",3587.31],
  ["Western Australia","2026-04-01",51272.43],["Queensland","2026-04-01",80207.56],["New South Wales","2026-04-01",91116.37],["Australian Capital Territory","2026-04-01",4034.25],["Tasmania","2026-04-01",6414.22],["Victoria","2026-04-01",53958.27],["Northern Territory","2026-04-01",9383.98],["South Australia","2026-04-01",22684.22],
  ["Australian Capital Territory","2026-05-01",2599.67],["Western Australia","2026-05-01",39638.36],["South Australia","2026-05-01",29250.31],["New South Wales","2026-05-01",107948.28],["Tasmania","2026-05-01",10983.76],["Northern Territory","2026-05-01",4115.88],["Queensland","2026-05-01",108836.82],["Victoria","2026-05-01",87254.87],
  ["South Australia","2026-06-01",58142.53],["Australian Capital Territory","2026-06-01",6604.11],["New South Wales","2026-06-01",215035.44],["Queensland","2026-06-01",200134.73],["Tasmania","2026-06-01",29285.65],["Western Australia","2026-06-01",83447.72],["Victoria","2026-06-01",150729.47],["Northern Territory","2026-06-01",3942.95]
];

// US / UK / Canada net by month (for the by-country breakdown; missing month = 0)
const extraCountryMonth = [
  ["United States","2025-07-01",14796.21],["Canada","2025-07-01",6653.71],
  ["United States","2025-08-01",6406.25],["United Kingdom","2025-08-01",729.69],["Canada","2025-08-01",2707.21],
  ["Canada","2025-09-01",5090.17],["United Kingdom","2025-09-01",2296.57],
  ["Canada","2025-10-01",3269.13],["United Kingdom","2025-10-01",11499.03],["United States","2025-10-01",5695.11],
  ["United States","2025-11-01",40659.12],["Canada","2025-11-01",21917.43],["United Kingdom","2025-11-01",32840.12],
  ["United Kingdom","2025-12-01",8135.46],["United States","2025-12-01",25688.04],["Canada","2025-12-01",7089.04],
  ["United States","2026-01-01",23916.93],["United Kingdom","2026-01-01",2876.66],["Canada","2026-01-01",4548.67],
  ["Canada","2026-02-01",2111.6],["United States","2026-02-01",18231],["United Kingdom","2026-02-01",5372.11],
  ["United States","2026-03-01",6613.73],["United Kingdom","2026-03-01",869.38],
  ["United Kingdom","2026-04-01",2106.45],["Canada","2026-04-01",1325.43],["United States","2026-04-01",5794.7],
  ["United Kingdom","2026-05-01",-1029.93],["United States","2026-05-01",5613.32],["Canada","2026-05-01",868.59],
  ["Canada","2026-06-01",2272.64],["United States","2026-06-01",9686.46],["United Kingdom","2026-06-01",1153.45]
];

// ---- assemble ----
const auMonthly = MONTHS.map(m=>{const r=countryMonth.find(x=>x[0]==='Australia'&&x[1]===m); return {net:r?r[2]:0, orders:r?r[3]:0};});
const nzMonthly = MONTHS.map(m=>{const r=countryMonth.find(x=>x[0]==='New Zealand'&&x[1]===m); return {net:r?r[2]:0, orders:r?r[3]:0};});
const cMonth = c => MONTHS.map(m=>{const r=extraCountryMonth.find(x=>x[0]===c&&x[1]===m); return r?r[2]:0;});
const countryMonthly = {
  "Australia": auMonthly.map(x=>x.net),
  "United States": cMonth("United States"),
  "New Zealand": nzMonthly.map(x=>x.net),
  "United Kingdom": cMonth("United Kingdom"),
  "Canada": cMonth("Canada")
};
// Other = total − the five named countries (remaining countries + null-shipping). Clamp tiny negatives.
countryMonthly["Other"] = MONTHS.map((_,i)=>{
  const named = ["Australia","United States","New Zealand","United Kingdom","Canada"].reduce((a,c)=>a+countryMonthly[c][i],0);
  return Math.max(0, Math.round((totalMonthly[i]-named)*100)/100);
});

const stateMonthly = {};
auStateTotals.forEach(([name,abbr])=>stateMonthly[abbr]=Array(12).fill(0));
stateMonth.forEach(([name,m,net])=>{ if(mIdx[m]!=null) stateMonthly[ABBR[name]][mIdx[m]] += net; });

// ---- reconcile: the state-TOTALS pull (UNTIL 2026-07-01) catches a Jul-1 sliver the
// month-grouped pull buckets into Jul'26 (dropped). So emit each state's net from the
// month sums (reconciles exactly with AU-monthly + the trend chart); keep orders/items
// from the totals pull for AOV context (~0.3% higher — the sliver — which is negligible).
const stateNet = {};
let maxDrift=0;
auStateTotals.forEach(([name,abbr,tot])=>{
  const s = stateMonthly[abbr].reduce((a,b)=>a+b,0);
  stateNet[abbr] = Math.round(s*100)/100;
  maxDrift = Math.max(maxDrift, Math.abs(s-tot)/tot*100);
});
const auSum = auMonthly.reduce((a,x)=>a+x.net,0);
const stateSum = Object.values(stateMonthly).reduce((a,arr)=>a+arr.reduce((x,y)=>x+y,0),0);
console.error(`AU 12-mo (country-month) ${auSum.toFixed(0)} vs Σstate-month ${stateSum.toFixed(0)}  Δ ${(auSum-stateSum).toFixed(0)}  (must be ~0)`);
console.error(`state totals-pull vs month-sum drift: max ${maxDrift.toFixed(2)}% (Jul-1 sliver on small states; expected <2%)`);
if(Math.abs(auSum-stateSum) > 2 || maxDrift > 2){ console.error('*** unexpected drift — aborting'); process.exit(1); }

// sanity: country-breakdown stacks back to the monthly total (Other absorbs the tail)
const cmSum = MONTHS.map((_,i)=>Object.values(countryMonthly).reduce((a,arr)=>a+arr[i],0));
const cmDrift = Math.max(...cmSum.map((s,i)=>Math.abs(s-totalMonthly[i])/totalMonthly[i]*100));
console.error(`countryMonthly stacks to total: max drift ${cmDrift.toFixed(2)}% (Other bucket; expect ~0)`);

const num = n => Math.round(n*100)/100;
const out = `// Shopify geographic snapshot — ShopifyQL sales by shipping_country / shipping_region.
// 12 months to Jun 2026. Read-only. Regenerate via source/build_region.js.
window.DL_REGION = {
  meta: { source:"Shopify · ShopifyQL (shipping geo)", currency:"AUD", asOf:"2026-07-02", window:"12 months to Jun 2026" },
  months: ${JSON.stringify(MLABEL)},
  totalMonthly: ${JSON.stringify(totalMonthly)},
  countries: [${countries.map(([c,n])=>`{c:${JSON.stringify(c)},net:${n}}`).join(',')}],
  countryMonthly: {${Object.entries(countryMonthly).map(([c,arr])=>`${JSON.stringify(c)}:[${arr.map(num).join(',')}]`).join(',\n                   ')}},
  au: {
    states: [${auStateTotals.map(([n,a,net,o,i])=>`{name:${JSON.stringify(n)},abbr:"${a}",net:${stateNet[a]},orders:${o},items:${i}}`).join(',\n              ')}],
    monthly: ${JSON.stringify(auMonthly.map(x=>({net:num(x.net),orders:x.orders})))},
    stateMonthly: {${Object.entries(stateMonthly).map(([a,arr])=>`${a}:[${arr.map(num).join(',')}]`).join(',\n                   ')}}
  },
  nz: { monthly: ${JSON.stringify(nzMonthly.map(x=>({net:num(x.net),orders:x.orders})))} }
};
if (typeof module !== 'undefined' && module.exports) module.exports = window.DL_REGION;
`;
fs.writeFileSync(OUT, out);
console.error(`\nWrote ${OUT}`);
