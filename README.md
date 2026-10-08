# DiggerLid — Daily Operations Dashboard

One screen to run the day on. Revenue, profit, Meta spend, breakeven, and product mix —
pulled from the Ecommerce Equation sheet and Shopify, sized for a 16:9 desktop, read-only.

> We're diggin' the numbers so you don't have to.

**Nine pages, one nav** (the order here is the order in the nav, and it comes from
`DLcore.NAV` in `core.js` — adding a page means adding a row there, not editing nine files):

| Page | File | What it answers |
|---|---|---|
| **Daily Ops** | `index.html` / `app.js` | Are we profitable and on pace today? (P&L, breakeven, health lights) |
| **Pulse** | `daily.html` / `daily.js` | What changed today against its own history? (problem signals) |
| **Performance Marketing** | `performance.html` / `performance.js` | Is Meta working? (MER, ROAS, CPA, prospecting vs remarketing funnel) |
| **Meta Ads** | `meta.html` / `meta.js` | How does the ad account read against the benchmark framework? |
| **Spend ↔ Rev** | `spend.html` / `spend.js` | How tightly are spend, revenue, MER and profit tied — and does the next dollar clear break-even? |
| **GPAM** | `gpam.html` / `gpam.js` | Gross profit after marketing: the bonus base, above and below the line |
| **Products** | `products.html` / `products.js` | What's selling? (net sales by category + product, momentum) |
| **Region** | `region.html` / `region.js` | Where is it selling? (states, countries, momentum) |
| **Forecast** | `forecast.html` / `forecast_page.js` | What does the rest of the year look like, and how wrong has that been? |

Most pages share a trailing-period selector — **3D · 7D · 30D · 90D · 12M**, ending on the last
complete day, compared against the prior equal period; the `‹ ›` arrows step back one whole
period at a time. Pages whose data arrives in a different unit say so in their own
vocabulary: GPAM in named periods (MTD/QTD/FYTD), Region and Products in whole months,
Spend ↔ Rev in whole weeks (**4W · 8W · 13W · 26W · 52W · ALL**, where the two shortest are
drawn *day by day* — four weeks is four weekly points and no chart, but twenty-eight daily
ones; the unit follows the window rather than being one more control to find, and the
header says which). The labels come from `PERIOD_LABEL`, `PERIOD_LABEL_MONTHS` and
`PERIOD_LABEL_WEEKS` in `core.js`, so a page can only use a spelling the board already has.

### A trap worth knowing about: the sheet's `mer` column is not MER

The workbook ships a column called `mer` that holds `totalAds / revenue` — an ad **cost
ratio** (26.7%), the reciprocal of the media efficiency ratio (3.75×). The column called
`roas` is the true MER. Both are checked against every row of `data.js` in
`source/test_spend.js`, so if the sheet is ever renamed the test says so rather than the
board quietly changing meaning. Nothing on Spend ↔ Rev reads `mer` as MER: `lib/spend.js`
computes both from the raw sums and names them `adPct` and `mer`.

One more thing that page trims: a day carrying revenue against **$0 of recorded ad spend**.
The sheet's last row did exactly that — $10,905 of revenue on no spend while every
neighbouring day ran about $5,000 — a cell nobody had typed into yet, which the pending
flag misses because it holds a zero rather than a blank. On a 26-week window it moved MER
by a hundredth; on a four-week one by 2.7%, and as the rightmost point of a daily chart it
would have read "sales for nothing". It is trimmed off the end and named in the header and
the read-out, never silently dropped, and its revenue still counts wherever the sale
genuinely belongs.

Break-even on that page comes from the profit identity the book actually satisfies —
`profit = revExGst − totalVC − totalAds − totalFC`, exact to the cent over the last 90 days
and within $1.07 over all 527 — so the break-even MER can never disagree with the profit
printed beside it. `returns` is already carried inside those lines; subtracting it again
double-counts, and doing so is what made an earlier read of break-even 2.63× where the
book says 3.27×.

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
./bump.sh            # bump ?v= to a fresh timestamp on every page (globbed, not listed)
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

One schedule: `.github/workflows/watchdog.yml`, every 30 minutes. It fails the
job when the board is lying, and **GitHub emails the repository owner when a
scheduled workflow fails** — no webhook, no mail provider, no secret. Confirm
it is on at github.com/settings/notifications → Actions.

