#!/usr/bin/env python3
"""
build_cat_monthly.py — turn per-product monthly net sales (catrows.json, exported
from ShopifyQL: net_sales GROUP BY product_title, month) into a category x month
matrix for the Products "Category Trends" chart.

Reuses the dashboard's title->category mapping (from shopify_data.js) so the trend
lines match the rest of the page. Validates the per-month category sums against the
known monthly net totals before emitting.

Output: prints a `catMonthly` JS array to paste/append into shopify_data.js.
"""
import json, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

MONTHS = ["2025-07-01","2025-08-01","2025-09-01","2025-10-01","2025-11-01","2025-12-01",
          "2026-01-01","2026-02-01","2026-03-01","2026-04-01","2026-05-01","2026-06-01"]
MLABEL = ["Jul '25","Aug '25","Sep '25","Oct '25","Nov '25","Dec '25",
          "Jan '26","Feb '26","Mar '26","Apr '26","May '26","Jun '26"]

CAT_ORDER = ["covers","grease","screens","drawbar","phone","shipping","wipes","mobile","merch","other"]


def norm(s):
    return re.sub(r"\s+", " ", (s or "")).strip()


def load_title_map():
    """Pull the authoritative title->category map out of shopify_data.js via node."""
    js = ("const w=global.window={};require('./shopify_data.js');"
          "const D=window.DL_SHOPIFY;const m={};"
          "D.windows['12M'].forEach(r=>m[r.t]=r.k);"
          "console.log(JSON.stringify({map:m,keys:D.keys,"
          "monthly:D.monthly.map(x=>({m:x.m,net:x.net}))}));")
    out = subprocess.check_output(["node", "-e", js], cwd=ROOT, text=True)
    d = json.loads(out)
    return {norm(k): v for k, v in d["map"].items()}, d["keys"], d["monthly"]


def heuristic(title):
    t = norm(title).lower()
    if not t or t == "(untitled)":
        return "other"
    if "gwp" in t:                      # gift-with-purchase, net 0 — bucket loosely
        if "draw bar" in t: return "drawbar"
        if "mat" in t or "hauler" in t: return "mobile"
        if "engine" in t or "cover" in t: return "covers"
        return "other"
    if any(k in t for k in ("grease", "kajo", "coupler")): return "grease"
    if "draw bar" in t: return "drawbar"
    if "shield" in t or "screen" in t: return "screens"
    if "phone cradle" in t: return "phone"
    if "wipes" in t: return "wipes"
    if "mat" in t or "hauler" in t or "luggage" in t: return "mobile"   # PRO Mat + Hauler → Mobile Protection
    if any(k in t for k in ("beanie", "hoodie", "work tee", "trucker", "bottle opener")): return "merch"
    if "package protection" in t: return "shipping"
    if any(k in t for k in ("cover", "enclosure", "caddy", "cap set", "quicky", "hydraulic")): return "covers"
    return "other"


def categorize(title, tmap):
    n = norm(title)
    if n in tmap:
        return tmap[n]
    return heuristic(title)


def main():
    tmap, keys, monthly = load_title_map()
    rows = json.loads((HERE / "catrows.json").read_text())

    matrix = {m: {c: 0.0 for c in CAT_ORDER} for m in MONTHS}
    fell_through = set()
    for r in rows:
        mo = r["month"]
        if mo not in matrix:
            continue                    # skip partial current month, if present
        title = r["product_title"]
        cat = categorize(title, tmap)
        if norm(title) not in tmap and (title or "") and "GWP" not in (title or ""):
            fell_through.add(f"{title!r}->{cat}")
        matrix[mo][cat] += float(r["net_sales"])

    # ---- validation: category sum per month vs known monthly net total ----
    # A large mismatch on MANY months signals a transcription/mapping bug (abort).
    # A small drift on one month is just the stored monthly snapshot being staler
    # than this fresh per-product pull — report it, but the fresh pull wins.
    known = {m["m"]: m["net"] for m in monthly}
    print("VALIDATION (category-sum vs stored monthly-net):", file=sys.stderr)
    bad = 0
    for iso, lbl in zip(MONTHS, MLABEL):
        cs = sum(matrix[iso].values())
        kn = known.get(lbl)
        diff = (cs - kn) if kn is not None else None
        pctd = (abs(diff) / kn * 100) if (kn and diff is not None) else 0
        if diff is None or abs(diff) < 1.0:
            flag = ""
        elif pctd <= 5.0:
            flag = f"  ~ stale snapshot ({pctd:.1f}%)"
        else:
            flag = f"  <-- MISMATCH ({pctd:.1f}%)"; bad += 1
        print(f"  {lbl}: fresh {cs:>12,.2f}  stored {kn if kn else 0:>12,.2f}  Δ {0 if diff is None else diff:>8.2f}{flag}", file=sys.stderr)
    if fell_through:
        print("\nHeuristic-mapped (verify these):", file=sys.stderr)
        for x in sorted(fell_through):
            print("   " + x, file=sys.stderr)
    if bad:
        print(f"\n*** {bad} month(s) off by >5% — likely a transcription/mapping bug. NOT emitting. ***", file=sys.stderr)
        sys.exit(1)
    print("OK — emitting catMonthly (fresh per-product pull is authoritative).\n", file=sys.stderr)

    # ---- emit JS ----
    def row_js(iso, lbl):
        cats = matrix[iso]
        pairs = ",".join(f"{c}:{round(cats[c],2)}" for c in CAT_ORDER if cats[c] != 0)
        return f'  {{m:"{lbl}",cats:{{{pairs}}}}}'
    body = ",\n".join(row_js(iso, lbl) for iso, lbl in zip(MONTHS, MLABEL))
    print("D.catMonthly = [\n" + body + "\n];")


if __name__ == "__main__":
    main()
