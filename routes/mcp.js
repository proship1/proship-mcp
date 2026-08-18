// Public MCP (Model Context Protocol) server at /mcp.
//
// Two surfaces:
//   1. PUBLIC tools (no auth) — track a parcel, read the status
//      reference, or sign up for a new ProShip account.
//   2. AUTHENTICATED tools (Bearer ProShip JWT) — create/manage orders
//      and print Thailand Post labels. The token is passed through
//      verbatim to api.proship.me; this server stores nothing.
//
// Transport: one JSON-RPC message (or batch) per POST, application/json
// responses only (no SSE — no tool produces incremental output).
// Sessions: stateless; each request carries its own Authorization header.
//
// Docs: GET /mcp with Accept: text/html returns a human-readable landing
// page generated from the same tool registry the JSON-RPC handler uses,
// so the docs cannot drift from the implementation.

import {
  STATUS_LABELS, statusLabel, decodeJwtUser,
  createOrder, getOrder, listOrders, updateOrderStatus, cancelOrder,
  checkDuplicate, printLabel, listShops, getUniversalTracking,
  provisionAccount, provisionShop,
} from '../lib/proship.js';
import { putLabel, takeLabel } from '../lib/labelcache.js';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = SUPPORTED_VERSIONS[0];
const SERVER_INFO = { name: 'proship-mcp', version: '1.0.0' };

// Absolute base for self-referencing URLs (label downloads, docs).
// Derived from the request Host so the server works on any domain it is
// actually reachable at; PUBLIC_URL env var overrides when set.
// The Host value is reflected into HTML and label URLs, so it MUST be
// allowlisted — an arbitrary Host header would be an XSS / URL-poisoning
// vector.
const ALLOWED_HOSTS = new Set(['mcp.proship.me', 'proship-mcp.fly.dev']);
function publicBase(request) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const host = String(request?.headers?.host || '').toLowerCase();
  if (ALLOWED_HOSTS.has(host) || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    return `https://${host}`;
  }
  return 'https://mcp.proship.me';
}

// English glosses for the Thai status pipeline (get_order_statuses).
const STATUS_MEANINGS = {
  '-2': 'suspended', '-1': 'draft', '0': 'pending', '1': 'awaiting pickup',
  '2': 'shipped', '3': 'carrier received parcel', '4': 'delivered',
  '5': 'cancelled by seller', '6': 'out for delivery', '8': 'returned to sender',
  '34': 'customer unreachable by phone', '41': 'delivery problem',
};

// Map a ShippingError to a soft in-result error the agent can act on.
function softError(e) {
  if (e?.code === 'HTTP_401') return { error: 'unauthorized', detail: 'ProShip rejected the token. Check your Authorization header.' };
  if (e?.code === 'NETWORK') return { error: 'upstream_unreachable', detail: e.message };
  return { error: e?.code || 'upstream_error', detail: e?.message, body: e?.body ?? undefined };
}

