# ProShip MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stateless public MCP server at `mcp.proship.me` letting AI agents sign up for ProShip and create/track/label Thailand Post shipments.

**Architecture:** Standalone Fastify app with one hand-rolled JSON-RPC 2.0 endpoint (`POST /mcp`), a ported ProShip HTTP client (`lib/proship.js` from `~/Projects/shopout/lib/shipping/proship.js`), and zero persistence — auth is a pass-through `Authorization: Bearer <ProShip JWT>` header. Only exception to statelessness: a 10-minute in-memory label cache so `print_label` can return a URL instead of megabytes of base64.

**Tech Stack:** Node 20 (ESM), Fastify 5, `@fastify/cors`, `@fastify/rate-limit`, `node:test` + Fastify `inject()` for tests, stubbed `globalThis.fetch` for upstream mocking. Deploy: Fly.io app `proship-mcp` (sin).

**Spec:** `docs/superpowers/specs/2026-08-17-proship-mcp-design.md`

## Global Constraints

- Node 20 ESM (`"type": "module"`). No TypeScript, no build step.
- No database, no stored customer credentials anywhere.
- Runtime deps limited to: `fastify`, `@fastify/cors`, `@fastify/rate-limit`. No MCP SDK.
- **No pricing language** in any tool description, doc page, or README: no rates, fees, percentages, or "ฟรี/free" claims (ProShip sitewide rule).
- Upstream bases (env-overridable): `PROSHIP_API_BASE` → `https://api.proship.me`; shops gateway `https://x1pukio3fj.execute-api.ap-southeast-1.amazonaws.com/dev/v1`; utrack gateway `https://584i7lz3vc.execute-api.ap-southeast-1.amazonaws.com/dev/v1`.
- Pipe-id rule: strip `|suffix` for GET/PUT/DELETE; keep full id for print.
- Weight is grams; currency THB; status labels are the Thai 12-code map (status 6 = กำลังนำส่ง, not "ERROR").
- All commits: `git add <files> && git commit` with a conventional message; commit after every green test cycle.

## File Structure

```
proship-mcp/
├── package.json          # deps + "test": "node --test test/"
├── server.js             # bootstrap: CORS, rate limits, /healthz, register routes/mcp.js at /mcp
├── lib/
│   ├── errors.js         # ShippingError (verbatim copy from shopout)
│   ├── proship.js        # ported upstream client
│   └── labelcache.js     # in-memory TTL store for label PDFs
├── routes/
│   └── mcp.js            # tool registry + JSON-RPC handler + docs page + GET /label/:token
├── test/
│   ├── proship.test.js
│   ├── rpc.test.js
│   └── tools.test.js
├── Dockerfile
├── fly.toml
└── README.md
```

---

### Task 1: Scaffold + ported client with tests

**Files:**
- Create: `package.json`, `.gitignore`, `lib/errors.js`, `lib/proship.js`
- Test: `test/proship.test.js`

**Interfaces:**
- Produces: `lib/proship.js` exports used by Task 3/4: `stripPipe(id)`, `statusLabel(code)`, `STATUS_LABELS`, `decodeJwtUser(token)`, `createOrder(creds, payload)`, `getOrder(creds, id)`, `listOrders(creds, {status, perPage, page})`, `updateOrderStatus(creds, id, statusCode)`, `cancelOrder(creds, id)`, `checkDuplicate(creds, {phoneNo})`, `printLabel(creds, ids, opts)` → `Buffer`, `getUniversalTracking(creds, trackingNo)`, `provisionAccount({seed})`, `provisionShop(token, shop)`. `creds = {token, user, shop_id}` — but unlike shopout, `user`/`shop_id` are optional for read calls; only `createOrder` requires them.
- Produces: `lib/errors.js` exports `ShippingError` (`.code`, `.status`, `.body`).

- [ ] **Step 1: Scaffold**

`package.json`:
```json
{
  "name": "proship-mcp",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "@fastify/cors": "^10.0.0",
    "@fastify/rate-limit": "^10.0.0"
  }
}
```
`.gitignore`: `node_modules/`, `.env`, `*.log`. Run `npm install`.

