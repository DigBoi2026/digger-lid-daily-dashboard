#!/usr/bin/env python3
"""Regenerate data.js — the dashboard's embedded fallback snapshot.

The snapshot is what every page falls back to when Google or Shopify is
unreachable, so it has to be both current and correct.

WHY THIS PULLS FROM /api/data RATHER THAN CSV EXPORTS
-----------------------------------------------------
This script used to read hand-exported CSVs with a hardcoded row map:

    ROWS = {'revenue': 62, 'sessions': 71, ...}

Those indices were correct when the sheet had one country block. The workbook
now has six — Country 1-4, TOTAL and WHOLESALE — and every index had drifted
onto the empty Country 2 block. Row 62 landed on a blank "Note:" row and row 71
on Country 2's New Customer Orders ($0.00), which is exactly the
`revenue: null, sessions: 0` signature that froze the live board for 69 days.

api/data.js was rewritten to find its rows by their column-B labels and to pick
the block whose heading starts with TOTAL, so it cannot drift the same way. Two
parsers for one sheet layout means one of them is always the stale one, so this
script no longer parses the sheet at all: it asks the deployed API, which is the
same data the live board reads.

That also means regenerating the snapshot is one command instead of six manual
CSV exports.

USAGE
-----
    export DASHBOARD_PASSWORD='...'          # the SITE_PASSWORD gate
    python3 source/build_data.py

    # or against a preview / local deployment
    python3 source/build_data.py --url http://localhost:3000/api/data

Options:
    --url URL         data endpoint (default: $DASHBOARD_URL or production)
    --user NAME       Basic-Auth username (default: $DASHBOARD_USER or diggerlid)
    --out PATH        output file (default: data.js beside this repo's HTML)
    --no-merge        write only what the API returned, discarding older history
    --dry-run         verify and report, write nothing

The password is read from $DASHBOARD_PASSWORD only. It is never accepted as a
command-line argument, because argv is visible to every process on the machine
and lands in shell history — this project has already lost four secrets to
values damaged or exposed in transit (see CREDENTIALS.md).
"""
import argparse, base64, datetime, json, os, re, sys, urllib.error, urllib.request

DEFAULT_URL = 'https://digboi-seven.vercel.app/api/data'
DEFAULT_USER = 'diggerlid'
OUT_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data.js')

# Known-good values, straight off the sheet. These are the ground truth that
# caught the row drift: with the old map, June 1 revenue parsed as None.
ANCHORS = [
    ('daily',   'date',  '2026-06-01', 'revenue',  16701.63),
    ('daily',   'date',  '2026-06-30', 'revenue', 121560.54),
    ('monthly', 'month', 'Jan',        'revenue', 262703.95),
]