// Signup abuse guard: 3 per trailing hour per IP (spec §6).
const SIGNUP_WINDOW_MS = 60 * 60_000;
// 10/hour, not lower: Thai mobile carriers CGNAT many users per IP.
const SIGNUP_MAX = 10;
const signupHits = new Map(); // ip -> [timestamps]
function signupAllowed(ip) {
  const now = Date.now();
  const hits = (signupHits.get(ip) || []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  if (hits.length >= SIGNUP_MAX) { signupHits.set(ip, hits); return false; }
  hits.push(now);
  signupHits.set(ip, hits);
  return true;
}

// Map the tool-facing snake_case customer/address shape onto the
// upstream camelCase shape createOrder() expects.
function toUpstreamCustomer(c) {
  const a = c?.address || {};
  return {
    name: c?.name,
    phoneNo: c?.phone,
    address: {
      address: a.address,
      province: a.province,
      district: a.district,
      subDistrict: a.sub_district,
      zipcode: a.zipcode,
    },
  };
}

const ADDRESS_SCHEMA = {
  type: 'object',
  description: 'Thai address, structured',
  properties: {
    address: { type: 'string', description: 'Street address (house no, street, etc.)' },
    sub_district: { type: 'string', description: 'ตำบล/แขวง' },
    district: { type: 'string', description: 'อำเภอ/เขต' },
    province: { type: 'string', description: 'จังหวัด' },
    zipcode: { type: 'string', description: '5-digit Thai postal code' },
  },
  required: ['address', 'sub_district', 'district', 'province', 'zipcode'],
};

// ---------------------------------------------------------------------
// PUBLIC TOOLS — no auth required.
// ---------------------------------------------------------------------
const PUBLIC_TOOLS = {
  track_parcel: {
    descriptor: {
      name: 'track_parcel',
      description:
        'Track any parcel by tracking number (Thailand Post and other Thai carriers). ' +
        'Returns current status with Thai label plus the event history. Works without auth ' +
        'if the server has a tracking token configured; otherwise pass your Bearer token.',
      inputSchema: {
        type: 'object',
        properties: { tracking_no: { type: 'string', description: 'Carrier tracking number, e.g. TH0139...' } },
        required: ['tracking_no'],
      },
    },
    async handler(params, ctx) {
      const token = ctx.token || process.env.PROSHIP_UTRACK_TOKEN;
      if (!token) {
        return { error: 'auth_or_config_required', detail: 'Pass a Bearer token, or the server operator must set PROSHIP_UTRACK_TOKEN.' };
      }
      try {
        const res = await getUniversalTracking({ token }, String(params?.tracking_no || ''));
        return { status: res.status, status_label: res.statusLabel, carrier: res.carrier, history: res.history };
      } catch (e) { return softError(e); }
    },
  },

  get_order_statuses: {
    descriptor: {
      name: 'get_order_statuses',
      description:
        'Reference data: the ProShip order status pipeline. Returns every status code with its ' +
        'Thai label and English meaning. Use these codes with list_orders and update_order_status.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler() {
      return {
        statuses: Object.keys(STATUS_LABELS).map((k) => ({
          code: Number(k),
          label_th: STATUS_LABELS[k],
          meaning_en: STATUS_MEANINGS[k] || '',
        })).sort((a, b) => a.code - b.code),
      };
    },
  },

  signup: {
    descriptor: {
      name: 'signup',
      description:
        'Creates a real ProShip account and shop, ready for Thailand Post EPS (thaipost0) shipping. ' +
        'The response contains your API token, user, and shop_id — SHOWN ONLY ONCE. Save the token ' +
        "into your MCP client's Authorization header. A full thaipost contract additionally requires " +
        'a Thailand Post account arranged with ProShip support (multi-day human process).',
      inputSchema: {
        type: 'object',
        properties: {
          shop_name: { type: 'string', description: 'Name of your shop (prints on labels)' },
          phone: { type: 'string', description: 'Thai mobile number for the shop, e.g. 0812345678' },
          address: ADDRESS_SCHEMA,
          display_name: { type: 'string', description: 'Optional account display name (defaults to shop_name)' },
        },
        required: ['shop_name', 'phone', 'address'],
      },
    },
    async handler(params, _ctx, request) {
      if (!signupAllowed(request?.ip || 'unknown')) {
        return { error: 'rate_limited', detail: 'Max 10 signups per hour per IP.' };
      }
      const shopName = String(params?.shop_name || '').trim();
      const phone = String(params?.phone || '').trim();
      const a = params?.address || {};
      if (!shopName || !phone) return { error: 'bad_input', detail: 'shop_name and phone are required.' };
      try {
        const account = await provisionAccount({ seed: params?.display_name || shopName });
        const shop = await provisionShop(account.token, {
          name: shopName,
          phoneNo: phone,
          address: {
            address: a.address, subDistrict: a.sub_district, district: a.district,
            province: a.province, zipcode: a.zipcode,
          },
        });
        return {
          token: account.token,
          user: decodeJwtUser(account.token),
          shop_id: shop.shop_id,
          save_this: 'Store the token now — it is not retrievable later. Configure it as: Authorization: Bearer <token>',
        };
      } catch (e) {
        if (e?.code === 'EXISTING_PROSHIP_ACCOUNT') {
          return { error: 'existing_account', detail: 'Registration collided with an existing account. Use your existing ProShip token from https://developer.proship.me instead.' };
        }
        return softError(e);
      }
    },
  },
};

// ---------------------------------------------------------------------
// AUTHENTICATED TOOLS — require Authorization: Bearer <ProShip JWT>.
// The token is passed through verbatim; ProShip's own auth scopes every
// call to the account that owns the token.
// ---------------------------------------------------------------------
const AUTHED_TOOLS = {
  list_shops: {
    descriptor: {
      name: 'list_shops',
      description: 'List the shops on YOUR ProShip account. Use the shop_id with create_order.',
      inputSchema: { type: 'object', properties: {} },
    },
    async handler(_params, ctx) {
      try {
        const rows = await listShops({ token: ctx.token });
        if (!Array.isArray(rows)) return { shops: [], raw: rows };
        return {
          shops: rows.map((s) => ({
            shop_id: s?.id,
            name: s?.details?.name,
            phone: s?.details?.phoneNo,
          })),
        };
      } catch (e) { return softError(e); }
    },
  },

  create_order: {
    descriptor: {
      name: 'create_order',
      description:
        'Create a shipment order. Defaults to Thailand Post EPS (thaipost0). Weight is in GRAMS. ' +
        'Returns the order_id — it contains a pipe suffix (order-xxx|123); always pass the FULL id ' +
        'to other tools. Optional cod_amount enables cash-on-delivery.',
      inputSchema: {
        type: 'object',
        properties: {
          shop_id: { type: 'string', description: 'Your shop id (see list_shops)' },
          weight: { type: 'number', description: 'Parcel weight in grams' },
          customer: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              phone: { type: 'string', description: 'Thai mobile, e.g. 0812345678' },
              address: ADDRESS_SCHEMA,
            },
            required: ['name', 'phone', 'address'],
          },
          shipping_method: { type: 'string', enum: ['thaipost0', 'thaipost'], description: 'Default thaipost0 (EPS). thaipost requires a Thailand Post contract on your account.' },
          cod_amount: { type: 'number', description: 'Optional: cash-on-delivery amount (THB)' },
          remarks: { type: 'string' },
          ref_no: { type: 'string', description: 'Optional: your own order reference' },
          products: {
            type: 'array',
            description: 'Optional line items',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, qty: { type: 'number' }, price: { type: 'number' } },
              required: ['name', 'qty'],
            },
          },
          user: { type: 'string', description: 'Optional: ProShip username. Normally decoded from your token automatically.' },
        },
        required: ['shop_id', 'weight', 'customer'],
      },
    },
    async handler(params, ctx) {
      const user = params?.user || ctx.user;
      if (!user) return { error: 'user_required', detail: 'Could not read user from token; pass user explicitly.' };
      try {
        const res = await createOrder(
          { token: ctx.token, user, shop_id: params?.shop_id },
          {
            weight: params?.weight,
            shipping_method: params?.shipping_method,
            customer: toUpstreamCustomer(params?.customer),
            productItems: Array.isArray(params?.products) && params.products.length
              ? params.products.map((p) => ({ name: p.name, qty: p.qty, price: p.price }))
              : undefined,
            codAmount: params?.cod_amount,
            remarks: params?.remarks,
            refNo: params?.ref_no,
          }
        );
        return {
          order_id: res.providerOrderId,
          tracking_no: res.trackingNo,
          status_note: 'Pass the full order_id (with |suffix) to other tools.',
        };
      } catch (e) { return softError(e); }
    },
  },

  list_orders: {
    descriptor: {
      name: 'list_orders',
      description: 'List orders on YOUR account. Optional numeric status filter (see get_order_statuses). Paginated.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'number', description: 'Optional status code filter' },
          per_page: { type: 'number', description: 'Default 50, max 100' },
          page: { type: 'number', description: 'Default 1' },
        },
      },
    },
    async handler(params, ctx) {
      try {
        const res = await listOrders({ token: ctx.token }, {
          status: params?.status, perPage: params?.per_page || 50, page: params?.page || 1,
        });
        return { orders: res };
      } catch (e) { return softError(e); }
    },
  },

  get_order: {
    descriptor: {
      name: 'get_order',
      description: 'Get one order by id (full pipe-suffixed id is fine). Returns status with Thai label and tracking number.',
      inputSchema: {
        type: 'object',
        properties: { order_id: { type: 'string' } },
        required: ['order_id'],
      },
    },
    async handler(params, ctx) {
      try {
        const res = await getOrder({ token: ctx.token }, String(params?.order_id || ''));
        return { status: res.status, status_label: res.statusLabel, tracking_no: res.trackingNo, raw: res.raw };
      } catch (e) { return softError(e); }
    },
  },

  update_order_status: {
    descriptor: {
      name: 'update_order_status',
      description: 'Set an order status by numeric code (see get_order_statuses).',
      inputSchema: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          status: { type: 'number', description: 'Status code, e.g. 5 = cancelled by seller' },
        },
        required: ['order_id', 'status'],
      },
    },
    async handler(params, ctx) {
      try {
        await updateOrderStatus({ token: ctx.token }, String(params?.order_id || ''), params?.status);
        return { ok: true, order_id: params?.order_id, status: params?.status, status_label: statusLabel(params?.status) };
      } catch (e) { return softError(e); }
    },
  },

  cancel_order: {
    descriptor: {
      name: 'cancel_order',
      description: 'Delete/cancel an order by id.',
      inputSchema: {
        type: 'object',
        properties: { order_id: { type: 'string' } },
        required: ['order_id'],
      },
    },
    async handler(params, ctx) {
      try {
        await cancelOrder({ token: ctx.token }, String(params?.order_id || ''));
        return { ok: true, order_id: params?.order_id };
      } catch (e) { return softError(e); }
    },
  },

  check_duplicate: {
    descriptor: {
      name: 'check_duplicate',
      description: 'Check whether a customer phone number already has a recent order (duplicate-shipment guard).',
      inputSchema: {
        type: 'object',
        properties: { phone: { type: 'string', description: 'Customer phone number' } },
        required: ['phone'],
      },
    },
    async handler(params, ctx) {
      try {
        const res = await checkDuplicate({ token: ctx.token }, { phoneNo: params?.phone });
        return { result: res };
      } catch (e) { return softError(e); }
    },
  },

  print_label: {
    descriptor: {
      name: 'print_label',
      description:
        'Generate the shipping label PDF for one or more orders. REQUIRES the FULL pipe-suffixed ' +
        'order ids (order-xxx|123) — stripped ids are rejected upstream. Returns a temporary URL ' +
        '(valid ~10 minutes) where the PDF can be downloaded.',
      inputSchema: {
        type: 'object',
        properties: {
          order_ids: { type: 'array', items: { type: 'string' }, description: 'FULL pipe-suffixed order ids' },
          size: { type: 'string', description: 'Label size, default "normal"' },
          printer: { type: 'string', enum: ['proship', 'proship_v3p', 'paperang'], description: 'Label format, default "proship"' },
        },
        required: ['order_ids'],
      },
    },
    async handler(params, ctx, request) {
      try {
        const buf = await printLabel({ token: ctx.token }, params?.order_ids || [], {
          size: params?.size || 'normal', printer: params?.printer || 'proship',
        });
        const token = putLabel(buf);
        return { label_url: `${publicBase(request)}/mcp/label/${token}`, expires_in_minutes: 10 };
      } catch (e) { return softError(e); }
    },
  },
};