Copy `~/Projects/shopout/lib/shipping/errors.js` → `lib/errors.js` **verbatim**, then delete the `ProShipError` alias lines (legacy, not needed here).

- [ ] **Step 2: Write failing tests for the pure functions**

`test/proship.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripPipe, statusLabel, decodeJwtUser, createOrder, printLabel } from '../lib/proship.js';
import { ShippingError } from '../lib/errors.js';

test('stripPipe removes suffix, passes plain ids through', () => {
  assert.equal(stripPipe('order-abc|1727591866944'), 'order-abc');
  assert.equal(stripPipe('order-abc'), 'order-abc');
  assert.equal(stripPipe(null), null);
});

test('statusLabel maps known codes and falls back', () => {
  assert.equal(statusLabel(4), 'จัดส่งสำเร็จ');
  assert.equal(statusLabel(6), 'กำลังนำส่ง');   // NOT "ERROR"
  assert.equal(statusLabel(99), 'Status 99');
  assert.equal(statusLabel(null), 'Not shipped');
});

test('decodeJwtUser extracts user from a JWT payload', () => {
  const payload = Buffer.from(JSON.stringify({ user: 'TEST2', iat: 1 })).toString('base64url');
  assert.equal(decodeJwtUser(`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`), 'TEST2');
  assert.equal(decodeJwtUser('not-a-jwt'), null);
});

test('createOrder validates required fields before any HTTP', async () => {
  await assert.rejects(
    () => createOrder({ token: 't', user: 'u', shop_id: 's' }, { weight: 500 }),
    (e) => e instanceof ShippingError && e.code === 'BAD_INPUT'
  );
});

test('printLabel rejects stripped ids', async () => {
  await assert.rejects(
    () => printLabel({ token: 't' }, ['order-abc']),
    (e) => e instanceof ShippingError && /pipe/.test(e.message)
  );
});
```

- [ ] **Step 3: Run to verify failure** — `npm test`. Expected: FAIL (cannot find `../lib/proship.js`).

- [ ] **Step 4: Port `lib/proship.js`**

Start from `~/Projects/shopout/lib/shipping/proship.js` and apply these changes:

*Keep verbatim:* `call()`, `callPublic()`, `sleep()`, `stripPipe()`, the `statusLabels` map (rename export to `STATUS_LABELS`, drop the surrounding `meta` object, badges, `COMPLETED_STATUS_CODES`, `PROBLEM_STATUS_CODES`), `statusLabel()`, `getUniversalTracking()`, `provisionAccount()`, `provisionShop()`, `synthesizeMobile()`, `synthesizePassword()`, base-URL constants (`PUBLIC_BASE`, `SHOPS_BASE`, `UTRACK_BASE`), `TIMEOUT_MS`, `RETRY_DELAY_MS`.

*Drop:* `meta.credentialsSchema`, `meta.carriers`, `STATUS_BADGES`, `validateCodWallet`, `setKerryMerchantId`, `verifyWebhook`, `parseWebhook`, `MONEYPOST_BASE`, `normalizeThaiMobile` (inline the digits-strip where `provisionShop` uses it).

