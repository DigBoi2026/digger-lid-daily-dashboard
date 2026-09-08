# DiggerLid Dashboard — Production Deploy (Vercel)

This is a static site + three serverless pieces:

| Piece | File | Purpose |
|---|---|---|
| Password gate | `middleware.js` | HTTP Basic Auth over the whole site (incl. `/api/*`) |
| Live P&L | `api/data.js` | Reads the private Ecommerce Equation Google Sheet |
| Live Shopify | `api/shopify.js` | ShopifyQL → Products + Region data |

Every page renders from its **embedded snapshot first**, then **upgrades to live** if the
API responds (the pill flips Snapshot → Live). If a credential is missing or an API errors,
the page silently stays on the snapshot — so a half-configured deploy still works.

**Nothing here writes to the sheet or to Shopify. All access is read-only.**

---

## 1. Environment variables (set in Vercel → Project → Settings → Environment Variables)

> Secrets go **into Vercel directly** — never into the code or a chat. Set them for
> Production (and Preview if you want protected previews).

**Password gate (required — the site is locked until this is set):**

| Var | Value |
|---|---|
| `SITE_PASSWORD` | the shared password you'll hand out |
| `SITE_USER` | *(optional)* username; defaults to `diggerlid` |

**Google Sheet (Daily Ops + Performance live P&L):**

| Var | Value |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `svc-…@<project>.iam.gserviceaccount.com` |
| `GOOGLE_PRIVATE_KEY` | the private key from the JSON (keep the `\n` escapes) |
| `SHEET_ID` | *(optional)* defaults to the DiggerLid sheet id |

**Shopify (Products + Region live):**

| Var | Value |
|---|---|
| `SHOPIFY_STORE` | your `*.myshopify.com` subdomain only (e.g. `diggerlid`) |
| `SHOPIFY_TOKEN` | Admin API access token, `shpat_…` |
| `SHOPIFY_API_VERSION` | *(optional)* defaults to `2025-01` |

---

## 2. Create the Google service account (≈5 min, you must do this — I can't create credentials)

1. [console.cloud.google.com](https://console.cloud.google.com) → create/select a project.
2. **APIs & Services → Enable APIs** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create credentials → Service account**. Name it, create.
4. On the service account → **Keys → Add key → Create new key → JSON**. A JSON downloads.
5. From that JSON copy `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `private_key`
   (the whole `-----BEGIN…END-----\n` string) → `GOOGLE_PRIVATE_KEY` in Vercel.
6. **Share the sheet** with that `client_email` as **Viewer** (like sharing with a person).

## 3. Create the Shopify Admin token (≈5 min, you must do this)

1. Shopify admin → **Settings → Apps and sales channels → Develop apps → Create an app**.
2. **Configure Admin API scopes** → tick **`read_reports`** (required for ShopifyQL) plus
   **`read_products`** and **`read_orders`**. Save.
3. **Install app** → then **API credentials → Admin API access token → Reveal** (shown once).
4. Put the token in `SHOPIFY_TOKEN` and your store subdomain in `SHOPIFY_STORE`.

## 4. Pick the password

Set `SITE_PASSWORD` to whatever you'll share with the team. First visit prompts for it
(username `diggerlid` unless you set `SITE_USER`).

---

## 5. Deploy

Deploys to the **Matthew - Personal** Vercel account. After the env vars are set:

- Redeploy from the Vercel dashboard (or `vercel --prod`), **or** ask me to deploy.
- After deploy, open the URL → you'll get the password prompt → then the dashboard, with the
  status pill showing **Live** on each page once its API responds.

**Verify live:** each page's pill should read *Live* (not *Snapshot*). If one stays on
Snapshot, that source's credential/scope is off — check `Vercel → Deployments → Functions`
logs for `/api/data` or `/api/shopify` (they return a JSON `error` string on failure).

---

## Meta / paid-media

There is **no live Meta API** wired. The Performance page's funnel + ROAS-by-stage come from
a periodic Meta Ads Manager export, refreshed with `source/refresh_funnel.py` (see README).
Everything else (P&L, Products, Region) is live.

## Data refresh cadence

The API responses are edge-cached for 1 hour (`s-maxage=3600, stale-while-revalidate`). So
the live data refreshes at most hourly per visitor — well within the "up to yesterday" goal.
