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
// A month tab is pre-built for the whole month, so future days exist as empty
// columns. Those columns still carry a literal 0 in some rows (sessions, in the
// sheet as it stands), and `!= null` treated that as data — so a blank Sep tab
// produced 30 rows that looked real, pushed latestDataDate to 30 Sep, and filled
// every trailing window with nothing. Require an actual trading signal instead.
function hasData(rec) {
  return rec.revenue != null || rec.orders != null || (rec.sessions != null && rec.sessions > 0);
}

// The newest date that carries real data — NOT simply the last row present.
function lastDataDate(daily) {
  for (let i = daily.length - 1; i >= 0; i--) if (hasData(daily[i])) return daily[i].date;
  return null;
}

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
    if (hasData(rec)) out.push(rec);
  });
  return out;
}

/* Where does the metric block actually start? ROWS is a hardcoded map calibrated
   against the Jun '26 tab; inserting a row anywhere above it silently shifts every
   metric and the route then reads blanks while still reporting "reachable". This
   reads the labels in column A and says whether they are where we expect, so an
   empty result can be told apart from a misaligned one without opening the sheet. */
const SCAN_COLS = 8;   // labels are not necessarily in column A

function probe(grid) {
  if (!grid || !grid.length) return { gridRows: 0 };
  const cell = (r, c) => String((grid[r] && grid[r][c]) || '').trim();

  // Search the leading columns, not just A. The first version of this probe only
  // looked at column A, reported "different tab layout" for every tab including
  // Jun '26 (which build_data.py parsed successfully), and so could not say where
  // the block actually is.
  const findCell = re => {
    for (let r = 0; r < grid.length; r++)
      for (let c = 0; c < SCAN_COLS; c++)
        if (re.test(cell(r, c))) return { row: r, col: c };
    return null;
  };
  const found = {
    revenue:  findCell(/^revenue\b/i),
    sessions: findCell(/^sessions\b/i),
    orders:   findCell(/^orders\b/i),
    netSales: findCell(/^net\s+sales\b/i),
    totalSales: findCell(/^total\s+sales\b/i),
  };

  // The first non-empty leading cell of each row: enough to read the tab's real
  // layout, and text labels only — no figures leave the sheet.
  const rowLabels = {};
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < SCAN_COLS; c++) {
      const v = cell(r, c);
      if (v) { rowLabels[r] = 'c' + c + ':' + v.slice(0, 44); break; }
    }
  }

  const expected = { revenue: ROWS.revenue, sessions: ROWS.sessions, orders: ROWS.orders };
  const revRow = found.revenue && found.revenue.row;
  return {
    gridRows: grid.length,
    dayColumns: (grid[0] || []).filter(h => /^\s*\d{1,2}\s+[A-Za-z]{3}\s*$/.test(h || '')).length,
    found, expected,
    labelledRows: Object.keys(rowLabels).length,
    rowLabels,
    verdict: !found.revenue
      ? 'no Revenue/Net Sales/Total Sales label in the first ' + SCAN_COLS + ' columns — read rowLabels to find the real layout'
      : revRow === expected.revenue
        ? 'row offsets correct — the tab has no figures entered'
        : 'row offsets SHIFTED by ' + (revRow - expected.revenue) + ' (Revenue at grid row ' + revRow
          + ', column ' + found.revenue.col + ') — update ROWS in api/data.js',
  };
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
    // Read the current month plus the three before it. Two months only covered the
    // 30-day trend and left anything older to the embedded snapshot — so once the
    // snapshot went stale there was an unbridgeable hole (July, in 2026-09) that
    // the 90-day window spanned in silence. Still bounded to this sheet year,
    // since only <Mon> 'YEAR_LABEL tabs exist.
    const MONTHS_BACK = 3;
    const monthTabs = [];
    for (let back = MONTHS_BACK; back >= 0; back--) {
      const mi = thisM - back;
      if (mi < 0) continue;
      monthTabs.push({ name: `${MONTH_ABBR[mi]} '${YEAR_LABEL}`, num: mi + 1 });
    }

    // batchGet rejects the WHOLE request if any range names a tab that does not
    // exist, so ask which tabs are there first. Reading more months would
    // otherwise turn a working route into a 500 the first time a tab is missing.
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: sheetId, fields: 'sheets.properties.title',
    });
    const titles = new Set((meta.data.sheets || []).map(sh => sh.properties && sh.properties.title));
    const missing = monthTabs.filter(m => !titles.has(m.name)).map(m => m.name);
    const tabs = monthTabs.filter(m => titles.has(m.name));
    const monthlyTab = `${YEAR_FULL} Monthly Totals`;
    const haveMonthly = titles.has(monthlyTab);

    if (!tabs.length) throw new Error(`No month tabs found. Looked for: ${monthTabs.map(m => m.name).join(', ')}`);

    // A1 notation: wrap sheet names in single quotes and DOUBLE any internal apostrophe
    // (tabs are named like  Jun '26  →  'Jun ''26'  ). Without this the batchGet fails.
    const a1 = name => `'${name.replace(/'/g, "''")}'!A1:AZ131`;
    const cleanRanges = tabs.map(m => a1(m.name)).concat(haveMonthly ? [a1(monthlyTab)] : []);

    const resp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sheetId,
      ranges: cleanRanges,
      valueRenderOption: 'FORMATTED_VALUE',   // returns "$16,701.63" / "26.28%" like the CSV export
    });
    const vr = resp.data.valueRanges || [];

    let daily = [];
    tabs.forEach((m, i) => { daily = daily.concat(parseDaily(vr[i] && vr[i].values, m.num)); });
    const map = new Map(daily.map(d => [d.date, d]));
    daily = [...map.values()].sort((a,b) => a.date < b.date ? -1 : 1);

    const monthly = haveMonthly ? parseMonthly(vr[tabs.length] && vr[tabs.length].values) : [];

    const payload = {
      meta: {
        source: 'DiggerLid – Calendar 2026 Ecommerce Equation 7.1 (Accelerate)',
        sheetId, currency: 'AUD',
        snapshotDate: new Date().toISOString().slice(0,10),
        latestDataDate: lastDataDate(daily),
        monthsRead: tabs.map(m => m.name),
        monthsMissing: missing,
        live: true,
      },
      daily, monthly,
    };

    // When nothing parsed, say why rather than returning an empty shell that the
    // board renders as blank panels under a green "Live" pill.
    if (!daily.length || req.query && req.query.diag) {
      payload.diag = { tabsMissing: missing };
      tabs.forEach((m, i) => { payload.diag[m.name] = probe(vr[i] && vr[i].values); });
      if (haveMonthly) payload.diag[monthlyTab] = probe(vr[tabs.length] && vr[tabs.length].values);
    }

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
module.exports.hasData = hasData;
module.exports.lastDataDate = lastDataDate;
module.exports.probe = probe;
module.exports._num = num;
