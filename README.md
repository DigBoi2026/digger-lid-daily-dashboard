# DiggerLid — Daily Operations Dashboard

One screen to run the day on. Revenue, profit, Meta spend, breakeven, and product mix —
pulled from the Ecommerce Equation sheet and Shopify, sized for a 16:9 desktop, read-only.

> We're diggin' the numbers so you don't have to.

**Three pages, one selector:**

| Page | File | What it answers |
|---|---|---|
| **Daily Ops** | `index.html` / `app.js` | Are we profitable and on pace today? (P&L, breakeven, health lights) |
| **Performance Marketing** | `performance.html` / `performance.js` | Is Meta working? (MER, ROAS, CPA, prospecting vs remarketing funnel) |
| **Products** | `products.html` / `products.js` | What's selling? (net sales by category + product, momentum) |

Every page shares one trailing-period selector: **3D · 7D · 30D · 90D · 12M**, ending yesterday,
compared against the prior equal period. The `‹ ›` arrows step back one whole period at a time.

---

## Running it locally

It's static files — no build step. Serve the folder over HTTP (Chart.js and the module
loads need `http://`, not `file://`):

```bash
cd daily-dashboard
python3 -m http.server 4173
# open http://localhost:4173/index.html
```

After editing any `.js`, `.css`, or data file, cache-bust so the browser refetches:

```bash
./bump.sh            # bump ?v= to a fresh timestamp on all three pages
# then hard-reload (Cmd-Shift-R)
```

---

## Architecture

```
index.html ┐
performance.html ├─ each loads, in order:
products.html ┘     1. anime.iife.min.js   (CDN, motion engine)
                    2. motion.js            (count-up + entrance animations)
                    3. core.js              (SHARED math — must load before page JS)
                    4. data.js | shopify_data.js   (embedded snapshot)
                    5. app.js | performance.js | products.js   (page logic)
```

**`core.js` is the single source of truth for the math** and is loaded before every page
script (they destructure from `DLcore` at the top). It owns:

| Export | Job |
|---|---|
| `periodSlices(daily, latest, P, off)` | Trailing-period + prior-period slices, **offset-clamped** so stepping past the data edge can never produce a negative/oversized slice |
| `aggregate(list)` | Sum flows, recompute rates (AOV, CVR, MER, ROAS…) over a window |
| `breakeven(rec)` | Profit b/e = (RevExGST−Var−Fixed)/Rev; cash b/e = (RevExGST−Var)/Rev; returns zone (Scale/Hold/Pull back) |
| `fmtRange`, `isoToNice`, `rollingAvg`, `sparkline` | Formatting + the shared canvas sparkline |

Because the math lives in one file, it's unit-tested independently of the browser
(`source/test_core.js`, 23 assertions). The rest — `styles.css` (brand + container-query
scaling), `motion.js` (anime.js layer with safety timeouts so content never hangs at
opacity 0).

---

## Data provenance — read this before trusting a number

| Data | Source | Freshness | Notes |
|---|---|---|---|
| Daily P&L (Daily Ops, Performance) | `data.js` — Ecommerce Equation 7.1 sheet | **Snapshot** (Jan 1 – Jun 30 2026) | 181 daily rows + 6 monthly. Regenerate with `build_data.py`. |
| Shopify product/category sales | `shopify_data.js` | **Snapshot** | 62 daily rows + rolling windows (3/7/30/90/12M) + 12-month monthly. 3-day window built by `build_win3.js`. |
| Category × month net sales (trend chart) | `shopify_data.js` → `catMonthly` | **Snapshot** (Jul '25 – Jun '26) | Per-category monthly net sales. Regenerate with `build_cat_monthly.py`. |
| Live sheet pull (when deployed) | `api/data.js` (Vercel serverless) | Daily, up to yesterday | Merges into the embedded history so 90D/12M stay intact. |

**Honest window definitions** (they are *not* identical across pages — a limit of the
underlying data, not an oversight):

- **Daily Ops / Performance** — `7D`/`30D`/`90D` are exact trailing-day windows from the
  daily series. `12M` uses the sheet's monthly roll-up, which currently covers **2026 YTD
  (6 months)**, labelled as such — not a full rolling year.
