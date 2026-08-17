// ProShip API client — ported from shopout/lib/shipping/proship.js.
//
// All low-level HTTP calls live here. Pipe-id quirks (strip pipe for
// GET/PUT/DELETE, keep pipe for print) are hidden inside this file —
// callers always pass the provider-order-id returned from createOrder.
//
// Behaviour:
//   - 30s timeout via AbortController
//   - Single retry on 5xx with 1s backoff
//   - Network errors / timeouts → ShippingError {code: 'NETWORK'}
//   - Non-2xx responses → ShippingError {code: 'HTTP_<status>', status, body}
//
// Unlike the shopout adapter, credentials are pass-through: only `token`
// is universally required; createOrder additionally needs `user` +
// `shop_id`. Nothing is persisted here.

import crypto from 'crypto';
import { ShippingError } from './errors.js';

const PUBLIC_BASE = process.env.PROSHIP_API_BASE || 'https://api.proship.me';
const SHOPS_BASE  = 'https://x1pukio3fj.execute-api.ap-southeast-1.amazonaws.com/dev/v1';
const UTRACK_BASE = 'https://584i7lz3vc.execute-api.ap-southeast-1.amazonaws.com/dev/v1';
const TIMEOUT_MS  = 30_000;
const RETRY_DELAY_MS = 1000;

const SYNTH_EMAIL_DOMAIN = process.env.PROSHIP_SYNTH_EMAIL_DOMAIN || 'proship.me';

// Status code → Thai label. Mapping confirmed 2026-05-09.
// Note status 6: ProShip's English table labels it "ERROR" but the actual
// semantic is "out for delivery" — we use the latter.
export const STATUS_LABELS = {
  '-2': 'ระงับการใช้งาน',
  '-1': 'ฉบับร่าง',
  '0':  'รอดำเนินการ',
  '1':  'รอรับพัสดุ',
  '2':  'จัดส่งแล้ว',
  '3':  'ขนส่งรับพัสดุแล้ว',
  '4':  'จัดส่งสำเร็จ',
  '5':  'ยกเลิกโดยผู้ขาย',
  '6':  'กำลังนำส่ง',
  '8':  'ตีกลับผู้ส่ง',
  '34': 'ลูกค้าไม่รับโทรศัพท์',
  '41': 'มีปัญหาการจัดส่ง'
};

export function statusLabel(code) {
  if (code === null || code === undefined) return 'Not shipped';
  return STATUS_LABELS[String(code)] || `Status ${code}`;
}

// ---- HTTP plumbing -----------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function call(method, url, { token, body } = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json'
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const init = {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  };

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);

      if (res.status >= 500 && attempt === 0) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      const text = await res.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

      if (!res.ok) {
        const msg = (parsed && (parsed.message || parsed.error)) || `HTTP ${res.status}`;
        throw new ShippingError(msg, { code: `HTTP_${res.status}`, status: res.status, body: parsed });
      }
      return parsed;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof ShippingError) throw e;
      lastErr = e;
      if (e.name === 'AbortError' || /fetch failed|ENOTFOUND|ECONN|EAI_AGAIN/i.test(String(e?.message))) {
        if (attempt === 0) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new ShippingError(`Network error contacting ProShip: ${e.message}`, { code: 'NETWORK' });
      }
      throw new ShippingError(`Unexpected error: ${e.message}`, { code: 'UNKNOWN' });
    }
  }
  throw new ShippingError(`Network error contacting ProShip: ${lastErr?.message || 'unknown'}`, { code: 'NETWORK' });
}

// HTTP wrapper for endpoints that don't require Bearer auth (register).
async function callPublic(method, url, body) {
  const init = {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(timer);
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      const msg = (parsed && (parsed.message || (Array.isArray(parsed) && parsed[0]) || parsed.error)) || `HTTP ${res.status}`;
      throw new ShippingError(msg, { code: `HTTP_${res.status}`, status: res.status, body: parsed });
    }
    return parsed;
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof ShippingError) throw e;
    throw new ShippingError(`Network error: ${e.message}`, { code: 'NETWORK' });
  }
}

/**
 * Strip the "|<timestamp>" suffix from a ProShip order id.
 * Per API docs: use only the part before the pipe for GET/PUT/DELETE.
 */
export function stripPipe(id) {
  if (!id) return id;
  const idx = String(id).indexOf('|');
  return idx >= 0 ? String(id).slice(0, idx) : String(id);
}

