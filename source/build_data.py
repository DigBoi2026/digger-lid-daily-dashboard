#!/usr/bin/env python3
"""Parse the DiggerLid 'Ecommerce Equation' CSV exports into an embedded JS dataset.
Reads the consolidated (all-countries) block. Row indices are fixed by the sheet template.
Verifies known values before writing so a template shift is caught loudly.
"""
import csv, json, re, sys, datetime

YEAR = 2026
MONTHS = {'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,'Jul':7,
          'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12}

# Consolidated ("All Countries") block row indices (0-based) — verified against the sheet.
ROWS = {
  'revenue':62,'revExGst':65,'gstPct':66,'orders':68,'newOrders':69,'items':70,
  'sessions':71,'cvr':73,'newPct':74,'ipo':75,'aov':76,'cpv':77,'rpv':78,'cpp':79,
  'ncpa':80,'metaNew':83,'metaTotal':84,'google':85,'tiktok':86,'totalAds':88,
  'mer':89,'mer3':90,'prodCost':92,'shipCost':93,'packaging':95,'txnFees':96,
  'merchFees':97,'totalVC':98,'vcr':99,'salaries':101,'software':102,'office':103,
  'totalFC':104,'fcr':105,'returns':107,'returnsPct':108,'totalExp':111,'profit':112,
  'profitPct':113,'roas':114,'fcRev':115,'projSpend':119,'fcProfit':123,
}

def num(v):
    if v is None: return None
    s = re.sub(r'[$,%\s]', '', str(v))
    if s in ('','-'): return None
    try: return round(float(s), 2)
    except ValueError: return None

def load(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.reader(f))

def parse_daily(path, mon_abbr):
    rows = load(path)
    header = rows[0]
    dow = rows[1]
    day_cols = [i for i,h in enumerate(header) if re.match(r'^\s*\d{1,2}\s+[A-Za-z]{3}\s*$', h)]
    out = []
    for ci in day_cols:
        daynum = int(re.match(r'^\s*(\d{1,2})', header[ci]).group(1))
        iso = datetime.date(YEAR, MONTHS[mon_abbr], daynum).isoformat()
        rec = {'date': iso, 'label': header[ci].strip(), 'dow': (dow[ci] or '').strip()}
        for k, r in ROWS.items():
            rec[k] = num(rows[r][ci]) if r < len(rows) and ci < len(rows[r]) else None
        # keep only days that actually have activity
        if rec['revenue'] or rec['sessions']:
            out.append(rec)
    return out

def parse_monthly(path):
    rows = load(path)
    header = rows[0]  # col2.. = 'Jan 26','Feb 26',...
    mon_cols = {}
    for i,h in enumerate(header):
        m = re.match(r'^\s*([A-Za-z]{3})\s*\d{2}\s*$', h)
        if m: mon_cols[i] = m.group(1)
    out = []
    for ci, abbr in mon_cols.items():
        rec = {'month': abbr, 'monthNum': MONTHS[abbr], 'label': f"{abbr} {YEAR}"}
        for k, r in ROWS.items():
            rec[k] = num(rows[r][ci]) if r < len(rows) and ci < len(rows[r]) else None
        if rec['revenue']:  # skip empty future months
            out.append(rec)
    out.sort(key=lambda x: x['monthNum'])
    return out

def main():
    months = [('dl_jan.csv','Jan'),('dl_feb.csv','Feb'),('dl_mar.csv','Mar'),
              ('dl_apr.csv','Apr'),('dl_may.csv','May'),('dl_jun.csv','Jun')]
    daily = []
    for f, ab in months:
        daily += parse_daily(f, ab)
    daily.sort(key=lambda x: x['date'])
    monthly = parse_monthly('dl_monthly.csv')

    # ---- verification guards ----
    def find(lst, key, val, tol=1):
        return next((r for r in lst if r.get(key)==val), None)
    j1 = find(daily,'date','2026-06-01')
    j30 = find(daily,'date','2026-06-30')
    jan = find(monthly,'month','Jan')
    assert j1 and abs(j1['revenue']-16701.63)<1, f"June1 rev mismatch: {j1 and j1['revenue']}"
    assert j30 and abs(j30['revenue']-121560.54)<1, f"June30 rev mismatch: {j30 and j30['revenue']}"
    assert jan and abs(jan['revenue']-262703.95)<1, f"Jan monthly mismatch: {jan and jan['revenue']}"
    print(f"OK: {len(daily)} daily rows ({daily[0]['date']}..{daily[-1]['date']}), {len(monthly)} months")

    payload = {
        'meta': {
            'source': "DiggerLid – Calendar 2026 Ecommerce Equation 7.1 (Accelerate)",
            'sheetId': "1rAut5J3SoDvH0ObdVuTenqGjiO-u7M6cPpRNQ5Hqpnw",
            'currency': 'AUD',
            'snapshotDate': datetime.date.today().isoformat(),
            'latestDataDate': daily[-1]['date'],
        },
        'daily': daily,
        'monthly': monthly,
    }
    js = "// Auto-generated snapshot from the DiggerLid Ecommerce Equation sheet.\n"
    js += "// Regenerate with build_data.py. The dashboard also attempts a live refresh at runtime.\n"
    js += "window.DL_DATA = " + json.dumps(payload, separators=(',',':')) + ";\n"
    with open('../data.js','w',encoding='utf-8') as f:
        f.write(js)
    print(f"Wrote data.js ({len(js)} bytes)")

if __name__ == '__main__':
    main()
