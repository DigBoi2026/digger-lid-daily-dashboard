#!/usr/bin/env python3
"""
refresh_funnel.py — regenerate the Meta prospecting/remarketing funnel block in
performance.js from a Meta Ads Manager campaign export.

WHY: performance.js embeds a `META_CAMPAIGNS` snapshot (campaign name + spend +
revenue) that powers the "Prospecting vs Remarketing" funnel. It is hand-maintained.
This script rebuilds it from a CSV export so the funnel stays current in one command.

HOW TO EXPORT FROM META:
  Ads Manager → Campaigns tab → set the date range you want → Reports / Export →
  "Export table data" (.csv). Make sure the columns include at least:
    - Campaign name        (header contains "Campaign name")
    - Amount spent         (header contains "Amount spent")
    - Purchases conversion value  (header contains "conversion value")
  The date range you pick becomes the funnel window label.

USAGE:
  python3 source/refresh_funnel.py ~/Downloads/DiggerLid-Campaigns.csv \
      --window "21 Apr – 20 May 2026"
  python3 source/refresh_funnel.py <csv> --window "<label>" --dry-run   # preview only

The stage classification (TOF/Creative Testing → prospecting, TOM/MOF → warm,
BOF → hot) lives in performance.js `funnelStage()` — this script only refreshes the
raw rows, so tagging logic stays in one place.
"""
import argparse, csv, re, sys
from pathlib import Path

PERF_JS = Path(__file__).resolve().parent.parent / "performance.js"


def find_col(headers, *needles):
    """Return the index of the first header containing any needle (case-insensitive)."""
    low = [h.lower() for h in headers]
    for n in needles:
        for i, h in enumerate(low):
            if n in h:
                return i
    return None


def parse_num(s):
    if s is None:
        return 0.0
    s = re.sub(r"[^0-9.\-]", "", str(s))
    try:
        return float(s) if s not in ("", "-", ".") else 0.0
    except ValueError:
        return 0.0


def js_str(s):
    """Escape a campaign name for a single-quoted JS string literal."""
    return s.replace("\\", "\\\\").replace("'", "\\'")


def load_rows(csv_path):
    with open(csv_path, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.reader(fh))
    if not rows:
        sys.exit("CSV is empty.")
    headers = rows[0]
    ci_name = find_col(headers, "campaign name", "campaign")
    ci_spend = find_col(headers, "amount spent", "spend")
    ci_rev = find_col(headers, "conversion value", "purchase value", "revenue")
    missing = [lbl for lbl, ci in
               (("campaign name", ci_name), ("amount spent", ci_spend),
                ("conversion value", ci_rev)) if ci is None]
    if missing:
        sys.exit("Could not find column(s): " + ", ".join(missing) +
                 f"\nHeaders seen: {headers}")

    out = []
    for r in rows[1:]:
        if len(r) <= max(ci_name, ci_spend, ci_rev):
            continue
        name = (r[ci_name] or "").strip()
        if not name:
            continue
        spend, rev = parse_num(r[ci_spend]), parse_num(r[ci_rev])
        if spend == 0 and rev == 0:
            continue
        out.append((name, round(spend, 2), round(rev, 2)))
    return out


def build_block(rows, window):
    lines = [f'  window: "{window}",', "  rows: ["]
    for name, spend, rev in rows:
        lines.append(f"    {{name:'{js_str(name)}', spend:{spend}, rev:{rev}}},")
    if lines[-1].endswith(","):
        lines[-1] = lines[-1][:-1]  # drop trailing comma on last row
    lines.append("  ]")
    return "const META_CAMPAIGNS = {\n" + "\n".join(lines) + "\n};"


def main():
    ap = argparse.ArgumentParser(description="Refresh the Meta funnel block in performance.js")
    ap.add_argument("csv", help="Meta Ads Manager campaign export (.csv)")
    ap.add_argument("--window", required=True, help='Funnel window label, e.g. "21 Apr – 20 May 2026"')
    ap.add_argument("--dry-run", action="store_true", help="Print the new block; do not write")
    args = ap.parse_args()

    rows = load_rows(args.csv)
    if not rows:
        sys.exit("No usable campaign rows found in the CSV.")
    block = build_block(rows, args.window)

    tot_spend = sum(r[1] for r in rows)
    tot_rev = sum(r[2] for r in rows)
    roas = tot_rev / tot_spend if tot_spend else 0
    print(f"Parsed {len(rows)} campaigns · spend ${tot_spend:,.0f} · "
          f"rev ${tot_rev:,.0f} · blended ROAS {roas:.2f}x · window {args.window!r}")

    if args.dry_run:
        print("\n--- new META_CAMPAIGNS block (dry run) ---\n" + block)
        return

    src = PERF_JS.read_text()
    new_src, n = re.subn(r"const META_CAMPAIGNS = \{.*?\n\};", block, src, count=1, flags=re.S)
    if n != 1:
        sys.exit("Could not locate the existing `const META_CAMPAIGNS = {...};` block "
                 "in performance.js — refusing to write. Check the file by hand.")
    PERF_JS.write_text(new_src)
    print(f"Updated {PERF_JS}. Run ./bump.sh to cache-bust, then reload the browser.")


if __name__ == "__main__":
    main()
