#!/usr/bin/env python3
"""Extract the 2025 P&L from the Ecommerce Equation v6.0 workbook into prior_year.js.

WHY THIS IS A SEPARATE PARSER FROM api/data.js
----------------------------------------------
The 2025 workbook is template v6.0; 2026 is v7.1, and they are not compatible:

    2025 (v6.0)                       2026 (v7.1)
    metric labels in column A         metric labels in column B
    one "ONLINE STORE" block          six blocks (Country 1-4, TOTAL, WHOLESALE)
    115 rows                          366 rows
    label "REVENUE"                   label "TOTAL Revenue"
    day columns hold Excel serials    day columns hold "1 Jun" text

Running the 2026 label map against a 2025 sheet finds NOTHING — every metric
comes back null. That is the same class of failure that froze this board for 69
days, so the two layouts get two parsers rather than one clever one.

WHY STATIC RATHER THAN A LIVE SHEETS PULL
-----------------------------------------
2025 is closed. It will not change again, so paying for a second live credential,
a second layout in the serverless path, and a second thing that can break at 3am
buys nothing. Extract once, commit the result, move on.

FEB-APR 2025 ARE EMPTY
----------------------
Those tabs exist with correct date headers and blank revenue rows — the months
were never filled in. The extractor reports them as missing rather than emitting
zeros, because a zero month would poison every seasonal index that touches it.

USAGE
    python3 source/build_prior_year.py <path-to-2025.xlsx>
"""
import sys, os, re, json, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xlsx_reader import Book

EPOCH = datetime.date(1899, 12, 30)
MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

# v6.0 labels, read from column A.
LABELS = {
    'revenue': r'^REVENUE\s*$', 'revExGst': r'^Revenue Ex GST', 'gstPct': r'^GST ?%',
    'orders': r'^Orders\s*$', 'newOrders': r'^New Customer Orders', 'items': r'^Items Sold',
    'sessions': r'^Store Sessions', 'cvr': r'^Conversion Rate', 'newPct': r'^New Customer ?%',
    'ipo': r'^Items Per Order', 'aov': r'^Average Order Value', 'cpv': r'^Cost Per Visit',
    'rpv': r'^Revenue Per Visit', 'cpp': r'^Cost Per Purchase', 'ncpa': r'^New Customer CPA',
    'metaNew': r'New Audience.*Meta Ad Spend', 'metaTotal': r'^Total Meta Ad Spend',
    'google': r'^Google Ad Spend', 'tiktok': r'^TikTok Ad Spend', 'totalAds': r'^Total Advertising',
    'mer': r'^MER\b', 'mer3': r'^3-day Rolling MER', 'prodCost': r'^Product Cost',
    'shipCost': r'^Shipping Cost', 'pickPack': r'^Pick Pack', 'packaging': r'^Packaging',
    'txnFees': r'^Transaction Fees', 'merchFees': r'^Merchant Fees',
    'totalVC': r'^Total Variable Costs', 'vcr': r'^VCR\b', 'salaries': r'^Salaries',
    'software': r'^Subscriptions ?& ?Software', 'office': r'^Office', 'totalFC': r'^Total Fixed Costs',
    'fcr': r'^FCR\b', 'returns': r'^Returns\s*$', 'returnsPct': r'^Returns ?%',
    'totalExp': r'^TOTAL EXPENSES', 'profit': r'^PROFIT\s*$', 'profitPct': r'^Profit ?%',
    'roas': r'^Sitewide ROAS', 'fcRev': r'^FORECAST REVENUE',
    'projSpend': r'^PROJECTED MEDIA SPEND', 'fcProfit': r'^FORECAST PROFIT',
}

def serial_to_iso(v):
    try:
        return (EPOCH + datetime.timedelta(days=float(v))).isoformat()
    except (TypeError, ValueError):
        return None

def num(v):
    if v is None or v == '':
        return None
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None