*Rename/reshape the adapter API (exact signatures):*
```js
// createShipment → createOrder. Same body construction, but `carrier`
// param renamed shipping_method with default 'thaipost0'.
export async function createOrder(creds, payload) { /* shopout createShipment body, plus: */ }
// getShipment → getOrder (same).
export async function getOrder(creds, providerOrderId) {}
// NEW — GET /orders/v1/orders-v2 (from the Postman collection):
export async function listOrders(creds, { status, perPage = 50, page = 1 } = {}) {
  const qs = new URLSearchParams();
  if (status !== undefined && status !== null && status !== '') qs.set('status', String(status));
  qs.set('perPage', String(Math.min(100, Math.max(1, perPage))));
  qs.set('page', String(Math.max(1, page)));
  qs.set('onlyError', 'false');
  return call('GET', `${PUBLIC_BASE}/orders/v1/orders-v2?${qs}`, { token: creds.token });
}
// updateShipmentStatus → updateOrderStatus (same).
// NEW — DELETE /orders/v1/orders/:id (stripped id):
export async function cancelOrder(creds, providerOrderId) {
  const id = stripPipe(providerOrderId);
  await call('DELETE', `${PUBLIC_BASE}/orders/v1/orders/${encodeURIComponent(id)}`, { token: creds.token });
  return { ok: true };
}
// NEW — POST /orders/v1/orders/check-duplicate:
export async function checkDuplicate(creds, { phoneNo }) {
  if (!phoneNo) throw new ShippingError('phoneNo is required', { code: 'BAD_INPUT' });
  return call('POST', `${PUBLIC_BASE}/orders/v1/orders/check-duplicate`,
    { token: creds.token, body: { phoneNo: String(phoneNo).replace(/\D/g, '') } });
}
// printLabel: keep shopout's implementation exactly (full-pipe-id guard, base64 → Buffer).
// NEW — pass-through auth needs `user` for createOrder; extract from JWT:
export function decodeJwtUser(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload?.user || payload?.username || null;
  } catch { return null; }
}
```

*Change `requireCreds`:* only `token` is always required; `createOrder` additionally requires `user` + `shop_id` (validate inline there). Read calls (`getOrder`, `listOrders`, tracking, print, cancel, checkDuplicate) need token only.

*Change `provisionAccount`:* signature becomes `provisionAccount({ seed })` — `seed` is a display-name string from the signup tool (default `'ProShip MCP User'`); synth email becomes `` `proship-mcp-${rand}@proship.me` `` (env-overridable `PROSHIP_SYNTH_EMAIL_DOMAIN`, default `proship.me`). Keep the 5-attempt uniqueness-collision retry and the `EXISTING_PROSHIP_ACCOUNT` terminal error exactly as shopout has them.

*Change `provisionShop`:* keep shopout's create-then-list-and-match flow verbatim (POST returns no id), including `shippingMethods: ['thaipost0']` default.

- [ ] **Step 5: Run tests** — `npm test`. Expected: PASS (5 tests).

- [ ] **Step 6: Add mocked-fetch tests for `call()` behavior**

Append to `test/proship.test.js`:
```js
import { getOrder } from '../lib/proship.js';

function stubFetch(responses) {
  // responses: array of {status, body} consumed in order
  let i = 0;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), {
      status: r.status, headers: { 'Content-Type': 'application/json' }
    });
  };
  return calls;
}
const realFetch = globalThis.fetch;

test('call retries once on 5xx then succeeds', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = stubFetch([{ status: 502, body: {} }, { status: 200, body: { status: 4 } }]);
  const res = await getOrder({ token: 't' }, 'order-x|123');
  assert.equal(res.statusLabel, 'จัดส่งสำเร็จ');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/orders/v1/orders/order-x'), 'pipe suffix must be stripped');
});

test('call maps non-2xx to ShippingError with HTTP_ code', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubFetch([{ status: 401, body: { message: 'Unauthorized' } }]);
  await assert.rejects(() => getOrder({ token: 'bad' }, 'order-x'),
    (e) => e instanceof ShippingError && e.code === 'HTTP_401' && e.status === 401);
});
```

- [ ] **Step 7: Run tests** — `npm test`. Expected: PASS (7 tests).
- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat: scaffold + ported ProShip client with tests"`

---

### Task 2: Label cache

**Files:**
- Create: `lib/labelcache.js`
- Test: `test/proship.test.js` (append)

**Interfaces:**
- Produces: `putLabel(buffer)` → `token` (32-hex string); `takeLabel(token)` → `Buffer|null`. Entries expire after `LABEL_TTL_MS = 10 * 60_000`; a successful `takeLabel` does NOT delete (agents/users may fetch twice); expiry sweep runs lazily on each call. Max 200 entries — oldest evicted first.