/**
 * Extract the `user` field from a ProShip JWT without verifying it —
 * pass-through auth means upstream does the verifying; we only need the
 * username the API expects alongside the token on order creation.
 */
export function decodeJwtUser(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload?.user || payload?.username || null;
  } catch { return null; }
}

// ---- Orders ------------------------------------------------------------

/**
 * POST /orders/v1/orders
 *
 * @param {object} creds  {token, user, shop_id}
 * @param {object} payload {weight, shipping_method?, customer, productItems?, codAmount?, remarks?, refNo?}
 * @returns {Promise<{providerOrderId: string, trackingNo: string, raw: object}>}
 */
export async function createOrder(creds, payload) {
  if (!creds?.token) throw new ShippingError('Missing token', { code: 'MISSING_CREDS' });
  if (!creds.user) throw new ShippingError('Missing user', { code: 'MISSING_CREDS' });
  if (!creds.shop_id) throw new ShippingError('Missing shop_id', { code: 'MISSING_CREDS' });
  const { weight, shipping_method, customer, productItems, codAmount, remarks, refNo } = payload || {};
  if (!weight) throw new ShippingError('weight (g) is required', { code: 'BAD_INPUT' });
  if (!customer || !customer.name || !customer.address || !customer.phoneNo) {
    throw new ShippingError('customer.{name,address,phoneNo} are required', { code: 'BAD_INPUT' });
  }

  const body = {
    user: creds.user,
    shopId: creds.shop_id,
    shippingMethod: shipping_method || 'thaipost0',
    weight: parseInt(weight),
    customer: {
      name: customer.name,
      phoneNo: customer.phoneNo,
      salesChannel: customer.salesChannel || 'web',
      address: customer.address // {address, province, district, subDistrict, zipcode}
    }
  };
  if (productItems && productItems.length) body.productItems = productItems;
  if (codAmount !== undefined && codAmount !== null && codAmount !== '') body.codAmount = parseFloat(codAmount);
  if (remarks) body.remarks = remarks;
  if (refNo) body.refNo = refNo;

  const res = await call('POST', `${PUBLIC_BASE}/orders/v1/orders`, { token: creds.token, body });
  // IMPORTANT: return the FULL pipe-suffixed ID. printLabel needs the full
  // id; GET/PUT/DELETE strip the pipe internally.
  return {
    providerOrderId: res?.id || null,
    trackingNo: res?.trackingNo || null,
    raw: res
  };
}

/** GET /orders/v1/orders/:id */
export async function getOrder(creds, providerOrderId) {
  if (!creds?.token) throw new ShippingError('Missing token', { code: 'MISSING_CREDS' });
  const id = stripPipe(providerOrderId);
  const res = await call('GET', `${PUBLIC_BASE}/orders/v1/orders/${encodeURIComponent(id)}`, { token: creds.token });
  const status = res?.status ?? res?.details?.status ?? null;
  return {
    status,
    statusLabel: statusLabel(status),
    trackingNo: res?.trackingNo ?? res?.details?.trackingNo ?? null,
    raw: res
  };
}

/** GET /orders/v1/orders-v2 */
export async function listOrders(creds, { status, perPage = 50, page = 1 } = {}) {
  if (!creds?.token) throw new ShippingError('Missing token', { code: 'MISSING_CREDS' });
  const qs = new URLSearchParams();
  if (status !== undefined && status !== null && status !== '') qs.set('status', String(status));
  qs.set('perPage', String(Math.min(100, Math.max(1, perPage))));
  qs.set('page', String(Math.max(1, page)));
  qs.set('onlyError', 'false');
  return call('GET', `${PUBLIC_BASE}/orders/v1/orders-v2?${qs}`, { token: creds.token });
}

/** PUT /orders/v1/orders/:id/status */
export async function updateOrderStatus(creds, providerOrderId, statusCode) {
  if (!creds?.token) throw new ShippingError('Missing token', { code: 'MISSING_CREDS' });
  const id = stripPipe(providerOrderId);
  await call('PUT', `${PUBLIC_BASE}/orders/v1/orders/${encodeURIComponent(id)}/status`,
    { token: creds.token, body: { status: statusCode } });
  return { ok: true };
}