def parse_month(grid, year, month_num):
    """Rows for one month tab, or [] when the month was never filled in."""
    rows = {}
    for i, r in enumerate(grid):
        label = str(r[0]) if r and r[0] else ''
        for key, pat in LABELS.items():
            if key not in rows and re.search(pat, label, re.I):
                rows[key] = i
    header = grid[0] if grid else []
    day_cols = []
    for ci, v in enumerate(header):
        iso = serial_to_iso(v)
        if iso and iso[:7] == '%d-%02d' % (year, month_num):
            day_cols.append((ci, iso))
    out = []
    for ci, iso in day_cols:
        rec = {'date': iso, 'dow': datetime.date.fromisoformat(iso).strftime('%A')}
        for key, ri in rows.items():
            rec[key] = num(grid[ri][ci]) if ri < len(grid) and ci < len(grid[ri]) else None
        # A month that was never filled in has revenue AND sessions blank on every
        # day. Emitting those as zeros would drag every seasonal index that
        # touches them toward zero, so drop them and report the gap instead.
        if rec.get('revenue') or rec.get('sessions'):
            out.append(rec)
    return out

def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    path = sys.argv[1]
    book = Book(path)
    year = 2025
    daily, missing = [], []
    for mi, abbr in enumerate(MONTHS, 1):
        tab = '%s %s' % (abbr, str(year)[2:])
        if tab not in book.sheets:
            missing.append(tab); continue
        rows = parse_month(book.grid(tab), year, mi)
        if not rows:
            missing.append(tab)
        daily += rows
    daily.sort(key=lambda r: r['date'])
    if not daily:
        sys.exit('No rows parsed. Check the workbook layout against LABELS.')

    monthly = {}
    for r in daily:
        m = monthly.setdefault(r['date'][:7], {'month': r['date'][:7], 'days': 0})
        m['days'] += 1
        for k, v in r.items():
            if k in ('date', 'dow') or v is None:
                continue
            # sum flows; ratios are recomputed below from the sums
            if k in ('cvr','newPct','ipo','aov','cpv','rpv','cpp','ncpa','mer','mer3',
                     'vcr','fcr','gstPct','returnsPct','profitPct','roas'):
                continue
            m[k] = round(m.get(k, 0) + v, 2)
    for m in monthly.values():
        rev, orders = m.get('revenue') or 0, m.get('orders') or 0
        ads, sess = m.get('totalAds') or 0, m.get('sessions') or 0
        m['aov'] = round(rev / orders, 2) if orders else None
        m['cvr'] = round(orders / sess * 100, 2) if sess else None
        m['mer'] = round(ads / rev * 100, 2) if rev else None
        m['roas'] = round(rev / ads, 2) if ads else None
        m['profitPct'] = round((m.get('profit') or 0) / rev * 100, 2) if rev else None

    payload = {
        'meta': {
            'source': 'DiggerLid – Calendar %d Ecommerce Equation 6.0 (Accelerate)' % year,
            'year': year, 'currency': 'AUD',
            'extractedOn': datetime.date.today().isoformat(),
            'monthsPresent': sorted(monthly),
            'monthsMissing': missing,
            'note': 'Static. 2025 is closed; template v6.0 puts labels in column A '
                    'and has a single ONLINE STORE block, so it cannot share the '
                    'live v7.1 parser in api/data.js.',
        },
        'daily': daily,
        'monthly': [monthly[k] for k in sorted(monthly)],
    }
    js = ('// Auto-generated from the 2025 Ecommerce Equation workbook. Do not hand-edit.\n'
          '// Regenerate: python3 source/build_prior_year.py <2025.xlsx>\n'
          '// 2025 is closed, so this file is static by design.\n'
          'window.DL_PRIOR = ' + json.dumps(payload, separators=(',', ':')) + ';\n')
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'prior_year.js')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(js)
    print('%d daily rows, %d months (%s)' % (len(daily), len(monthly), ', '.join(sorted(monthly))))
    print('months with no data: %s' % (', '.join(missing) or 'none'))
    print('wrote %s (%s bytes)' % (os.path.normpath(out), format(len(js), ',')))

if __name__ == '__main__':
    main()
