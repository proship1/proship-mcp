import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../server.js';
import { rpc } from './helpers.js';

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

test('HTML docs render every tool from the registry', async () => {
  const app = await buildServer();
  const res = await app.inject({ method: 'GET', url: '/mcp', headers: { accept: 'text/html' } });
  for (const name of ['track_parcel', 'signup', 'create_order', 'print_label']) {
    assert.match(res.body, new RegExp(`<code>${name}</code>`));
  }
  await app.close();
});

test('spoofed Host header is not reflected into docs or manifest', async () => {
  const app = await buildServer();
  const evil = 'evil.example"><script>alert(1)</script>';
  const h = await app.inject({ method: 'GET', url: '/mcp',
    headers: { accept: 'text/html', host: evil } });
  assert.ok(!h.body.includes('evil.example'), 'evil host must not appear in HTML');
  const j = await app.inject({ method: 'GET', url: '/mcp', headers: { host: 'evil.example' } });
  assert.match(j.json().docs, /^https:\/\/mcp\.proship\.me/);
  await app.close();
});