/** DELETE /orders/v1/orders/:id */
export async function cancelOrder(creds, providerOrderId) {
  if (!creds?.token) throw new ShippingError('Missing token', { code: 'MISSING_CREDS' });
  const id = stripPipe(providerOrderId);
  await call('DELETE', `${PUBLIC_BASE}/orders/v1/orders/${encodeURIComponent(id)}`, { token: creds.token });
  return { ok: true };
}

/** POST /orders/v1/orders/check-duplicate */
export async function checkDuplicate(creds, { phoneNo }) {
  if (!creds?.token) throw new ShippingError('Missing token', { code: 'MISSING_CREDS' });
  if (!phoneNo) throw new ShippingError('phoneNo is required', { code: 'BAD_INPUT' });
  return call('POST', `${PUBLIC_BASE}/orders/v1/orders/check-duplicate`,
    { token: creds.token, body: { phoneNo: String(phoneNo).replace(/\D/g, '') } });
}

/**
 * POST /print/v1/print-label
 *
 * NOTE: ProShip's print endpoint requires the FULL pipe-suffixed order id.
 * Stripped ids return 400 "Orders not eligible for printing labels".
 *
 * @param {string[]|string} providerOrderIds — full ids (with pipe suffix)
 * @returns {Promise<Buffer>} PDF bytes
 */
export async function printLabel(creds, providerOrderIds, { size = 'normal', printer = 'proship' } = {}) {
  if (!creds?.token) throw new ShippingError('Missing token', { code: 'MISSING_CREDS' });
  const ids = (Array.isArray(providerOrderIds) ? providerOrderIds : [providerOrderIds])
    .filter(Boolean)
    .map(String);
  if (ids.length === 0) throw new ShippingError('At least one order id required', { code: 'BAD_INPUT' });
  if (ids.some(id => !id.includes('|'))) {
    throw new ShippingError(
      'printLabel requires the FULL pipe-suffixed order id (e.g. "order-xxx|123"). Stripped ids return "not eligible".',
      { code: 'BAD_INPUT' }
    );
  }

  const res = await call('POST', `${PUBLIC_BASE}/print/v1/print-label`,
    { token: creds.token, body: { orders: ids, size, printer, base64: true } });

  const b64 = res?.base64 || res?.data || res;
  if (!b64 || typeof b64 !== 'string') {
    throw new ShippingError('Print label response missing base64 PDF', {
      code: 'BAD_RESPONSE', body: res
    });
  }
  return Buffer.from(b64, 'base64');
}

// ---- Shops -------------------------------------------------------------

/** GET <shops gateway>/shops?responseSize=all */
export async function listShops(creds) {
  if (!creds?.token) throw new ShippingError('Missing token', { code: 'MISSING_CREDS' });
  return call('GET', `${SHOPS_BASE}/shops?responseSize=all`, { token: creds.token });
}

// ---- Universal tracking (public-facing) -------------------------------

/**
 * GET <utrack gateway>/utrack?barcode=<trackingNo>
 * Accepts a Bearer token from any seller account; returns a normalized
 * tracking timeline regardless of the underlying carrier.
 */
export async function getUniversalTracking(creds, trackingNo) {
  if (!creds?.token) throw new ShippingError('Missing token', { code: 'MISSING_CREDS' });
  if (!trackingNo) throw new ShippingError('trackingNo is required', { code: 'BAD_INPUT' });
  const url = `${UTRACK_BASE}/utrack?barcode=${encodeURIComponent(trackingNo)}`;
  const res = await call('GET', url, { token: creds.token });

  const eventsRaw = Array.isArray(res?.trackings) ? res.trackings
                  : Array.isArray(res?.events)    ? res.events
                  : Array.isArray(res?.history)   ? res.history
                  : [];
  const history = eventsRaw.map(ev => ({
    ts:       ev.ts || ev.timestamp || ev.createdAt || ev.date || ev.eventDate || '',
    status:   ev.statusLabel || ev.status || ev.description || ev.event || '',
    location: ev.location || ev.place || ev.station || undefined
  })).filter(h => h.ts || h.status);

  const status = res?.status ?? null;
  const carrier = res?.sm || res?.carrier || res?.shippingMethod || null;

  return {
    status,
    statusLabel: statusLabel(status),
    carrier,
    history,
    raw: res
  };
}

// ---- Onboarding (auto-provision a ProShip account + shop) --------------

function synthesizeMobile() {
  const prefix = ['06', '08', '09'][crypto.randomInt(0, 3)];
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += String(crypto.randomInt(0, 10));
  return prefix + suffix;
}