Vercel Cron was the obvious home for this and is the wrong one twice over: on a
Hobby plan it fires once a day, far too slow to catch a bad deploy, and a
`crons` block in `vercel.json` is a deploy-time dependency on the account's
plan — get it wrong and the whole site fails to build rather than just the
alarm. **An alarm must not be able to break the thing it is watching.**

The check needs no credential: `/api/watchdog` is exempt from the Basic-Auth
gate and returns *status only* — booleans, dates, counts, error strings —
withholding every figure unless a bearer token is presented.

Set `ALERT_WEBHOOK_URL` for a direct Slack/Discord/Zapier message. If you do
not, the route says so in every response: the failure mode it exists to fix must
not be reintroduced by the fix.

**The forecast log.** Nothing recorded what the forecast *said*, so it could only
ever be checked in simulation, never against what happened. One flat row —
scenarios, profit, November, the model basis — ready to append to a sheet. The
workflow captures it once a day (the run in the 22:00 UTC hour) and **commits it
to `forecast_log.csv`** — a diffable audit trail that survives, rather than a
file in a runner workspace that gets deleted. Idempotent by date, so a re-run
cannot duplicate a day.

It needs a `WATCHDOG_TOKEN` repository secret (the `CRON_SECRET`, or an AI
token) for the figures. Without one it explains how to add it and exits clean:
**the alarm must never be blocked by missing configuration.** To test it once
the secret is set, run the workflow by hand from the Actions tab with *"Also
record a forecast row"* ticked. By hand from a shell:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://<host>/api/watchdog?format=csv" >> forecast_log.csv
```

## Keeping the snapshots fresh (two repository secrets)

Every page ships a committed fallback and upgrades to the live route when it can
reach it. The fallbacks are refreshed nightly by `.github/workflows/refresh-data.yml`
(04:20 AEST), and the whole thing hangs on **one secret**:

| Secret | Unlocks | Without it |
|---|---|---|
| `DASHBOARD_PASSWORD` | `data.js`, `region_data.js`, `pulse_data.js` — all three come from the deployed API, so one secret covers them | The build step skips and the freshness gate fails the run |
| `WATCHDOG_TOKEN` | `forecast_log.csv` — one row a day recording what the forecast actually said | The log is never written, so the forecast can only ever be checked by backtest, never against what happened |

Add them under **Settings → Secrets and variables → Actions → New repository
secret**. `DASHBOARD_PASSWORD` is the current `SITE_PASSWORD` — the same one the
board asks for in the browser. `WATCHDOG_TOKEN` is the `CRON_SECRET`, or an AI
token from Vercel.

**Why the gate runs even when the build skips.** This workflow reported success
nineteen times in a row while `region_data.js` sat ninety-six days out of date,
because a run that does nothing exits 0. A green tick on a job whose entire
purpose went unperformed is worse than no job at all. The gate now runs with
`if: always()` and asks the only question that matters — *is the board's data
actually fresh?* — so the run is red whenever the answer is no, whatever the
reason.

`node source/check_snapshots.js` prints the whole picture; `--auto` gates only on
the snapshots a scheduled job refreshes, so the two that are pulled by hand
(`products_history.js`, `meta_snapshot.js`) are raised as warnings instead of
failing a job that could never have fixed them.

## Data provenance — read this before trusting a number

| Data | Source | Freshness | Notes |
|---|---|---|---|
| Daily P&L (Daily Ops, Performance) | `data.js` — Ecommerce Equation 7.1 sheet, via `/api/data` | **Snapshot**, refreshed nightly | 251 daily rows + 9 monthly at the last refresh. `python3 source/build_data.py` merges the API's four months over the committed year and verifies three known-good anchors before writing, so a bad parse fails loudly instead of overwriting the year with nulls. Needs `DASHBOARD_PASSWORD`. |
| Shopify product/category sales | `shopify_data.js` | **ORPHANED — not loaded** | No page includes this file and nothing reads `window.DL_SHOPIFY`; the Products page moved to `products_history.js`. `build_win3.js` and `build_cat_monthly.py` still write to it. Wire it up or delete it — `npm run snapshots:check` reports it every run. |
| Category × month net sales (trend chart) | `shopify_data.js` → `catMonthly` | **ORPHANED — not loaded** | See above: the file is no longer included by any page. |
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