def fetch(url, user, password, timeout=60):
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    if password:
        token = base64.b64encode(f'{user}:{password}'.encode()).decode()
        req.add_header('Authorization', 'Basic ' + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit('HTTP 401 — the gate rejected the credentials. '
                     'Set DASHBOARD_PASSWORD to the current SITE_PASSWORD.')
        if e.code == 503:
            sys.exit('HTTP 503 — the deployment has no SITE_PASSWORD set, so it '
                     'is refusing every request. Fix that first.')
        sys.exit(f'HTTP {e.code} fetching {url}: {e.read()[:300].decode("utf-8", "replace")}')
    except urllib.error.URLError as e:
        sys.exit(f'Could not reach {url}: {e.reason}')


def read_existing(path):
    """Parse the current data.js so older history survives a refresh.

    /api/data only returns the last few months (MONTHS_BACK in api/data.js), but
    the board needs a full year for the 90-day window and the year-to-date
    roll-up. Missing or unparseable is not fatal — it just means no history to
    merge, which --no-merge does deliberately.
    """
    try:
        with open(path, encoding='utf-8') as f:
            txt = f.read()
    except FileNotFoundError:
        return None
    m = re.search(r'window\.DL_DATA\s*=\s*(\{.*\})\s*;?\s*$', txt, re.S)
    if not m:
        print(f'  note: {path} exists but holds no window.DL_DATA assignment; not merging')
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError as e:
        print(f'  note: {path} is not parseable JSON ({e}); not merging')
        return None


def merge_daily(old_rows, new_rows):
    """Fresh rows win; older dates the API no longer covers are kept."""
    by_date = {r['date']: r for r in (old_rows or [])}
    for r in new_rows:
        by_date[r['date']] = r
    return [by_date[d] for d in sorted(by_date)]


def merge_monthly(old_rows, new_rows):
    by_num = {r['monthNum']: r for r in (old_rows or [])}
    for r in new_rows:
        by_num[r['monthNum']] = r
    return [by_num[n] for n in sorted(by_num)]


def verify(payload):
    """Fail loudly rather than write a snapshot that is quietly wrong."""
    problems = []
    for section, key, needle, field, expected in ANCHORS:
        rows = payload.get(section) or []
        row = next((r for r in rows if r.get(key) == needle), None)
        if row is None:
            problems.append(f'{section}[{key}={needle}] is missing entirely')
            continue
        got = row.get(field)
        if got is None:
            problems.append(f'{section}[{key}={needle}].{field} is null '
                            f'(expected ~{expected}) — the parser is reading an empty block')
        elif abs(got - expected) > 1:
            problems.append(f'{section}[{key}={needle}].{field} = {got}, expected ~{expected}')
    return problems


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', default=os.environ.get('DASHBOARD_URL', DEFAULT_URL))
    ap.add_argument('--user', default=os.environ.get('DASHBOARD_USER', DEFAULT_USER))
    ap.add_argument('--out', default=OUT_DEFAULT)
    ap.add_argument('--no-merge', action='store_true',
                    help='discard existing history instead of merging over it')
    ap.add_argument('--dry-run', action='store_true', help='verify only, write nothing')
    args = ap.parse_args()

    password = os.environ.get('DASHBOARD_PASSWORD')
    if not password:
        sys.exit('Set DASHBOARD_PASSWORD to the dashboard SITE_PASSWORD first.\n'
                 "  export DASHBOARD_PASSWORD='...'")

    print(f'Fetching {args.url} …')
    api = fetch(args.url, args.user, password)
    if api.get('error'):
        sys.exit(f'The API returned an error: {api["error"]}')

    new_daily = api.get('daily') or []
    new_monthly = api.get('monthly') or []
    if not new_daily:
        sys.exit('The API returned zero daily rows. Refusing to overwrite the '
                 'snapshot with nothing — check /api/health and /api/data?probe=1.')
    print(f'  API: {len(new_daily)} daily rows '
          f'({new_daily[0]["date"]}..{new_daily[-1]["date"]}), {len(new_monthly)} months')

    if args.no_merge:
        daily, monthly, old = new_daily, new_monthly, None
    else:
        old = read_existing(args.out)
        daily = merge_daily((old or {}).get('daily'), new_daily)
        monthly = merge_monthly((old or {}).get('monthly'), new_monthly)
        if old:
            kept = len(daily) - len(new_daily)
            print(f'  merged over existing snapshot: {kept} older day(s) kept, '
                  f'{len(new_daily)} refreshed')

    payload = {
        'meta': {
            'source': (api.get('meta') or {}).get(
                'source', 'DiggerLid – Calendar 2026 Ecommerce Equation 7.1 (Accelerate)'),
            'sheetId': (api.get('meta') or {}).get('sheetId', ''),
            'currency': (api.get('meta') or {}).get('currency', 'AUD'),
            'snapshotDate': datetime.date.today().isoformat(),
            'latestDataDate': (api.get('meta') or {}).get('latestDataDate', daily[-1]['date']),
            'builtFrom': args.url,
        },
        'daily': daily,
        'monthly': monthly,
    }

    problems = verify(payload)
    if problems:
        print('\nVERIFICATION FAILED — not writing:', file=sys.stderr)
        for p in problems:
            print('  ✗ ' + p, file=sys.stderr)
        sys.exit(1)
    print(f'  verified {len(ANCHORS)} known values against the sheet')
    print(f'  snapshot: {len(daily)} daily rows ({daily[0]["date"]}..{daily[-1]["date"]}), '
          f'{len(monthly)} months, latestDataDate={payload["meta"]["latestDataDate"]}')

    if args.dry_run:
        print('\n--dry-run: nothing written.')
        return

    js = ('// Auto-generated fallback snapshot. Do not hand-edit.\n'
          f'// Regenerate: DASHBOARD_PASSWORD=... python3 source/build_data.py\n'
          f'// Built {payload["meta"]["snapshotDate"]} from {args.url}\n'
          '// The board prefers a live pull at runtime and only shows this when '
          'the API is unreachable.\n'
          'window.DL_DATA = ' + json.dumps(payload, separators=(',', ':')) + ';\n')
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write(js)
    print(f'\nWrote {os.path.normpath(args.out)} ({len(js):,} bytes)')


if __name__ == '__main__':
    main()