function synthesizeEmail() {
  const rand = crypto.randomBytes(4).toString('hex');
  return `proship-mcp-${rand}@${SYNTH_EMAIL_DOMAIN}`;
}

function synthesizePassword() {
  // ProShip requires ≥1 uppercase, ≥1 lowercase, ≥1 digit, ≥1 special.
  return `Pr0ship!${crypto.randomBytes(8).toString('hex')}A1`;
}

/**
 * Register a fresh ProShip account. Synthesizes email/phone/password.
 * Retries on uniqueness collision; after 5 failures throws
 * ShippingError{code:'EXISTING_PROSHIP_ACCOUNT'} so the caller can point
 * the user at their existing token instead.
 *
 * @returns {Promise<{token, user_id}>}
 */
export async function provisionAccount({ seed } = {}) {
  const username = String(seed || 'ProShip MCP User').slice(0, 100);

  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const email = synthesizeEmail();
    const phone = synthesizeMobile();
    const password = synthesizePassword();
    try {
      const res = await callPublic('POST', `${PUBLIC_BASE}/auth/v1/auth/register`, {
        username, phoneNo: phone, email, password, passwordConfirmation: password
      });
      if (!res?.token || !res?.user_id) {
        throw new ShippingError('Register response missing token/user_id', {
          code: 'BAD_RESPONSE', body: res
        });
      }
      return { token: res.token, user_id: res.user_id };
    } catch (e) {
      lastErr = e;
      const msg = String(e?.body?.message || e?.message || '').toLowerCase();
      if (e?.status === 400 && /unique/.test(msg)) {
        continue; // phone/email collision — retry with fresh randoms
      }
      throw e;
    }
  }
  throw new ShippingError(
    'ProShip rejected all registration attempts as not-unique.',
    { code: 'EXISTING_PROSHIP_ACCOUNT', body: lastErr?.body || null }
  );
}

/**
 * Create a shop for a freshly-registered account and return its shop_id.
 * POST /shops returns only {message:"Success"} — so list-and-match by
 * name + newest createdAt afterwards.
 *
 * @param {string} token  — JWT from provisionAccount()
 * @param {object} shop   — {name, phoneNo, address:{address,subDistrict,district,province,zipcode}}
 * @returns {Promise<{shop_id:string, raw:object}>}
 */
export async function provisionShop(token, shop) {
  if (!token) throw new ShippingError('token is required', { code: 'BAD_INPUT' });
  if (!shop || !shop.name || !shop.phoneNo || !shop.address) {
    throw new ShippingError('shop.{name,phoneNo,address} are required', { code: 'BAD_INPUT' });
  }
  const a = shop.address;
  for (const f of ['address', 'subDistrict', 'district', 'province', 'zipcode']) {
    if (!a[f]) throw new ShippingError(`shop.address.${f} is required`, { code: 'BAD_INPUT' });
  }

  const body = {
    name: String(shop.name).slice(0, 200),
    phoneNo: String(shop.phoneNo || '').replace(/\D/g, ''),
    address: {
      address: String(a.address).slice(0, 500),
      subDistrict: String(a.subDistrict),
      district: String(a.district),
      province: String(a.province),
      zipcode: parseInt(a.zipcode),
      phone: '',
      nameAddress: '',
      state: 2
    },
    shippingMethods: ['thaipost0'],
    defaultWeight: null,
    paymentMethods: [],
    onechat: { enabled: false, statusList: [] }
  };

  await call('POST', `${SHOPS_BASE}/shops`, { token, body });

  const list = await call('GET', `${SHOPS_BASE}/shops?responseSize=all`, { token });
  if (!Array.isArray(list)) {
    throw new ShippingError('Shops list response was not an array', { code: 'BAD_RESPONSE', body: list });
  }
  const matches = list.filter(s => s?.details?.name === body.name);
  if (matches.length === 0) {
    throw new ShippingError('Shop creation reported success but shop not found in list', {
      code: 'BAD_RESPONSE', body: list
    });
  }
  matches.sort((x, y) => (y?.createdAt || 0) - (x?.createdAt || 0));
  const shopRow = matches[0];
  if (!shopRow?.id) {
    throw new ShippingError('Shop row missing id field', { code: 'BAD_RESPONSE', body: shopRow });
  }
  return { shop_id: shopRow.id, raw: shopRow };
}