- [ ] **Step 1: Failing test**
```js
import { putLabel, takeLabel } from '../lib/labelcache.js';

test('label cache stores and returns buffers by token', () => {
  const tok = putLabel(Buffer.from('%PDF-fake'));
  assert.match(tok, /^[0-9a-f]{32}$/);
  assert.equal(takeLabel(tok).toString(), '%PDF-fake');
  assert.equal(takeLabel('0'.repeat(32)), null);
});
```
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**
```js
// lib/labelcache.js — ephemeral store so print_label can return a URL
// instead of inlining megabytes of base64 into the tool result. This is
// the ONLY state in the server; losing it on restart just means
// re-printing.
import crypto from 'crypto';

const LABEL_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 200;
const store = new Map(); // token -> {buf, exp}

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) if (v.exp < now) store.delete(k);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

export function putLabel(buf) {
  sweep();
  const token = crypto.randomBytes(16).toString('hex');
  store.set(token, { buf, exp: Date.now() + LABEL_TTL_MS });
  return token;
}

export function takeLabel(token) {
  sweep();
  return store.get(String(token))?.buf || null;
}
```
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat: ephemeral label cache"`

---

### Task 3: JSON-RPC core + server bootstrap

**Files:**
- Create: `server.js`, `routes/mcp.js` (protocol layer only; tools land in Task 4)
- Test: `test/rpc.test.js`

**Interfaces:**
- Consumes: nothing from Task 1/2 yet (empty registry OK at this step, but Task 4 fills `PUBLIC_TOOLS` / `AUTHED_TOOLS` in this same file).
- Produces: `routes/mcp.js` default-exports a Fastify plugin registering `GET /`, `POST /`, `GET /label/:token`. `server.js` exports `buildServer()` (used by tests via `app.inject`) and listens only when run directly.

- [ ] **Step 1: Failing tests**

`test/rpc.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../server.js';

async function rpc(app, body, headers = {}) {
  const res = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });
  return res;
}

test('initialize echoes a supported protocolVersion', async () => {
  const app = await buildServer();
  const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26' } });
  const out = res.json();
  assert.equal(out.result.protocolVersion, '2025-03-26');
  assert.equal(out.result.serverInfo.name, 'proship-mcp');
  await app.close();
});

test('initialize falls back to latest for unknown versions', async () => {
  const app = await buildServer();
  const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '1999-01-01' } });
  assert.equal(res.json().result.protocolVersion, '2025-06-18');
  await app.close();
});

test('notifications get 202 with empty body', async () => {
  const app = await buildServer();
  const res = await rpc(app, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body, '');
  await app.close();
});

test('unknown method returns -32601; ping returns {}', async () => {
  const app = await buildServer();
  assert.equal((await rpc(app, { jsonrpc: '2.0', id: 2, method: 'nope' })).json().error.code, -32601);
  assert.deepEqual((await rpc(app, { jsonrpc: '2.0', id: 3, method: 'ping' })).json().result, {});
  await app.close();
});

test('CORS preflight is answered', async () => {
  const app = await buildServer();
  const res = await app.inject({ method: 'OPTIONS', url: '/mcp',
    headers: { origin: 'https://example.com', 'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type' } });
  assert.equal(res.statusCode, 204);
  assert.ok(res.headers['access-control-allow-origin']);
  await app.close();
});

test('GET /mcp returns JSON manifest by default, HTML for browsers', async () => {
  const app = await buildServer();
  const j = await app.inject({ method: 'GET', url: '/mcp' });
  assert.equal(j.json().name, 'proship-mcp');
  const h = await app.inject({ method: 'GET', url: '/mcp', headers: { accept: 'text/html' } });
  assert.match(h.headers['content-type'], /text\/html/);
  await app.close();
});
```

- [ ] **Step 2: Run — expect FAIL** (`buildServer` not defined).

- [ ] **Step 3: Implement `server.js`**
```js
// ProShip MCP — stateless MCP server over the public ProShip API.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import mcpRoutes from './routes/mcp.js';

export async function buildServer() {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' });
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Mcp-Protocol-Version', 'MCP-Protocol-Version'],
  });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  app.get('/healthz', async () => ({ ok: true }));
  await app.register(mcpRoutes, { prefix: '/mcp' });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  const port = Number(process.env.PORT || 3000);
  app.listen({ port, host: '0.0.0.0' }).catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Implement the protocol layer in `routes/mcp.js`**

Model on `~/Projects/shopout/routes/mcp.js:709-777` (`rpcResult`/`rpcError`/`handleMessage`/POST route) with these deltas:
```js
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = SUPPORTED_VERSIONS[0];
const SERVER_INFO = { name: 'proship-mcp', version: '1.0.0' };