// Combined registry for tools/list + tools/call.
const ALL_TOOLS = { ...PUBLIC_TOOLS, ...AUTHED_TOOLS };

// JSON-RPC 2.0 envelope helpers.
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message, data) {
  const e = { jsonrpc: '2.0', id, error: { code, message } };
  if (data !== undefined) e.error.data = data;
  return e;
}

async function handleMessage(msg, ctx, request) {
  const id = msg?.id;
  const isNotification = id === undefined || id === null;

  if (msg?.jsonrpc !== '2.0' || typeof msg?.method !== 'string') {
    return isNotification ? null : rpcError(id ?? null, -32600, 'Invalid Request');
  }

  const method = msg.method;
  const params = msg.params || {};

  switch (method) {
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
    case 'notifications/initialized':
      return null;
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      // Always expose the full tool list — clients with auth can call the
      // authed tools, clients without auth get an "auth required" error
      // when they try. Hiding tools based on auth state confuses LLMs.
      return rpcResult(id, { tools: Object.values(ALL_TOOLS).map((t) => t.descriptor) });
    case 'tools/call': {
      const name = params.name;
      const tool = ALL_TOOLS[name];
      if (!tool) return rpcError(id, -32601, `Unknown tool: ${name}`);
      if (name in AUTHED_TOOLS && !ctx.token) {
        return rpcError(id, -32001, 'Authentication required',
          { detail: 'Pass Authorization: Bearer <ProShip API token>. No account? Call the signup tool, or see https://developer.proship.me.' });
      }
      let result;
      try {
        result = await tool.handler(params.arguments || {}, ctx, request);
      } catch (e) {
        console.error('[mcp]', name, e?.message, e?.stack);
        return rpcError(id, -32000, 'Tool execution failed', { detail: String(e?.message || e) });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !!result?.error,
      });
    }
    default:
      return isNotification ? null : rpcError(id, -32601, `Unknown method: ${method}`);
  }
}

