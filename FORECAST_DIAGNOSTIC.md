# Forecast diagnostic — v3 (10 Sep 2026)

Rollback point: branch `rollback/v2` (commit `0c58d8d`). `git checkout rollback/v2` restores the three-lens board exactly as it was before this pass.

Everything below is measured by walk-forward backtest on the real 2025 + 2026 books: rewind to a past date, forget everything after it, refit, forecast, compare. Origins every 7 days; 18 with a prior year to lean on, more without. "MAPE" is mean absolute percentage error over the horizon total; "bias" is the signed mean (negative = under-forecast). Re-run any time with `node source/ablate_forecast.js`.

## 1. Is the model too complicated?

No — but one part of it was decoration, and it is gone. Each component removed in turn (P&L revenue, MAPE at 30 / 60 / 90 days, bias in brackets):

| Configuration | 30d | 60d | 90d | verdict |
|---|---|---|---|---|
| naive: trailing 28-day mean | 36.6% (+4) | 36.2% (−13) | 31.5% (−31) | baseline |
| seasonal naive: last year × YoY | 13.6% (−9) | 18.6% (−14) | 24.0% (−23) | baseline |
| **full model** | **12.2% (−7)** | **11.3% (−10)** | **16.2% (−14)** | |
| − month index | 20.4% | 25.7% | 23.3% | essential (−8 to −14 pts) |
| − prior-year blend | 20.7% | 13.5% | 19.1% | essential (−3 to −8 pts) |
| − shape-mode level (plain trailing) | 13.0% | 14.4% | 18.6% | earns 1–3 pts |
| − day-of-week index | 12.6% | 11.9% | 16.8% | small, cheap, kept |
| − growth trend (level flat) | 12.4% | 11.7% | 16.6% | earns 0.2–0.4 pts |
| − prior-year smoothing (±0 / ±1 / ±7) | 12.3% | 11.3% | 16.2% | inert |
| level window 14 / 21 / 42 / 56 d | 13.1 / 13.3 / 11.3 / 11.1 | 11.5 / 10.8 / 14.5 / 14.4 | 16.0 / 17.0 / 18.7 / 20.0 | 28 is the right compromise |
| prior weight fixed 0.3 / 0.5 / 0.65 / 0.8 | 15.5 / 12.8 / 11.7 / 11.8 | 11.3 / 11.7 / 13.7 / 15.6 | 16.7 / 16.9 / 19.0 / 21.1 | the decaying schedule beats every fixed value |
| with declared sale periods | 10.6% (−6) | 11.2% (−9) | 16.0% (−14) | declare them |

**What changed.** The old drift — a 28-over-28 ratio of the level against a month earlier, clamped to the best YoY month ever — scored *worse* than holding the level flat (12.7% vs 12.4%). Forty lines of careful reasoning that earned nothing, because a month-over-month ratio on a business with two giant months a year is mostly noise about which side of June you are standing on. It is replaced by the measured annual growth rate applied as a trend, g^(k/365): the same idea over a window long enough to mean something. 12.7 → 12.2 at 30 days, and the clamp is gone.

**What stays.** Season, the prior-year blend and the shape-mode level are each worth 1–14 points and none can be removed. The model is four multiplications and a blend; the ablation says every one of them is doing work.

## 2. The systematic under-forecast, and why there is no fudge factor

Every configuration under-forecasts by 7–14%. A single ×1.10 would "fix" the average and would be wrong, because per-origin the miss is not uniform:

| origins | 30-day error | cause |
|---|---|---|
| Jan 2026 | −18% to −23% | no whole-month pair yet, growth unmeasured |
| Feb–Mar 2026 | +3% to +21% | over-forecast off a strong January |
| Apr–May 2026 | −18% to −36% | the April step-up: nothing in history predicted it |
| Jun–Jul 2026 | −12% to +19% | EOFY, well handled |
| Aug 2026 | −22% to −24% | the undeclared Father's Day promotion |

Two structural events, not a constant. The remedy for August is on the page already (declare the sale period: 30-day error 12.2% → 10.6%). The April step-up is a genuine change in the business and no model reading the past can see it coming — that is what the optimistic scenario is for, and the three scenarios now sit on one ladder: flat / median rate / best month, bracketing the truth at −16% / −7% / −1% bias.

