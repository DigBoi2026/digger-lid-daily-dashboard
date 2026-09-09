# Giving an AI access to this board

Hand an agent **one URL and one token**. It discovers everything else itself.

```
https://digboi-seven.vercel.app/api/ai/manifest
Authorization: Bearer sk_dl_…
```

The manifest lists every dataset that token may read, the parameters each takes,
and where the field dictionary lives. Nothing else needs explaining to it.

## Why not just give it the site password?

`SITE_PASSWORD` is one shared human credential. It grants the entire board,
cannot be scoped, and cannot be revoked for one consumer without locking
everybody out. AI tokens are separate, individually revocable, read-only, and
scoped — so a media-buying agent can read ad spend and MER without ever seeing
salaries.

## Issuing a token

```bash
echo "sk_dl_$(openssl rand -hex 24)"
```

Then set `AI_TOKENS` — a JSON array, one entry per consumer:

```bash
cat > /tmp/ai.json <<'JSON'
[
  {"name":"media-buyer","token":"sk_dl_…","scopes":["pnl.topline","pulse"]},
  {"name":"cfo-agent","token":"sk_dl_…","scopes":["pnl.full","products","region","pulse"]}
]
JSON
vercel env rm AI_TOKENS production --yes 2>/dev/null
tr -d '\n' < /tmp/ai.json | vercel env add AI_TOKENS production
rm /tmp/ai.json
git commit --allow-empty -m "redeploy for AI_TOKENS" && git push
```

Revoke one agent by deleting its entry and repeating. The others are unaffected.

While `AI_TOKENS` is unset every `/api/ai/*` route answers `503` and reveals
nothing, so the subsystem is inert until you deliberately turn it on.

## Scopes

| Scope | Grants |
|---|---|
| `pnl.full` | Every P&L field, including cost structure, salaries and profit |
| `pnl.topline` | Trading and marketing only — revenue, orders, sessions, AOV, CVR, ad spend, MER, ROAS |
| `products` | Shopify product and category sales |
| `region` | Shopify sales by country and region |
| `pulse` | PostHog site signals |

`pnl.topline` withholds 23 fields: cost of goods, freight, 3PL, packaging,
transaction and merchant fees, variable and fixed cost totals and ratios,
salaries, software, office, returns, total expenses, profit, profit %, and the
forecast lines. They are removed from the rows, omitted from the schema, and
named in `fields_withheld` so the agent knows they exist and that it cannot see
them — rather than silently inferring them.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/ai/manifest` | Catalogue, scoped to the caller. Start here. |
| `GET /api/ai/schema` | Field dictionary. `?dataset=<name>` for one. |
| `GET /api/ai/query?dataset=<name>` | The data. `pnl.daily` also takes `since` / `until`. |
| `GET /api/ai/llms` | The same orientation as plain text, for dropping into a prompt. |
| `GET /api/health` | Integration health. No token, no figures. |

Datasets: `pnl.daily`, `pnl.monthly`, `products`, `region`, `pulse`.

## Try it

```bash
TOK=sk_dl_…
BASE=https://digboi-seven.vercel.app
curl -s -H "Authorization: Bearer $TOK" "$BASE/api/ai/manifest" | jq
curl -s -H "Authorization: Bearer $TOK" "$BASE/api/ai/llms"
curl -s -H "Authorization: Bearer $TOK" "$BASE/api/ai/query?dataset=pnl.daily&since=2026-09-01" | jq '.row_count, .range, .fields_withheld'
```

## Design notes

**The routes reuse the board's own builders.** `/api/ai/query` calls
`buildData()`, `buildProducts()`, `buildRegion()` and `buildPulse()` — the exact
functions the dashboard's own endpoints call. An agent and the board cannot
disagree about a number.

**`/api/ai/*` sits outside the Basic-Auth matcher on purpose.** Every one of
those routes calls the bearer guard before doing anything. Keeping them out of
the matcher is what lets an agent authenticate with its own scoped token instead
of the shared human password.

**Responses are `private, no-store`.** They differ per caller, so a shared edge
cache must never serve one token's answer to another.

**Errors are named, not bare.** An agent that receives a `500` retries forever;
`upstream_failed` with a reason and a pointer to `/api/health` can be reported to
a human instead.

## Tests

```bash
node source/test_ai_access.js   # 45 — token parsing, scope gating, field policy
node source/test_ai_routes.js   # 58 — status codes, and what each response contains
```

The field-policy tests assert every deny path, and cross-check that nothing
marked `sensitive` in the dictionary can survive a `pnl.topline` filter. A
mistake there leaks salaries, so it is tested from both directions.