// Human-readable docs page, generated from the same tool registry the
// JSON-RPC handler uses — no separate doc source to drift.
function docsHtml(base) {
  const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const renderSchema = (s) => {
    const props = s?.properties || {};
    const req = new Set(s?.required || []);
    const keys = Object.keys(props);
    if (keys.length === 0) return '<p class="schema-empty">No parameters.</p>';
    return `<table class="schema"><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${
      keys.map((k) => {
        const p = props[k];
        const type = Array.isArray(p.type) ? p.type.join(' | ') : (p.type || '');
        return `<tr><td><code>${k}</code></td><td><code>${type}</code></td><td>${req.has(k) ? '✓' : ''}</td><td>${escapeHtml(p.description || '')}</td></tr>`;
      }).join('')
    }</tbody></table>`;
  };
  const renderTool = (t) => `
    <article class="tool">
      <h4><code>${t.descriptor.name}</code></h4>
      <p>${escapeHtml(t.descriptor.description)}</p>
      ${renderSchema(t.descriptor.inputSchema)}
    </article>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ProShip MCP — Thailand Post for AI agents</title>
  <meta name="description" content="Model Context Protocol server for ProShip. Lets any MCP-compatible AI agent create Thailand Post shipments, print labels, and track parcels.">
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: #FFF8F8; color: #0F172A; margin: 0; line-height: 1.6; }
    header { background: linear-gradient(135deg, #D32F2F, #EF5350); color: #fff; padding: 56px 24px 48px; text-align: center; }
    header h1 { font-size: 2.4rem; font-weight: 800; margin: 0 0 8px; letter-spacing: -0.02em; }
    header p { font-size: 1.05rem; opacity: 0.94; max-width: 640px; margin: 0 auto; }
    header .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 9999px; background: rgba(255,255,255,0.22); font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 16px; }
    main { max-width: 880px; margin: 0 auto; padding: 36px 24px 64px; }
    section { margin-bottom: 40px; }
    h2 { font-size: 1.5rem; margin: 0 0 12px; border-bottom: 1px solid #FECACA; padding-bottom: 8px; }
    h3 { font-size: 1.1rem; margin: 28px 0 12px; color: #991B1B; }
    h4 { font-size: 0.92rem; margin: 0 0 6px; font-family: ui-monospace, monospace; }
    p { margin: 0 0 12px; }
    code { font-family: ui-monospace, monospace; background: #FEE2E2; color: #991B1B; padding: 1px 6px; border-radius: 4px; font-size: 0.88em; }
    pre { background: #0F172A; color: #E2E8F0; padding: 16px 20px; border-radius: 10px; overflow-x: auto; font-family: ui-monospace, monospace; font-size: 0.85rem; line-height: 1.55; }
    pre code { background: transparent; color: inherit; padding: 0; font-size: inherit; }
    .callout { background: #FEF2F2; border-left: 4px solid #EF4444; padding: 12px 16px; border-radius: 8px; margin: 16px 0; color: #7F1D1D; }
    .tools-grid { display: grid; gap: 16px; }
    .tool { background: #fff; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(15,23,42,.04); }
    .tool h4 { color: #B91C1C; }
    .tool p { color: #475569; font-size: 0.93rem; margin-bottom: 10px; }
    table.schema { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 8px; }
    table.schema th, table.schema td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #F1F5F9; vertical-align: top; }
    table.schema th { background: #F8FAFC; font-weight: 600; color: #475569; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .schema-empty { color: #94A3B8; font-size: 0.85rem; margin: 0; }
    footer { text-align: center; padding: 24px; color: #94A3B8; font-size: 0.85rem; }
    footer a { color: #DC2626; }
    .protocol-table { width: 100%; border-collapse: collapse; }
    .protocol-table td { padding: 6px 0; vertical-align: top; }
    .protocol-table td:first-child { font-family: ui-monospace, monospace; font-size: 0.85rem; color: #475569; width: 200px; padding-right: 12px; }
  </style>
</head>
<body>
  <header>
    <div class="badge">🤖 Model Context Protocol</div>
    <h1>ProShip MCP</h1>
    <p>Connect any AI agent — Claude, Cursor, custom harnesses — to Thailand Post shipping through ProShip: create orders, print labels, track parcels.</p>
  </header>

  <main>
    <section id="what">
      <h2>What this is</h2>
      <p><strong>ProShip</strong> is a Thai order-management platform (ระบบจัดการออเดอร์และขนส่ง) connected to Thailand Post. This endpoint is a public MCP server exposing ProShip to any AI agent that speaks the <a href="https://modelcontextprotocol.io">Model Context Protocol</a>.</p>
      <ul>
        <li><strong>Public tools</strong> — track parcels, read the status reference, or sign up for a new account. No auth.</li>
        <li><strong>Authenticated tools</strong> — create shipment orders, print Thailand Post labels, manage your orders. Requires <code>Authorization: Bearer &lt;ProShip API token&gt;</code>.</li>
      </ul>
      <div class="callout">
        <strong>Stateless by design:</strong> this server stores no accounts, tokens, or orders. Your token passes through to <code>api.proship.me</code> on every call and is never persisted here.
      </div>
    </section>

    <section id="quickstart-th" lang="th">
      <h2>เริ่มต้นใช้งานด่วน 🇹🇭</h2>
      <p>เชื่อม AI agent (เช่น Claude) เข้ากับไปรษณีย์ไทยผ่าน ProShip ใน 3 ขั้นตอน — ไม่ต้องเขียนโค้ด</p>

      <h3>ขั้นที่ 1 — ขอ token</h3>
      <p><strong>มีบัญชี ProShip อยู่แล้ว:</strong> ใช้ API token ของคุณจาก <a href="https://developer.proship.me">developer.proship.me</a></p>
      <p><strong>ยังไม่มีบัญชี:</strong> บอก AI ของคุณว่า <em>"สมัคร ProShip ให้หน่อย ร้านชื่อ … เบอร์ … ที่อยู่ …"</em> — AI จะเรียกเครื่องมือ <code>signup</code> และได้ token กลับมา <strong>token แสดงครั้งเดียวเท่านั้น ให้บันทึกทันที</strong> และเก็บเป็นความลับเหมือนรหัสผ่าน</p>

      <h3>ขั้นที่ 2 — เชื่อมกับ Claude</h3>
      <p>ใน Claude (Desktop หรือ claude.ai → Settings → Connectors) เพิ่ม custom connector ชี้ไปที่ <code>${base}/mcp</code> พร้อม header:</p>
      <pre><code>Authorization: Bearer &lt;token ของคุณ&gt;</code></pre>
      <p>หรือใช้ mcp-remote ตามตัวอย่าง config ในหัวข้อ "Connect a client" ด้านล่าง</p>

      <h3>ขั้นที่ 3 — สั่งงานเป็นภาษาไทยได้เลย</h3>
      <pre><code>สร้างออเดอร์ส่งพัสดุ 500 กรัม
ผู้รับ: สมชาย ใจดี 081-234-5678
ที่อยู่: 99 ถ.พระราม 4 แขวงคลองเตย เขตคลองเตย กรุงเทพฯ 10110
เก็บเงินปลายทาง 350 บาท แล้วปริ้นใบปะหน้าให้ด้วย</code></pre>
      <p>AI จะสร้างออเดอร์ ได้เลขพัสดุไปรษณีย์ไทย และส่งลิงก์ใบปะหน้า PDF กลับมาให้พิมพ์</p>

      <div class="callout">
        <strong>หมายเหตุ:</strong> บัญชีที่สมัครผ่าน AI ใช้ไปรษณีย์ไทย EPS (<code>thaipost0</code>) ได้ทันที ส่วนแบบสัญญา (<code>thaipost</code>) ต้องติดต่อทีมงาน ProShip เพื่อผูกบัญชีไปรษณีย์ไทยของคุณก่อน — ติดต่อ <a href="mailto:care@proship.co.th">care@proship.co.th</a>
      </div>
    </section>

    <section id="connect">
      <h2>Connect a client</h2>
      <h3>Claude / MCP clients with HTTP transport</h3>
      <p>Point the client at <code>${base}/mcp</code>. For authenticated tools, add the header <code>Authorization: Bearer &lt;token&gt;</code>.</p>
      <h3>Via mcp-remote bridge</h3>
      <pre><code>{
  "mcpServers": {
    "proship": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "${base}/mcp",
        "--header",
        "Authorization:Bearer &lt;your-proship-token&gt;"
      ]
    }
  }
}</code></pre>
      <h3>Raw HTTP</h3>
      <pre><code>curl -X POST ${base}/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</code></pre>
    </section>

    <section id="token">
      <h2>Getting a token</h2>
      <ol>
        <li><strong>New to ProShip?</strong> Call the <code>signup</code> tool — it creates an account and shop ready for Thailand Post EPS and returns your token once. Save it immediately.</li>
        <li><strong>Existing ProShip merchant?</strong> Use your API token from <a href="https://developer.proship.me">developer.proship.me</a>.</li>
      </ol>
      <div class="callout">
        <strong>Scope:</strong> the token authorises an agent to do anything your ProShip account can do. Treat it like a password. A full <code>thaipost</code> (contract) carrier additionally requires Thailand Post onboarding via ProShip support.
      </div>
    </section>

    <section id="public-tools">
      <h2>Public tools <span style="color:#94A3B8; font-size:0.7em; font-weight:400;">no auth required</span></h2>
      <div class="tools-grid">
        ${Object.values(PUBLIC_TOOLS).map(renderTool).join('')}
      </div>
    </section>

    <section id="authed-tools">
      <h2>Authenticated tools <span style="color:#94A3B8; font-size:0.7em; font-weight:400;">Bearer auth required</span></h2>
      <p>Every call operates only on the ProShip account that owns the token.</p>
      <div class="tools-grid">
        ${Object.values(AUTHED_TOOLS).map(renderTool).join('')}
      </div>
    </section>

    <section id="protocol">
      <h2>Protocol details</h2>
      <table class="protocol-table">
        <tr><td>Endpoint</td><td><code>POST ${base}/mcp</code></td></tr>
        <tr><td>Transport</td><td>Streamable HTTP (JSON-RPC 2.0 messages, application/json responses)</td></tr>
        <tr><td>Protocol versions</td><td><code>${SUPPORTED_VERSIONS.join('</code>, <code>')}</code></td></tr>
        <tr><td>Server</td><td><code>${SERVER_INFO.name}</code> v${SERVER_INFO.version}</td></tr>
        <tr><td>Auth header</td><td><code>Authorization: Bearer &lt;ProShip API token&gt;</code></td></tr>
        <tr><td>Methods</td><td><code>initialize</code>, <code>tools/list</code>, <code>tools/call</code>, <code>notifications/initialized</code>, <code>ping</code></td></tr>
      </table>
    </section>
  </main>

  <footer>
    <p>ProShip — <a href="https://proship.co.th">proship.co.th</a> · <a href="https://developer.proship.me">API docs</a></p>
  </footer>
</body>
</html>`;
}

