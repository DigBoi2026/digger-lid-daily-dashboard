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

/* The sheet is laid out as a stack of 59-row blocks — one per country, plus a
   consolidated "TOTAL" and a "WHOLESALE" — with the metric labels in column B
   and the block heading in column A. Row 240 is TOTAL in the 2026 template.

   This used to be a map of fixed row indices calibrated against an older
   template. Optional rows have since been inserted inside the blocks
   ("Subscription Revenue", "New Audience" Spend, "Pick Pack (3PL)"), so the map
   drifted progressively — +1 at Revenue, +2 at Orders, +5 at Meta Spend — and
   pointed into Country 2's block, which is all zeros. Every figure read as
   blank while /api/health still reported the sheet reachable.

   Matching on the labels instead means an inserted row cannot break it again. */
const LABELS = {
  revenue:    /^TOTAL Revenue$/i,
  revExGst:   /^Revenue Ex GST/i,
  gstPct:     /^GST ?%/i,
  orders:     /^Orders$/i,
  newOrders:  /^New Customer Orders/i,
  items:      /^Items Sold/i,
  sessions:   /^Store Sessions/i,
  cvr:        /^Conversion Rate/i,
  newPct:     /^New Customer ?%/i,
  ipo:        /^Items Per Order/i,
  aov:        /^Average Order Value/i,
  cpv:        /^Cost Per Visit/i,
  rpv:        /^Revenue Per Visit/i,
  cpp:        /^Cost Per Purchase/i,
  ncpa:       /^New Customer CPA/i,
  metaNew:    /New Audience.*Spend/i,
  metaTotal:  /^Total Meta Ad Spend/i,
  google:     /^Google Ad Spend/i,
  tiktok:     /^TikTok Ad Spend/i,
  totalAds:   /^Total Advertising/i,
  mer:        /^MER\b/i,
  mer3:       /^3-day Rolling MER/i,
  prodCost:   /^Product Cost/i,
  shipCost:   /^Shipping Cost/i,
  pickPack:   /^Pick Pack/i,
  packaging:  /^Packaging/i,
  txnFees:    /^Transaction Fees/i,
  merchFees:  /^Merchant Fees/i,
  totalVC:    /^Total Variable Costs/i,
  vcr:        /^VCR\b/i,
  salaries:   /^Salaries/i,
  software:   /^Subscriptions ?& ?Software/i,
  office:     /^Office/i,
  totalFC:    /^Total Fixed Costs/i,
  fcr:        /^FCR\b/i,
  returns:    /^Returns$/i,
  returnsPct: /^Returns ?%/i,
  totalExp:   /^TOTAL EXPENSES/i,
  profit:     /^PROFIT$/i,
  profitPct:  /^Profit ?%/i,
  roas:       /^Sitewide ROAS/i,
  fcRev:      /^Forecast Revenue/i,
  /* The sheet's row is "PROJECTED MEDIA SPEND". /^Projected Spend/ never matched
     it, so projSpend came back null on every single day and the Meta Spend row
     of the Pace panel has always read "no forecast" — not because there is no
     forecast, but because nothing ever looked in the right place. */
  projSpend:  /^Projected\b.*\bSpend/i,
  fcProfit:   /^Forecast Profit/i,
};

// Kept only so the drift is legible in diagnostics; nothing reads from it.
const LEGACY_ROWS = { revenue: 62, sessions: 71, orders: 68 };

const cellAt = (grid, r, c) => String((grid[r] && grid[r][c]) || '').trim();

// Every block head — a column-B "TOTAL Revenue" — with its column-A heading.
function findBlocks(grid) {
  const out = [];
  for (let r = 0; r < grid.length; r++) {
    if (!/^total\s+revenue\b/i.test(cellAt(grid, r, 1))) continue;
    let heading = '';
    for (let b = r - 1; b >= 0 && b > r - 8; b--) {
      const h = cellAt(grid, b, 0);
      if (h) { heading = h.split('\n')[0].trim(); break; }
    }
    out.push({ row: r, heading });
  }
  return out;
}

/* The consolidated block, which is what the dashboard has always meant to show.
   Falls back to the first block (Country 1) if no TOTAL heading exists, since a
   single-market sheet has no consolidated row and Country 1 is then the whole
   business. */
function chooseBlock(blocks) {
  return blocks.find(b => /^total\b/i.test(b.heading)) || blocks[0] || null;
}

// metric -> grid row, by label, searching only within the chosen block.
function mapRows(grid, start, end) {
  const map = {};
  for (const k in LABELS) map[k] = null;
  for (let r = start; r < end && r < grid.length; r++) {
    const label = cellAt(grid, r, 1);
    if (!label) continue;
    for (const k in LABELS) if (map[k] === null && LABELS[k].test(label)) map[k] = r;
  }
  return map;
}

