# Credential register — Daily Ops dashboard

Every credential this board uses, where it lives, and how to rotate it. Import
this into DLkeys (or whatever the canonical store is) rather than keeping it
only here.

**No secret values in this file.** It records *what exists, where, and how to
replace it* — never the value itself.

Set in: Vercel project `digboi` (`prj_NVER9F6Rf9zxhGxfSCNjLSwrvTwN`), scope
`matthew-9798s-projects`, **Production**. All are `Secret` type, so Vercel will
not read them back — the store of record is DLkeys, not Vercel.

| Env var | Purpose | Issued by | Rotate by | Breaks if wrong |
|---|---|---|---|---|
| `SITE_PASSWORD` | Basic-Auth gate over the whole board | You choose it | `vercel env rm` + `add`, redeploy | Whole board 503s if unset, 401s if wrong |
| `SITE_USER` | Gate username | Optional, defaults `diggerlid` | as above | Login fails |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Identifies the Sheets reader | GCP project `diggerlid-dashboard-project` | New service account | `invalid_grant: account not found` |
| `GOOGLE_PRIVATE_KEY` | Signs the Sheets JWT | Same service account → Keys → Add key | Add a new key, swap, delete the old | `DECODER routines::unsupported` if mangled |
| `SHOPIFY_TOKEN` | Reads ShopifyQL `sales` | Auth-code grant against app DASHBOARD CONNECT | Repeat the grant, swap | `HTTP 401 — token rejected` |
| `SHOPIFY_STORE` | Store subdomain (`digger-lid`) | Fixed | n/a | Requests go nowhere |
| `SHOPIFY_API_VERSION` | Pinned to `2026-07` | Shopify quarterly | Bump before 16 Jul 2027 | Silently falls forward to oldest supported |
| `POSTHOG_API_KEY` | Reads PostHog project `475333` | PostHog personal API key | Revoke + reissue in PostHog | Pulse page falls back to snapshot |
| `AI_TOKENS` | Per-consumer AI read tokens | You: `echo "sk_dl_$(openssl rand -hex 24)"` | Remove that entry, re-set the var | `/api/ai/*` returns 503 while unset |
| ~~`SITE_PUBLIC`~~ | **Must stay deleted.** Set to `true` it disables the gate entirely and the P&L becomes world-readable | — | — | Board open to anyone with the URL |

## Related credentials, not in Vercel

| Credential | Where | Notes |
|---|---|---|
| Shopify **client secret** (`shpss_…`) | Dev Dashboard → DASHBOARD CONNECT → Settings | Only needed to mint a new `SHOPIFY_TOKEN`. Not deployed. |
| Shopify **client ID** `61976438e9a6e06e5b35a961eeb44619` | `shopify.app.toml` | Public by design. |
| Google service-account JSON | Downloaded key file | Delete from `~/Downloads` once `AI_TOKENS`-style values are in the store. |
| GitHub write access | `MJB1000` is a collaborator on this repo | Pushes to `main` deploy to production. |

## ⚠️ Rotate — these passed through a chat transcript

| Credential | Action |
|---|---|
| Shopify client secret `shpss_02052…` | Rotate in Dev Dashboard. Only used to mint tokens, so nothing breaks; you re-run the grant next time. |
| `SITE_PASSWORD` | Currently `DL2026-digger-lid-ops`. Six-character variants were also discussed. `middleware.js` has no rate limiting, so a short password is close to no gate. |

## The rule this project learned the hard way

**Never set a secret through a browser field or a CLI prompt.** Four separate
failures in one session — a mangled private key (`DECODER
routines::unsupported`), a whitespace-broken service account email
(`invalid_grant`), a corrupted Shopify token (`HTTP 401`), and a clipboard
overwritten by copying the next command. Every one was a value damaged in
transit, not a wrong value.

Pipe from a file instead, and never let the value touch the clipboard:

```bash
jq -r '.private_key | @json' key.json | sed 's/^"//; s/"$//' | vercel env add GOOGLE_PRIVATE_KEY production
jq -r .access_token tok.json | vercel env add SHOPIFY_TOKEN production
tr -d '\n' < ai.json | vercel env add AI_TOKENS production
```

Use `vercel env rm <NAME> production --yes` when scripting: without `--yes` the
confirmation prompt swallows the next line of a pasted block, which is its own
source of corrupted values.

## Verifying after any rotation

```bash
curl -s "https://digboi-seven.vercel.app/api/health?t=$(date +%s)"
```

All four groups must read `configured: true` and `reachable: true`, and
`sheets.rows` must be non-zero. `reachable` alone is not enough — it once sat
green for months while the sheet parser extracted nothing.