## 3. Shopify's new-vs-returning: yes, and the earlier conclusion was wrong

The previous pass concluded Shopify had no revenue split by customer type. It does. The dimension is `new_or_returning_customer` (asking for `customer_type` returns "column not found", which is how the mistake was made). Verified against the sheet: Shopify's daily `new_customers` equals the sheet's *New Customer Orders* on every day checked.

Last 90 days: New $1.17M / 4,734 orders (AOV $248); Returning $406K / 1,512 orders (AOV $270). Returning customers spend 9% more per order — so the "equal AOV" assumption the order-count lens would have rested on was wrong by 9%, and is no longer needed.

The customers lens now forecasts **revenue** per type from Shopify, with order counts and implied AOV on each tile. Measured: New ±29%, Returning ±21% at 30 days, bias within ±3%. The order counts tie to the sheet; the dollars are Shopify net sales (ex GST, net of refunds) and do not tie to the P&L — the tile says so.

## 4. Product-level forecast: built, with measured limits

`?dataset=productsDaily` pulls two years of daily net sales for the top six products by trailing-year sales, and everything else as the residual. Dense per-product series (`WHERE product_title = X GROUP BY day`), never the sparse grouped grid. Measured at 30 days:

| series | 2-yr net sales | 30d error | note |
|---|---|---|---|
| KAJO Grease Packs | $2.63M | ±23% (−2) | forecastable |
| Battery Grease Gun KAJO Adapter | $556K | ±22% (−2) | forecastable |
| Everything else | $1.42M | ±24% (−1) | forecastable |
| Pro Excavator Enclosure | $1.48M | ±40% (+25) | high-ticket, lumpy: BFCM/EOFY spikes dominate |
| 1.7 Tonne Excavator Cover | $431K | ±40% (+21) | same shape |
| DiggerShield Kit | $377K | ±54% (+33) | 155 orders a year — "scale, not a forecast" |
| PRO Mat | $729K | ±54% (−26), cold-start | launched Oct 2025: no prior year yet |

PRO Mat found three engine faults that would have hit any product launched inside the window:

1. Its 2025 months {Oct, Nov, Dec} and 2026 months {Jan…Aug} share no month, so the joint year/month fit was **unidentifiable** and read the launch as an 11× November. First result on screen: **$54M for the quarter.** The fit now keeps only the connected block of the panel.
2. Its pre-launch trickle ($597 in Aug 2025) made August-over-August read ×263 as growth. A month under a tenth of the series' own daily rate is not trading, in either fit.
3. One year of a launched product cannot separate its ramp from its months ($32K Jan → $157K Aug read as an August ×2.5 "season", deflating its own run rate). A series launched inside the data gets a flat index until a month repeats. A series already trading on day one — the P&L itself in 2025 — keeps its one-year shape, which is worth 16 points of cold-start error (43% → 27%).

Dense series are unchanged to the decimal by all three.

## 5. Per-lens accuracy, as shown on the page

Each lens is now backtested on **its own series**, and the error cell names the worst one. Reusing revenue's ±12% under another lens would have understated the returning-customer error by 2.4×.

| lens | best series | worst series |
|---|---|---|
| Total (P&L) | ±12% at 30d, ±16% at 90d | — |
| Customers | Returning ±21% | New ±29% |
| Countries | Australia ±24% (90% of sales) | New Zealand ±156% — scale, not a forecast |
| Products | Adapter ±22% | DiggerShield ±54%; PRO Mat ±54% with no prior year |

Countries are the one lens the model cannot carry: New Zealand and rest-of-world are 1–6% of sales, trade on a third of days, and have swung quarter to quarter. Their tiles drop the year-on-year arrow and show the measured error instead. Australia is 90% of the money and is forecastable.

## 6. Recommendations left open

- **Declare Father's Day every year** in *Sale periods & modifiers*. It is the single largest avoidable error (August −24%).
- **Fill the workbook's Country 2/3/4 columns** if a country forecast that ties to the P&L and carries profit matters. Until then the country lens is Shopify's measure and says so.
- **Leave New Zealand and DiggerShield as scale, not forecast.** No model on 268 or 155 selling days a year will do better than ±50%, and a tighter-looking number would be a lie.
- **Do not add a calibration constant.** The −7% bias is two events, not a drift, and the optimistic scenario already carries the upside case at −1% bias.