// initialize: echo the client's version when we support it, else offer latest.
case 'initialize': {
  const req = params?.protocolVersion;
  const protocolVersion = SUPPORTED_VERSIONS.includes(req) ? req : LATEST;
  return rpcResult(id, {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions:
      'ProShip is a Thai order-management platform connected to Thailand Post. ' +
      'Public tools: track_parcel, get_order_statuses, signup. All other tools require ' +
      'Authorization: Bearer <ProShip API token> — get one via the signup tool or at ' +
      'https://developer.proship.me. Weights are grams. Statuses use Thai labels. ' +
      'Order ids contain a pipe suffix (order-xxx|123): always pass the FULL id back to tools.',
  });
}
```
POST handler differences from shopout:
```js
app.post('/', async (request, reply) => {
  const h = String(request.headers?.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  const ctx = { token, user: token ? decodeJwtUser(token) : null };

  const body = request.body;
  const isNotification = (m) => m && typeof m === 'object' && (m.id === undefined || m.id === null) && typeof m.method === 'string';
  if (!Array.isArray(body) && isNotification(body)) {
    handleMessage(body, ctx); // fire-and-forget (all our notifications are no-ops)
    return reply.code(202).send();
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter((x) => x !== null);
    if (out.length === 0) return reply.code(202).send();
    return reply.header('Content-Type', 'application/json; charset=utf-8').send(out);
  }
  const out = await handleMessage(body || {}, ctx);
  return reply.header('Content-Type', 'application/json; charset=utf-8').send(out);
});
```
`handleMessage` must be **async** (tool handlers hit the network) — shopout's is sync; ours awaits `tool.handler(params.arguments || {}, ctx, request)`. Keep shopout's try/catch → `-32000` + `console.error('[mcp]', ...)`, and the `content:[{type:'text', text: JSON.stringify(result, null, 2)}], isError: !!result?.error` envelope. Registry: `const ALL_TOOLS = { ...PUBLIC_TOOLS, ...AUTHED_TOOLS };` — both maps empty object literals for now. Auth gate: `if (name in AUTHED_TOOLS && !ctx.token) return rpcError(id, -32001, 'Authentication required', { detail: 'Pass Authorization: Bearer <ProShip API token>. No account? Call the signup tool, or see https://developer.proship.me.' });`

`GET /` and `GET /label/:token` (stub returning 404 for now); manifest JSON mirrors shopout's shape with `name: 'proship-mcp'`. Docs HTML lands in Task 5 — for now `docsHtml()` can return a minimal page (`<h1>ProShip MCP</h1>` + tool list) so the content-negotiation test passes.

- [ ] **Step 5: Run — expect PASS (all rpc tests).**
- [ ] **Step 6: Commit** — `git commit -m "feat: JSON-RPC core, version negotiation, CORS, 202 notifications"`

---

### Task 4: Tools

**Files:**
- Modify: `routes/mcp.js` (fill `PUBLIC_TOOLS` and `AUTHED_TOOLS`)
- Test: `test/tools.test.js`

**Interfaces:**
- Consumes: everything Task 1 exports from `lib/proship.js`; `putLabel` from `lib/labelcache.js`.
- Produces: tools `track_parcel`, `get_order_statuses`, `signup` (public); `list_shops`, `create_order`, `list_orders`, `get_order`, `update_order_status`, `cancel_order`, `check_duplicate`, `print_label` (authed). `GET /label/:token` serves cached PDFs.

Every handler follows the soft-error convention: return `{ error: '<code>', detail?: '...' }` for business failures; `ShippingError`s from `lib/proship.js` are caught **inside the handler** and mapped:
```js
function softError(e) {
  if (e?.code === 'HTTP_401') return { error: 'unauthorized', detail: 'ProShip rejected the token. Check your Authorization header.' };
  if (e?.code === 'NETWORK') return { error: 'upstream_unreachable', detail: e.message };
  return { error: e?.code || 'upstream_error', detail: e?.message, body: e?.body ?? undefined };
}
```

- [ ] **Step 1: Failing tests** — `test/tools.test.js` (same `rpc()`/`stubFetch()` helpers as earlier tests; extract them to `test/helpers.js` and import from both files):
```js
test('tools/list exposes all 11 tools to unauthenticated clients', async () => {
  const app = await buildServer();
  const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = res.json().result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['cancel_order', 'check_duplicate', 'create_order', 'get_order',
    'get_order_statuses', 'list_orders', 'list_shops', 'print_label', 'signup',
    'track_parcel', 'update_order_status']);
  await app.close();
});