export default async function mcpRoutes(app) {
  app.get('/', async (request, reply) => {
    // Content negotiation: browsers get docs, MCP clients get the manifest.
    const accept = String(request.headers?.accept || '').toLowerCase();
    if (accept.includes('text/html')) {
      return reply.header('Content-Type', 'text/html; charset=utf-8').send(docsHtml(publicBase(request)));
    }
    return reply.header('Content-Type', 'application/json; charset=utf-8').send({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      protocol: SUPPORTED_VERSIONS,
      description: 'MCP server for ProShip — Thailand Post shipping for AI agents. Open in a browser for docs.',
      docs: `${publicBase(request)}/mcp`,
      usage: {
        transport: 'Streamable HTTP (POST JSON-RPC messages to this URL)',
        auth: 'Authorization: Bearer <ProShip API token> for authenticated tools',
      },
      tools: {
        public: Object.keys(PUBLIC_TOOLS),
        authenticated: Object.keys(AUTHED_TOOLS),
      },
    });
  });

  app.get('/label/:token', async (request, reply) => {
    const buf = takeLabel(request.params?.token);
    if (!buf) return reply.code(404).send({ error: 'expired_or_unknown' });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', 'inline; filename="label.pdf"')
      .send(buf);
  });

  app.post('/', async (request, reply) => {
    const h = String(request.headers?.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
    const ctx = { token, user: token ? decodeJwtUser(token) : null };

    const body = request.body;
    const isNotification = (m) => m && typeof m === 'object' && !Array.isArray(m)
      && (m.id === undefined || m.id === null) && typeof m.method === 'string';

    if (isNotification(body)) {
      await handleMessage(body, ctx, request); // all notifications are no-ops
      return reply.code(202).send();
    }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handleMessage(m, ctx, request)))).filter((x) => x !== null);
      if (out.length === 0) return reply.code(202).send();
      return reply.header('Content-Type', 'application/json; charset=utf-8').send(out);
    }
    const out = await handleMessage(body || {}, ctx, request);
    return reply.header('Content-Type', 'application/json; charset=utf-8').send(out);
  });
}