// The chosen block's row map for a grid, or null when no block is present.
function blockRows(grid) {
  const blocks = findBlocks(grid);
  const chosen = chooseBlock(blocks);
  if (!chosen) return null;
  const next = blocks.find(b => b.row > chosen.row);
  const end = next ? next.row : chosen.row + 70;
  return { chosen, blocks, rows: mapRows(grid, chosen.row, end) };
}

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
  // Requires a positive trading signal, not merely a non-null cell. The TOTAL
  // block carries $0.00 rather than a blank for days that have not happened
  // yet, so accepting a zero here put latestDataDate on 30 Sep — three weeks
  // into the future — and filled every trailing window with future zeros.
  // A real day that took no money still records sessions; a future day is 0
  // across all three.
  return (rec.revenue != null && rec.revenue > 0)
      || (rec.orders != null && rec.orders > 0)
      || (rec.sessions != null && rec.sessions > 0);
}

/* ------------------------------------------------------------------------
   PENDING vs ZERO

   The P&L sheet is filled in stages. Revenue, orders and sessions arrive from
   Shopify and analytics; Meta ad spend is typed in by hand, a day later. An
   unfilled spend row does NOT read blank — every formula beneath it evaluates
   to $0.00 — so a day that is only half entered is indistinguishable, cell by
   cell, from a day that genuinely spent nothing.

   Treating that as a real zero is what made 2026-09-08 report a 0.0% MER, a
   4.24x ROAS, a "Scale" spend signal, and an 18.3% profit margin (+416% vs the
   3-day average) on a day that, once its spend is entered, is closer to a 25%
   LOSS. The board was telling its reader to spend more, off a blank cell.

   So: anything computed from an input that has not been filled in yet is
   PENDING, not zero. Nothing downstream should average it, sum it, compare it
   to a baseline, or colour a traffic light with it.

   This generalises a guard that already existed for exactly one metric in
   daily.js ("$0 CPA = artifact, not data") to every field that shares the
   cause.
   ------------------------------------------------------------------------ */

// Inputs that arrive late, and everything that cannot be computed without them.
const AD_INPUTS  = ['metaNew', 'metaTotal', 'google', 'tiktok', 'totalAds'];
const AD_DERIVED = ['mer', 'mer3', 'roas', 'cpv', 'cpp', 'ncpa'];

// A day that took money, or had traffic, is a real trading day.
function isTrading(rec) {
  return rec.revenue > 0 || rec.orders > 0 || rec.sessions > 0;
}

/* Flag what a day is still waiting on, and blank the fields that would
   otherwise carry a fabricated zero.

   PROFIT is deliberately left populated. It is the sheet's own figure and the
   only one available, but it is computed without the missing spend, so it is
   overstated rather than absent — it gets flagged, not blanked, and the pages
   label it provisional. */
function markPending(rec) {
  const pending = [];
  if (isTrading(rec) && !(rec.totalAds > 0)) {
    pending.push('adSpend', 'profit');
    AD_INPUTS.forEach(k => { rec[k] = null; });
    AD_DERIVED.forEach(k => { rec[k] = null; });
  }
  rec.pending = pending.length ? pending : null;
  return rec;
}

// The newest date that carries real data — NOT simply the last row present.
function lastDataDate(daily) {
  for (let i = daily.length - 1; i >= 0; i--) if (hasData(daily[i])) return daily[i].date;
  return null;
}

function parseDaily(grid, monthNum) {
  if (!grid || !grid.length) return [];
  const blk = blockRows(grid);
  if (!blk) return [];
  const header = grid[0] || [], dow = grid[1] || [];
  const out = [];
  header.forEach((h, ci) => {
    if (!/^\s*\d{1,2}\s+[A-Za-z]{3}\s*$/.test(h || '')) return;
    const dn = parseInt(h.trim(), 10);
    const iso = `${YEAR_FULL}-${String(monthNum).padStart(2,'0')}-${String(dn).padStart(2,'0')}`;
    const rec = { date: iso, label: h.trim(), dow: (dow[ci] || '').trim() };
    for (const k in blk.rows) {
      const r = blk.rows[k];
      rec[k] = r == null ? null : num(cellAt(grid, r, ci));
    }
    if (hasData(rec)) out.push(markPending(rec));
  });
  return out;
}