test('authed tool without token → -32001 with signup pointer', async () => {
  const app = await buildServer();
  const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'create_order', arguments: {} } });
  const err = res.json().error;
  assert.equal(err.code, -32001);
  assert.match(err.data.detail, /signup/);
  await app.close();
});

test('get_order_statuses returns the Thai pipeline without auth', async () => {
  const app = await buildServer();
  const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'get_order_statuses', arguments: {} } });
  const data = JSON.parse(res.json().result.content[0].text);
  assert.equal(data.statuses.find((s) => s.code === 6).label_th, 'กำลังนำส่ง');
  await app.close();
});

test('create_order passes through token, injects user from JWT, defaults thaipost0', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = stubFetch([{ status: 200, body: { id: 'order-1|999', trackingNo: 'TH123' } }]);
  const app = await buildServer();
  const payload = Buffer.from(JSON.stringify({ user: 'TEST2' })).toString('base64url');
  const jwt = `e30.${payload}.x`;
  const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'create_order', arguments: {
      shop_id: 'shop-1', weight: 500,
      customer: { name: 'สมชาย', phoneNo: '0812345678',
        address: { address: '1 ถ.สุขุมวิท', province: 'กรุงเทพมหานคร', district: 'คลองเตย', subDistrict: 'คลองเตย', zipcode: '10110' } },
    } } }, { authorization: `Bearer ${jwt}` });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.user, 'TEST2');
  assert.equal(sent.shippingMethod, 'thaipost0');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${jwt}`);
  const data = JSON.parse(res.json().result.content[0].text);
  assert.equal(data.order_id, 'order-1|999');
  assert.equal(data.tracking_no, 'TH123');
  await app.close();
});

test('print_label caches PDF and returns a /label URL that serves it', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubFetch([{ status: 200, body: { base64: Buffer.from('%PDF-x').toString('base64') } }]);
  const app = await buildServer();
  const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'print_label', arguments: { order_ids: ['order-1|999'] } } },
    { authorization: 'Bearer tok' });
  const data = JSON.parse(res.json().result.content[0].text);
  assert.match(data.label_url, /\/mcp\/label\/[0-9a-f]{32}$/);
  const pdf = await app.inject({ method: 'GET', url: new URL(data.label_url).pathname });
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.body, '%PDF-x');
  await app.close();
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement the tools**

All descriptors use hand-written JSON Schema (shopout style). Full registry:

**`get_order_statuses`** (public, no upstream call): returns `{ statuses: [{code, label_th, meaning_en}] }` built from `STATUS_LABELS` plus English glosses: `-2` suspended, `-1` draft, `0` pending, `1` awaiting pickup, `2` shipped, `3` carrier received, `4` delivered, `5` cancelled by seller, `6` out for delivery, `8` returned to sender, `34` customer unreachable, `41` delivery problem.

**`track_parcel`** (public): input `{ tracking_no: string (required) }`. Token resolution: `ctx.token || process.env.PROSHIP_UTRACK_TOKEN`. If neither → `{ error: 'auth_or_config_required', detail: 'Pass a Bearer token, or the server operator must set PROSHIP_UTRACK_TOKEN.' }`. Calls `getUniversalTracking({token}, tracking_no)`; returns `{ status, status_label, carrier, history }`.

**`signup`** (public): input `{ shop_name (req), phone (req), address: {address, sub_district, district, province, zipcode} (req), display_name? }`. Description states verbatim: *"Creates a real ProShip account and shop, ready for Thailand Post EPS (thaipost0) shipping. The response contains your API token, user, and shop_id — SHOWN ONLY ONCE. Save the token into your MCP client's Authorization header. A full thaipost contract additionally requires a Thailand Post account arranged with ProShip support (multi-day human process)."* Handler: `provisionAccount({seed: display_name || shop_name})` → `provisionShop(token, {name: shop_name, phoneNo: phone, address: {...address, subDistrict: address.sub_district}})` → returns `{ token, user: decodeJwtUser(token), shop_id, save_this: 'Store the token now — it is not retrievable later. Configure it as: Authorization: Bearer <token>' }`. On `EXISTING_PROSHIP_ACCOUNT` → `{ error: 'existing_account', detail: 'Registration collided with an existing account. Use your existing ProShip token from https://developer.proship.me instead.' }`.

**`list_shops`** (authed): no params. `call('GET', SHOPS_BASE + '/shops?responseSize=all')` via a new thin `listShops(creds)` export in `lib/proship.js`; map rows to `{ shop_id: s.id, name: s.details?.name, phone: s.details?.phoneNo }`.

**`create_order`** (authed): input `{ shop_id (req), weight (req, grams), customer: {name, phone, address:{address, sub_district, district, province, zipcode}} (req), shipping_method (default 'thaipost0'; enum ['thaipost0','thaipost']), cod_amount?, remarks?, ref_no?, products?: [{name, qty, price?}] }`. `user` param optional — defaults to `ctx.user` (JWT-decoded); if both missing → `{ error: 'user_required', detail: 'Could not read user from token; pass user explicitly.' }`. Maps snake_case → the upstream camelCase body via `createOrder()`. Returns `{ order_id (FULL pipe id), tracking_no, status_note: 'Pass the full order_id (with |suffix) to other tools.' }`.

**`list_orders`** (authed): `{ status? (number, see get_order_statuses), per_page?, page? }` → `listOrders`. **`get_order`** (authed): `{ order_id }` → `getOrder`; returns `{ status, status_label, tracking_no, raw }`. **`update_order_status`** (authed): `{ order_id, status (number) }` → `updateOrderStatus`. **`cancel_order`** (authed): `{ order_id }` → `cancelOrder`. **`check_duplicate`** (authed): `{ phone }` → `checkDuplicate`.

**`print_label`** (authed): `{ order_ids: string[] (req, FULL pipe ids), size? ('normal'), printer? ('proship'|'proship_v3p'|'paperang') }` → `printLabel` → `putLabel(buffer)` → `{ label_url: `${PUBLIC_URL}/mcp/label/${token}`, expires_in_minutes: 10 }` where `PUBLIC_URL = process.env.PUBLIC_URL || 'https://mcp.proship.me'`. Description warns: full pipe-suffixed ids required.

**`GET /label/:token`** route: `takeLabel` → hit: `reply.header('Content-Type','application/pdf').header('Content-Disposition','inline; filename="label.pdf"').send(buf)`; miss: 404 `{error:'expired_or_unknown'}`.

**Signup rate limit** (from spec §6): in the signup handler, a module-level `Map<ip, timestamps[]>`; reject with `{ error: 'rate_limited', detail: 'Max 3 signups per hour per IP.' }` when 3 in the trailing hour. (Handler receives `request` as 3rd arg for `request.ip`.)

- [ ] **Step 4: Run — expect PASS (all suites).**
- [ ] **Step 5: Commit** — `git commit -m "feat: all 11 MCP tools with tests"`

---

### Task 5: Docs page + README

**Files:**
- Modify: `routes/mcp.js` (`docsHtml()`)
- Create: `README.md`
- Test: `test/rpc.test.js` (append one assertion)

- [ ] **Step 1: Failing test** — append:
```js
test('HTML docs render every tool from the registry', async () => {
  const app = await buildServer();
  const res = await app.inject({ method: 'GET', url: '/mcp', headers: { accept: 'text/html' } });
  for (const name of ['track_parcel', 'signup', 'create_order', 'print_label']) {
    assert.match(res.body, new RegExp(`<code>${name}</code>`));
  }
  await app.close();
});
```
- [ ] **Step 2: Run — expect FAIL** (minimal stub page lacks schema tables).
- [ ] **Step 3: Implement** — port shopout's `docsHtml()` (`routes/mcp.js:783-973`) wholesale: keep `renderTool`/`renderSchema`/`escapeHtml` mechanics exactly (they read from the registry, which is the whole point). Rewrite copy: title "ProShip MCP — Thailand Post for AI agents"; sections: What this is / Connect a client (`https://mcp.proship.me/mcp`, `mcp-remote` + `--header Authorization:Bearer <token>` snippets, raw curl) / Getting a token (option A: `signup` tool; option B: existing account at developer.proship.me) / Public tools / Authenticated tools / Protocol details (endpoint, versions list, methods). Palette: swap the orange gradient for ProShip red `#D32F2F`→`#EF5350`. **No pricing language anywhere.** Also write `README.md`: what it is, env vars (`PORT`, `PUBLIC_URL`, `PROSHIP_API_BASE`, `PROSHIP_UTRACK_TOKEN`, `PROSHIP_SYNTH_EMAIL_DOMAIN`), run/test/deploy commands, tool table (generated by hand once — the HTML page is the canonical, non-drifting doc; README links to it).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat: self-documenting HTML docs page + README"`

