import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripPipe, statusLabel, decodeJwtUser, createOrder, printLabel, getOrder } from '../lib/proship.js';
import { ShippingError } from '../lib/errors.js';
import { putLabel, takeLabel } from '../lib/labelcache.js';
import { stubFetch, realFetch } from './helpers.js';

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

test('label cache stores and returns buffers by token', () => {
  const tok = putLabel(Buffer.from('%PDF-fake'));
  assert.match(tok, /^[0-9a-f]{32}$/);
  assert.equal(takeLabel(tok).toString(), '%PDF-fake');
  assert.equal(takeLabel('0'.repeat(32)), null);
});
