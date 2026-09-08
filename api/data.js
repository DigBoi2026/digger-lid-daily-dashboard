/* =========================================================================
   /api/data  —  Vercel Serverless Function (Node).
   Reads the PRIVATE DiggerLid Ecommerce Equation sheet via a Google service
   account and returns the same {meta, daily, monthly} shape the dashboard's
   embedded data.js uses. The browser never touches Google directly.

   Required environment variables (set in Vercel → Project → Settings → Env):
     GOOGLE_SERVICE_ACCOUNT_EMAIL   svc-...@project.iam.gserviceaccount.com
     GOOGLE_PRIVATE_KEY             the key, with literal \n or real newlines
     SHEET_ID                       (optional) defaults to the DiggerLid sheet
     SHEET_YEAR                     (optional) two-digit tab year, default '26'
   The sheet must be shared (Viewer) with GOOGLE_SERVICE_ACCOUNT_EMAIL.
   ========================================================================= */

const DEFAULT_SHEET_ID = '1rAut5J3SoDvH0ObdVuTenqGjiO-u7M6cPpRNQ5Hqpnw';
const YEAR_LABEL = process.env.SHEET_YEAR || '26';
const YEAR_FULL = 2000 + parseInt(YEAR_LABEL, 10);
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Consolidated ("All Countries") block row indices (0-based) — matches build_data.py.
const ROWS = {revenue:62,revExGst:65,gstPct:66,orders:68,newOrders:69,items:70,sessions:71,
  cvr:73,newPct:74,ipo:75,aov:76,cpv:77,rpv:78,cpp:79,ncpa:80,metaNew:83,metaTotal:84,
  google:85,tiktok:86,totalAds:88,mer:89,mer3:90,prodCost:92,shipCost:93,packaging:95,
  txnFees:96,merchFees:97,totalVC:98,vcr:99,salaries:101,software:102,office:103,
  totalFC:104,fcr:105,returns:107,returnsPct:108,totalExp:111,profit:112,profitPct:113,
  roas:114,fcRev:115,projSpend:119,fcProfit:123};

const num = v => {
  if (v == null) return null;
  const s = String(v).replace(/[$,%\s]/g, '');
  if (s === '' || s === '-') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
};

function getClient() {
  const { google } = require('googleapis');
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY || '';
  key = key.replace(/\\n/g, '\n'); // Vercel stores newlines as \n
  if (!email || !key) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY');
  const jwt = new google.auth.JWT(email, null, key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']);
  return google.sheets({ version: 'v4', auth: jwt });
}

// grid = 2D array (rows). Header row 0 has day labels " 1 Jun "; row 1 has day-of-week.
function parseDaily(grid, monthNum) {
  if (!grid || !grid.length) return [];
  const header = grid[0] || [], dow = grid[1] || [];
  const out = [];
  header.forEach((h, ci) => {
    if (!/^\s*\d{1,2}\s+[A-Za-z]{3}\s*$/.test(h || '')) return;
    const dn = parseInt(h.trim(), 10);
    const iso = `${YEAR_FULL}-${String(monthNum).padStart(2,'0')}-${String(dn).padStart(2,'0')}`;
    const rec = { date: iso, label: h.trim(), dow: (dow[ci] || '').trim() };
    for (const k in ROWS) { const r = grid[ROWS[k]]; rec[k] = r ? num(r[ci]) : null; }
    if (rec.revenue != null || rec.sessions != null) out.push(rec);
  });
  return out;
}

function parseMonthly(grid) {
  if (!grid || !grid.length) return [];
  const header = grid[0] || [];
  const cols = {};
  header.forEach((h, ci) => { const m = /^\s*([A-Za-z]{3})\s*\d{2}\s*$/.exec(h || ''); if (m) cols[ci] = m[1]; });
  const out = [];
  for (const ci in cols) {
    const abbr = cols[ci], mn = MONTH_ABBR.indexOf(abbr) + 1;
    const rec = { month: abbr, monthNum: mn, label: `${abbr} ${YEAR_FULL}` };
    for (const k in ROWS) { const r = grid[ROWS[k]]; rec[k] = r ? num(r[ci]) : null; }
    if (rec.revenue) out.push(rec);
  }
  out.sort((a,b) => a.monthNum - b.monthNum);
  return out;
}

module.exports = async (req, res) => {
  try {
    const sheetId = process.env.SHEET_ID || DEFAULT_SHEET_ID;
    const sheets = getClient();

    // Which months to read: current + previous (covers "up to yesterday" + 30-day trend).
    const now = new Date();
    const y = new Date(now); y.setDate(y.getDate() - 1);           // yesterday
    const thisM = y.getMonth();                                    // 0-based
    const monthTabs = [{ name: `${MONTH_ABBR[thisM]} '${YEAR_LABEL}`, num: thisM + 1 }];
    // include the previous month too (for the 30-day trend) — but only within the same
    // sheet year, since only <Mon> 'YEAR_LABEL tabs exist (avoids a non-existent Dec '25 in Jan).
    if (thisM > 0) monthTabs.unshift({ name: `${MONTH_ABBR[thisM-1]} '${YEAR_LABEL}`, num: thisM });

    // A1 notation: wrap sheet names in single quotes and DOUBLE any internal apostrophe
    // (tabs are named like  Jun '26  →  'Jun ''26'  ). Without this the batchGet fails.
    const a1 = name => `'${name.replace(/'/g, "''")}'!A1:AZ131`;
    const cleanRanges = monthTabs.map(m => a1(m.name)).concat([a1(`${YEAR_FULL} Monthly Totals`)]);

    const resp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetId,
      ranges: cleanRanges,
      valueRenderOption: 'FORMATTED_VALUE',   // returns "$16,701.63" / "26.28%" like the CSV export
    });
    const vr = resp.data.valueRanges || [];

    let daily = [];
    monthTabs.forEach((m, i) => { daily = daily.concat(parseDaily(vr[i] && vr[i].values, m.num)); });
    const map = new Map(daily.map(d => [d.date, d]));
    daily = [...map.values()].sort((a,b) => a.date < b.date ? -1 : 1);

    const monthly = parseMonthly(vr[monthTabs.length] && vr[monthTabs.length].values);

    const payload = {
      meta: {
        source: 'DiggerLid – Calendar 2026 Ecommerce Equation 7.1 (Accelerate)',
        sheetId, currency: 'AUD',
        snapshotDate: new Date().toISOString().slice(0,10),
        latestDataDate: daily.length ? daily[daily.length-1].date : null,
        live: true,
      },
      daily, monthly,
    };

    // Edge-cache for an hour; serve stale while revalidating.
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify(payload));
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
};

// Exported for offline testing (see source/test_api_parser.js).
module.exports.parseDaily = parseDaily;
module.exports.parseMonthly = parseMonthly;
module.exports._num = num;
