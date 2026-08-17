import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../server.js';
import { rpc, stubFetch, realFetch } from './helpers.js';

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
      customer: { name: 'สมชาย', phone: '0812345678',
        address: { address: '1 ถ.สุขุมวิท', province: 'กรุงเทพมหานคร', district: 'คลองเตย', sub_district: 'คลองเตย', zipcode: '10110' } },
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

test('create_order without decodable user returns soft error', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubFetch([{ status: 200, body: {} }]);
  const app = await buildServer();
  const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'create_order', arguments: {
      shop_id: 'shop-1', weight: 500,
      customer: { name: 'x', phone: '0812345678',
        address: { address: 'a', province: 'p', district: 'd', sub_district: 's', zipcode: '10110' } },
    } } }, { authorization: 'Bearer opaque-token' });
  const out = res.json().result;
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /user_required/);
  await app.close();
});

test('upstream 401 surfaces as soft unauthorized error, not a crash', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubFetch([{ status: 401, body: { message: 'Unauthorized' } }]);
  const app = await buildServer();
  const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'get_order', arguments: { order_id: 'order-1|999' } } },
    { authorization: 'Bearer bad' });
  const out = res.json().result;
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /unauthorized/);
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

test('track_parcel without token or env falls back to config error', async (t) => {
  const saved = process.env.PROSHIP_UTRACK_TOKEN;
  delete process.env.PROSHIP_UTRACK_TOKEN;
  t.after(() => { if (saved) process.env.PROSHIP_UTRACK_TOKEN = saved; });
  const app = await buildServer();
  const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'track_parcel', arguments: { tracking_no: 'TH123' } } });
  const out = res.json().result;
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /auth_or_config_required/);
  await app.close();
});