- **Products** — `3D`/`7D`/`30D` are exact trailing-day windows (per-product snapshots pulled
  from Shopify). `90D` is the **last 3 calendar months**
  (~92 days, not an exact trailing-90) and `12M` is a real trailing 12 months, both from the
  Shopify monthly roll-up. The exact-trailing-90 and per-window category breakdowns arrive
  with the live `/api/shopify` endpoint (see Deploy), which serves any window at day
  granularity — no throwaway static data needed to fake it now.

Nothing here writes back to the Google Sheet or to Shopify. It is **read-only**. Product
categorisation is applied **in the dashboard only** — Shopify's own catalog is untouched.

---

## Refreshing the data

**Sheet P&L → `data.js`:**

```bash
# Export each month tab + the monthly tab from the sheet as CSV into source/
# (dl_jan.csv … dl_jun.csv, dl_monthly.csv), then:
python3 source/build_data.py       # rewrites data.js
./bump.sh
```

**Meta funnel (Prospecting vs Remarketing) → `performance.js`:**

```bash
# Ads Manager → Campaigns → Export table data (.csv) with columns:
#   Campaign name · Amount spent · Purchases conversion value
python3 source/refresh_funnel.py ~/Downloads/DiggerLid-Campaigns.csv \
    --window "21 Apr – 20 May 2026" --dry-run   # preview
python3 source/refresh_funnel.py ~/Downloads/DiggerLid-Campaigns.csv \
    --window "21 Apr – 20 May 2026"             # write
./bump.sh
```

Stage tagging (TOF/Creative Testing → prospecting, TOM/MOF → warm, BOF → hot) lives in
`performance.js` `funnelStage()`, so the script only refreshes raw rows — tagging stays in
one place.

**Category trends (Products → Category Trends chart) → `shopify_data.js`:**

```bash
# 1. Export per-product monthly net sales from ShopifyQL into source/catrows.json:
#      FROM sales SHOW net_sales GROUP BY product_title, month SINCE <12mo ago>
# 2. Aggregate into a category × month matrix (reuses the dashboard's category map
#    and validates the sums against the stored monthly totals):
python3 source/build_cat_monthly.py        # prints the catMonthly block
# 3. Replace the `window.DL_SHOPIFY.catMonthly = [...]` block at the end of
#    shopify_data.js with the output, then ./bump.sh
```

The validator warns (doesn't abort) when a month drifts <5% from the stored monthly
snapshot — that's just the fresh pull being newer than the snapshot; it aborts on a >5%
mismatch, which would signal a transcription or mapping bug.

---

## Tests

```bash
node source/test_core.js        # 23 assertions on the shared math (must exit 0)
node source/test_api_parser.js  # the Vercel CSV → record parser
node --check app.js performance.js products.js core.js   # syntax
```

`test_core.js` specifically pins the offset-clamping bug class (stepping `‹ ›` past the data
edge) and the breakeven zone thresholds — the two places most likely to silently go wrong.

---

## Accessibility

Health traffic lights carry a text state (`OK` / `WATCH` / `ACT`) beside the colour, not
colour alone. Period buttons, the `‹ ›` arrows, and the active nav link carry `aria-label` /
`aria-current`. Deltas use `▲▼` glyphs, not just red/green.

---

## Deploying to Vercel (your step)

The live sheet pull needs a **Google service account** — credentials I can't create for you.

1. In Google Cloud, create a service account, enable the Sheets API, download the JSON key.
2. Share the Ecommerce Equation sheet with the service-account email (Viewer).
3. In Vercel: `GOOGLE_SERVICE_ACCOUNT_JSON` = the key contents; `SHEET_ID` = the sheet id.
4. Deploy. `api/data.js` reads the sheet daily (up to yesterday) and merges into the
   embedded history.
5. **Next:** add `api/shopify.js` (Shopify Admin API) to make Products' 90D/12M exact and
   per-window — the one honest gap called out above.

Until then the dashboard runs entirely on the embedded snapshots — fully functional, just
frozen at the snapshot date.

---

**Built for the dig.** If a number looks off → check the provenance table first, then the
snapshot date in the footer.
