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

**`forecast.js` is the same idea for the forward look** — pure functions over daily rows,
no DOM and no fetch, so every claim it makes can be checked against history
(`source/test_forecast.js`, 69 tests). It fits a day-of-week shape, a month index (year and
month effects solved jointly, because the two books are an unbalanced panel), a
year-on-year growth rate and a level, blends a trailing-trend predictor with a
prior-year one, and applies the sheet's own exact profit identity — `revExGst − totalVC
− totalAds − totalFC` — rather than regressing profit. `backtest()` walks the whole book
forward, refitting at each origin, and is what draws the band on the page.

Measured: **±13% at 30 days, ±17% at 90**, over origins that had a prior year to lean on.
Origins without one scored ±27%. October to December are unvalidated at any horizon —
no origin in the data reaches them — so BFCM rests on a single observed November, and
the page says so on its face.

**Sale periods** are the one thing the seasonality cannot carry. EOFY and BFCM are
month-aligned, so the month index prices them exactly and declaring them again would
double-count. Father's Day is not: it is the first Sunday of September, its run-up sits
in August and its payback in September, so no per-month figure can hold it.
`salePeriodModifiers()` measures it from the book — 2026 ran +47% over fourteen days
against its own pre-promotion August, 2025 ran none — dates it for every year, and sizes
a future year from the most recent that registered while every past year keeps its own
measurement. Declared modifiers are divided out of history BEFORE anything is fitted, so
the level, the month index and the growth rate are all baseline figures. Leaving the 2026
promotion undeclared put the level 17% high and projected the rest of the year at ×2.0–×2.3
on last year; August measured *before* it ran ×1.69, alongside May ×1.77, June ×1.72 and
July ×1.51.
| `fmtRange`, `isoToNice`, `rollingAvg`, `sparkline` | Formatting + the shared canvas sparkline |

Because the math lives in one file, it's unit-tested independently of the browser
(`source/test_core.js`, 23 assertions). The rest — `styles.css` (brand + container-query
scaling), `motion.js` (anime.js layer with safety timeouts so content never hangs at
opacity 0).

---

## The watchdog — read this second

This board does not break loudly. When the live pull fails, every page falls
back to its embedded snapshot and keeps drawing, with a small "Snapshot" pill as
the only tell. That is right for a screen on a wall and it means a broken data
path is invisible to anyone not already suspicious. It has cost real time twice:
the board once sat 69 days behind the sheet, and `/api/data` spent a stretch
returning `{"error":"opts is not defined"}` to every caller — found not by any
alarm but because somebody curled the endpoint while checking something else.

`/api/health` reported **green** throughout that second one, and this is the part
worth internalising: it calls `parseDaily` directly and never calls
`buildData()`, so it exercises a *parallel* code path rather than the one the
board uses. A check that does not run the real thing is not a check.

**`/api/watchdog` runs the real thing.** It asserts that `buildData()` returns
without throwing, that it returns rows, that the newest data is *recent* (nothing
else here asserts that — `latestDataDate` appears seven times and every one of
them clamps a window to accept stale data gracefully), that the trailing pending
days are not piling up, and that the forecast layer can still produce a number.
It answers **200** when healthy and **503** when not, so the cheapest uptime
monitor in the world works against it unconfigured.

Two schedules, because they do different jobs:

| | Cadence | Reaches you via |
|---|---|---|
| `.github/workflows/watchdog.yml` | every 30 min | GitHub emails the repo owner when a scheduled workflow fails — **no setup, no secret** |
| `vercel.json` → `crons` | daily, 22:00 UTC | the heartbeat, and it carries the forecast log row |

The Action is the fast detector because Vercel Cron on a Hobby plan fires only
once a day. It needs no credential: `/api/watchdog` is exempt from the
Basic-Auth gate and returns *status only* — booleans, dates, counts, error
strings — withholding every figure unless a bearer token is presented.

Set `ALERT_WEBHOOK_URL` for a direct Slack/Discord/Zapier message. If you do
not, the route says so in every response: the failure mode it exists to fix must
not be reintroduced by the fix.

**The forecast log.** Nothing recorded what the forecast *said*, so it could only
ever be checked in simulation, never against what happened. The daily run
returns one flat row — scenarios, profit, November, the model basis — ready to
append to a sheet:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://<host>/api/watchdog?format=csv" >> forecast_log.csv
```

## Data provenance — read this before trusting a number

| Data | Source | Freshness | Notes |
|---|---|---|---|
| Daily P&L (Daily Ops, Performance) | `data.js` — Ecommerce Equation 7.1 sheet | **Snapshot** (Jan 1 – Jun 30 2026) | 181 daily rows + 6 monthly. Regenerate with `build_data.py`. |
| Shopify product/category sales | `shopify_data.js` | **Snapshot** | 62 daily rows + rolling windows (3/7/30/90/12M) + 12-month monthly. 3-day window built by `build_win3.js`. |
| Category × month net sales (trend chart) | `shopify_data.js` → `catMonthly` | **Snapshot** (Jul '25 – Jun '26) | Per-category monthly net sales. Regenerate with `build_cat_monthly.py`. |
| Live sheet pull (when deployed) | `api/data.js` (Vercel serverless) | Daily, up to yesterday | Merges into the embedded history so 90D/12M stay intact. |
| Prior-year P&L (Forecast) | `prior_year.js` — Ecommerce Equation 6.0 workbook | **Static, by design** | 276 daily rows over 9 months of 2025. The year is closed, so there is nothing to refresh. Feb–Apr 2025 were never filled in and are absent rather than zeroed. Regenerate with `build_prior_year.py <2025.xlsx>`. |

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

**Forecast → a workbook (`npm run export`):**

```bash
# current, from the committed snapshot
npm run export                                    # → DiggerLid_Forecast.xlsx

# or as current as the sheet, by feeding it a live pull
curl -s -u "$SITE_USER:$SITE_PASSWORD" https://<host>/api/data -o live.json
node source/export_forecast.js --live live.json --out /tmp/b.json
python3 source/export_forecast.py /tmp/b.json DiggerLid_Forecast.xlsx
```

Seven sheets: Summary (scenarios, what it rests on, measured accuracy, what it cannot do),
Forecast by month, Forecast daily, Actuals daily (both books merged, pending days flagged),
Seasonality, Year on year, Sale periods (measured per year, plus the run-up profile day by
day). Split across two files on purpose — the JavaScript half runs the SAME `forecast.js` the
board runs, so there is one implementation of the model and the Python half only formats what
it is handed. Needs `openpyxl`.

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

## Giving an AI access

Hand an agent one URL and one scoped, revocable token:

```
https://digboi-seven.vercel.app/api/ai/manifest
Authorization: Bearer sk_dl_…
```

It discovers the datasets, parameters and field meanings from there. Scopes let
a media-buying agent read ad spend and MER without ever seeing salaries. Inert
until `AI_TOKENS` is set. See **[AI-ACCESS.md](AI-ACCESS.md)**.

Every credential this board uses, and how to rotate each one, is registered in
**[CREDENTIALS.md](CREDENTIALS.md)**. No values, only what exists and where.
