# ProShip MCP — Design

**Date:** 2026-08-17
**Status:** Approved (design), pre-implementation
**Goal:** A public MCP server so AI agents can create and manage Thailand Post shipments through ProShip — modeled on shopout's proven MCP (`shopout/routes/mcp.js`).

**Success criterion:** an outside AI agent signs up, creates a Thailand Post (EPS) order, and prints a label through `mcp.proship.me`. Vik owns this number. The one owner-side step: Route53 DNS for `mcp.proship.me`.

## 1. Architecture

Standalone stateless service. No database, no stored secrets.

- **Stack:** Node 20 (ESM), Fastify 5, no MCP SDK — hand-rolled JSON-RPC 2.0 over a single `POST /mcp` route (shopout's proven shape).
- **Deploy:** Fly.io app `proship-mcp`, region `sin`, plain `node:20-slim` Dockerfile. No volume (nothing to persist).
- **Domain:** `mcp.proship.me` (Route53 CNAME → Fly; Vik-owned step).
- **Upstream:** `https://api.proship.me` (public façade over the ProShip Lambda backend). Raw API-Gateway URLs only where no public mapping exists: universal tracking (`utrack`) and shops. Base URLs overridable via env vars.

### Modules

| File | Purpose |
|---|---|
| `server.js` | Fastify bootstrap, CORS, rate limiting, health check |
| `routes/mcp.js` | JSON-RPC handler (`initialize`, `tools/list`, `tools/call`, `notifications/initialized`, `ping`), tool registry, auto-generated HTML docs on `GET /mcp` |
| `lib/proship.js` | Upstream client, ported from `shopout/lib/shipping/proship.js` |
| `lib/errors.js` | `ShippingError` (code, status, body), ported from shopout |

### Ported knowledge (do not re-derive)

From `shopout/lib/shipping/proship.js`:

- `call()` helper: 30s `AbortController` timeout, single retry on 5xx/network with 1s backoff, non-2xx → `ShippingError{code:'HTTP_<status>'}`.
- **Pipe-id quirk:** create returns `order-xxx|<ts>`. GET/PUT/DELETE need the id **stripped** of the pipe suffix; `print-label` needs the **full** pipe-suffixed id (stripped ids → 400 "Orders not eligible for printing labels").
- Status map incl. quirk: code 4 = delivered, code 6 is labeled "ERROR" upstream but means *out for delivery*; 8/34/41 = problem states.
- Credentials triple: `token` (non-expiring Bearer JWT) + `user` (embedded in JWT) + `shopId` are coupled.
- BYOA provisioning chain: `POST /auth/v1/auth/register` (synthesized password) → shop create → returns JWT. `EXISTING_PROSHIP_ACCOUNT` is a distinct error surfaced to the user.

**Dropped from the port:** AES-GCM credential store (we store nothing), Kerry/Flash/Shopee-specific paths (v1 is Thailand Post-focused; carrier param stays open).

### Fixes over shopout's implementation (known warts)

- Echo the client's `protocolVersion` on `initialize`; honor `MCP-Protocol-Version` header (shopout hardcodes `2024-11-05` and mislabels it "Streamable HTTP").
- CORS headers on `/mcp` so browser-hosted MCP clients work.
- Notifications → `202 Accepted` with empty body (shopout returns 200 + `null`).
- No duplicated auth logic — there is only pass-through.

## 2. Auth & tenancy

- `Authorization: Bearer <ProShip JWT>` on the POST, passed through verbatim to `api.proship.me`. The server never persists it.
- Tenancy = ProShip's own: the JWT scopes everything upstream. `shop_id` is an explicit tool parameter, discoverable via `list_shops`.
- Full tool list is **always** exposed regardless of auth (hiding tools confuses LLMs — shopout/Anthropic guidance). Unauthenticated call to an authed tool → JSON-RPC `-32001` with `data.detail` explaining how to get a token (`signup` tool or developer.proship.me).

## 3. Tools

### Public (no auth)

| Tool | Backs onto | Notes |
|---|---|---|
| `track_parcel` | `utrack?barcode=` | Universal tracking; the demo tool |
| `signup` | `/auth/v1/auth/register` + shop create | Creates a real ProShip account. **Returns `{token, user, shopId}` exactly once** with instructions to save it into the MCP client config. Defaults carrier capability to `thaipost0` (EPS — instant). Tool description states honestly that a full `thaipost` contract is a multi-day human process via ProShip support. |

### Authed (Bearer)

| Tool | Backs onto |
|---|---|
| `list_shops` | shops gateway |
| `create_order` | `POST /orders/v1/orders` — required: `shipping_method` (default `thaipost0`), `shop_id`, `weight` (grams), `customer`, `products`; optional `cod_amount`, `remarks` |
| `list_orders` | `GET /orders/v1/orders-v2?status=&perPage=` |
| `get_order` | `GET /orders/v1/orders/:id` (stripped id) |
| `update_order_status` | `PUT /orders/v1/orders/:id/status` |
| `cancel_order` | `DELETE /orders/v1/orders/:id` |
| `check_duplicate` | `POST /orders/v1/orders/check-duplicate` |
| `print_label` | `POST /print/v1/print-label` (full pipe id) → PDF URL |
| `get_order_statuses` | static reference data: the 11-status Thai pipeline with English glosses |

### Excluded, with reasons

- **Rate quotes, pickup booking** — no upstream endpoint exists.
- **Batch create / print-batch** — v2; single-order flow first.
- **Address parsing** — upstream gateway currently 401s (noted in proship-address-bot).
- **Any pricing language** anywhere in tool descriptions or docs — sitewide ProShip rule (no rates, fees, percentages, "ฟรี").

## 4. Tool registry & docs

shopout's registry-of-descriptors pattern: each tool is `{descriptor: {name, description, inputSchema}, handler(params, ctx)}` in one map. The map drives `tools/list`, `tools/call`, and the `GET /mcp` HTML docs page (content negotiation: `Accept: text/html` → docs with connect snippets for Claude/Cursor/curl; otherwise JSON manifest). Docs generated from the registry cannot drift. One doc source only — no separate hand-maintained tool list anywhere.

## 5. Error handling

- Business failures are **soft**: returned inside the result (`{error: 'not_found', detail}`), `isError: true` on the content envelope. Upstream `ShippingError` codes map through (`HTTP_401` → "token invalid/expired — re-check your Authorization header").
- Only thrown exceptions become JSON-RPC `-32000` with `data.detail`; logged as `[mcp] <tool> <message>`.
- Partial-success where upstream allows it (shopout's `seller_update_product` pattern).

## 6. Abuse guard

- `signup`: strict per-IP rate limit (3/hour/IP) — it creates real accounts upstream.
- All other routes: global `@fastify/rate-limit` (600/min/IP, shopout's default).
- Escalate to invite codes only if abuse actually shows up. YAGNI.

## 7. Testing

- Unit: `node:test` + mocked upstream (undici MockAgent) — pipe-id handling, auth pass-through, JSON-RPC envelope, each tool's happy path + auth-missing path.
- Protocol smoke: `initialize` → `tools/list` → public `track_parcel` via curl.
- **Live smoke before "done":** signup → `create_order` (EPS) → `print_label` against the real API. "It compiles" is not done.

## 8. Out of scope (v1)

Batch operations, webhooks, OAuth/.well-known discovery flow, carrier settings management, COD wallet validation, multi-carrier depth (Kerry/Flash), an MCP registry listing.