---

### Task 6: Deploy + live smoke test

**Files:**
- Create: `Dockerfile`, `fly.toml`

- [ ] **Step 1: Dockerfile** (shopout's, minus the volume):
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
```
- [ ] **Step 2: fly.toml**
```toml
app = "proship-mcp"
primary_region = "sin"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```
(Stateless + fast cold start → scale-to-zero is fine, unlike shopout's always-on.)
- [ ] **Step 3: Full test run** — `npm test`. Expected: all PASS.
- [ ] **Step 4: Deploy** — `fly launch --no-deploy --copy-config --name proship-mcp --region sin` then `fly deploy` (fallback `fly deploy --depot=false` if the Depot builder fails with "Could not find image"). Set secrets if available: `fly secrets set PROSHIP_UTRACK_TOKEN=...` (optional — track_parcel degrades gracefully without it).
- [ ] **Step 5: Protocol smoke against the Fly URL**
```bash
curl -s https://proship-mcp.fly.dev/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
curl -s https://proship-mcp.fly.dev/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```
Expected: initialize echoes version; tools/list shows 11 tools.
- [ ] **Step 6: LIVE smoke (definition of done)** — via curl `tools/call`: `signup` (throwaway shop) → `create_order` (thaipost0, 500g, a real-looking Bangkok address) → `print_label` → `curl -o label.pdf` the returned URL and verify it starts with `%PDF`. Then `cancel_order` the test order. If signup fails with `existing_account` or upstream 4xx, STOP and report the exact response — do not fake success.
- [ ] **Step 7: Commit** — `git commit -m "feat: Fly deployment config"`
- [ ] **Step 8: Post-deploy notes** — append 2-3 lines to `~/Projects/brain 2.0/Projects/Proship & Logistics.md` (proship-mcp built, deployed, what's blocking). Name the Vik-only step: **Route53 CNAME `mcp.proship.me` → `proship-mcp.fly.dev` + `fly certs add mcp.proship.me`** (cert command can be run once DNS exists).

---

## Self-Review Notes

- Spec coverage: §1 architecture → Tasks 1-3; §2 auth → Task 3; §3 tools (all 11) → Task 4; §4 docs → Task 5; §5 errors → Task 4 `softError`; §6 abuse → Task 3 (global) + Task 4 (signup); §7 testing → every task + Task 6 live smoke; §8 exclusions honored (no batch/webhook/OAuth tools anywhere).
- Deviation from spec, intentional: `print_label` needs the 10-minute in-memory label cache (spec said "returns PDF URL"; upstream returns base64 only — a URL requires somewhere to serve from). No durable state involved.
- `track_parcel`'s optional `PROSHIP_UTRACK_TOKEN` env var is a server-side operator secret, not a customer credential — consistent with the no-stored-customer-secrets rule.