function parseMonthly(grid) {
  if (!grid || !grid.length) return [];
  const blk = blockRows(grid);
  if (!blk) return [];
  const header = grid[0] || [];
  const out = [];
  header.forEach((h, ci) => {
    const m = /^\s*([A-Za-z]{3})\s*\d{2}\s*$/.exec(h || '');
    if (!m) return;
    const abbr = m[1], mn = MONTH_ABBR.indexOf(abbr) + 1;
    const rec = { month: abbr, monthNum: mn, label: `${abbr} ${YEAR_FULL}` };
    for (const k in blk.rows) {
      const r = blk.rows[k];
      rec[k] = r == null ? null : num(cellAt(grid, r, ci));
    }
    if (rec.revenue) out.push(rec);
  });
  out.sort((a,b) => a.monthNum - b.monthNum);
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

  // Every "TOTAL Revenue" row is the head of one block. Report each with the
  // nearest column-A heading above it and the value in the first day column, so
  // the right block can be identified against build_data.py's known anchor
  // (June 1 revenue = 16701.63) instead of guessed at.
  const header = (grid[0] || []);
  const firstDayCol = header.findIndex(h => /^\s*\d{1,2}\s+[A-Za-z]{3}\s*$/.test(h || ''));
  const blocks = [];
  for (let r = 0; r < grid.length; r++) {
    if (!/^total\s+revenue\b/i.test(cell(r, 1))) continue;
    let head = '';
    for (let b = r - 1; b >= 0 && b > r - 8; b--) { const h = cell(b, 0); if (h) { head = h.slice(0, 40); break; } }
    blocks.push({
      revenueRow: r,
      heading: head,
      firstDay: firstDayCol >= 0 ? header[firstDayCol] : null,
      firstDayValue: firstDayCol >= 0 ? cell(r, firstDayCol) : null,
    });
  }

  const expected = LEGACY_ROWS;
  const revRow = found.revenue && found.revenue.row;
  return {
    gridRows: grid.length,
    dayColumns: (grid[0] || []).filter(h => /^\s*\d{1,2}\s+[A-Za-z]{3}\s*$/.test(h || '')).length,
    found, expected, blocks,
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

/* The payload builder, shared by this route and the AI read subsystem, so both
   see exactly the same parsing. */
async function buildData({ diag = false } = {}) {

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
    const allTitles = (meta.data.sheets || []).map(sh => sh.properties && sh.properties.title).filter(Boolean);
    const titles = new Set(allTitles);
    const missing = monthTabs.filter(m => !titles.has(m.name)).map(m => m.name);
    const tabs = monthTabs.filter(m => titles.has(m.name));
    const monthlyTab = `${YEAR_FULL} Monthly Totals`;
    const haveMonthly = titles.has(monthlyTab);

    if (!tabs.length) throw new Error(`No month tabs found. Looked for: ${monthTabs.map(m => m.name).join(', ')}`);

    // A1 notation: wrap sheet names in single quotes and DOUBLE any internal apostrophe
    // (tabs are named like  Jun '26  →  'Jun ''26'  ). Without this the batchGet fails.
    // A1:AZ131 stopped mid-way through the third country block, so any
// consolidated block below it was never read at all.
const a1 = name => `'${name.replace(/'/g, "''")}'!A1:AZ400`;
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
    if (!daily.length || diag) {
      payload.diag = { tabsMissing: missing };
      /* Every tab in the workbook, not just the ones this route reads. The list
         was already being fetched to avoid a batchGet failure and then thrown
         away, which meant there was no way to discover a tab nobody had thought
         to look for — a campaign calendar, a prior year, a product plan. */
      payload.diag.allTabs = allTitles;
      tabs.forEach((m, i) => { payload.diag[m.name] = probe(vr[i] && vr[i].values); });
      if (haveMonthly) payload.diag[monthlyTab] = probe(vr[tabs.length] && vr[tabs.length].values);
    }

  return payload;
}

module.exports = async (req, res) => {
  try {
    const payload = await buildData({ diag: !!(req.query && req.query.diag) });
    // Edge-cache for an hour; serve stale while revalidating.
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send(JSON.stringify(payload));
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
};

// Exported for offline testing (see source/test_api_parser.js).
module.exports.buildData = buildData;
module.exports.parseDaily = parseDaily;
module.exports.parseMonthly = parseMonthly;
module.exports.hasData = hasData;
module.exports.lastDataDate = lastDataDate;
module.exports.probe = probe;
module.exports.findBlocks = findBlocks;
module.exports.chooseBlock = chooseBlock;
module.exports.blockRows = blockRows;
module.exports._num = num;
module.exports.markPending = markPending;
module.exports.isTrading = isTrading;
module.exports.AD_INPUTS = AD_INPUTS;
module.exports.AD_DERIVED = AD_DERIVED;
