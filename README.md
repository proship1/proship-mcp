# proship-mcp

Stateless MCP (Model Context Protocol) server that lets any AI agent create Thailand Post shipments, print labels, and track parcels through [ProShip](https://proship.co.th).

- **Endpoint:** `POST https://mcp.proship.me/mcp` (JSON-RPC 2.0, application/json)
- **Docs:** open `https://mcp.proship.me/mcp` in a browser — the docs page is generated from the live tool registry
- **Auth:** `Authorization: Bearer <ProShip API token>`, passed through verbatim to `api.proship.me`. Nothing is stored server-side. New users can call the public `signup` tool to get a token.

## Tools

Public: `track_parcel`, `get_order_statuses`, `signup`.
Authenticated: `list_shops`, `create_order`, `list_orders`, `get_order`, `update_order_status`, `cancel_order`, `check_duplicate`, `print_label`.

The browser docs page at `/mcp` is the canonical, always-current tool reference.

## Run

```bash
npm install
npm start          # listens on PORT (default 3000)
npm test           # node:test suite, upstream fully mocked
```

## Environment

| Var | Purpose | Default |
|---|---|---|
| `PORT` | listen port | `3000` |
| `PUBLIC_URL` | absolute base used in label URLs and docs | `https://mcp.proship.me` |
| `PROSHIP_API_BASE` | upstream API base | `https://api.proship.me` |
| `PROSHIP_UTRACK_TOKEN` | optional server-side token enabling unauthenticated `track_parcel` | unset |
| `PROSHIP_SYNTH_EMAIL_DOMAIN` | domain for synthesized signup emails | `proship.me` |

## Deploy

Fly.io app `proship-mcp` (region `sin`):

```bash
fly deploy            # add --depot=false if the Depot builder fails
```

## Notes

- Order ids are pipe-suffixed (`order-xxx|123`). GET/PUT/DELETE strip the suffix internally; `print_label` requires the full id. Always pass the full id between tools.
- Weights are grams. Status codes use the Thai pipeline (`get_order_statuses`); code 6 means *out for delivery* despite upstream labeling it "ERROR".
- The only server state is a 10-minute in-memory cache for label PDFs so `print_label` can return a URL.
