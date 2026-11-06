'use strict';
// Uses the built-in Node.js test runner and fetch: no extra test dependencies.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

let server;
let base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('GET /api/hello greets by name', async () => {
  const res = await fetch(`${base}/api/hello?name=CastorX`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { message: 'Hello, CastorX!' });
});

test('items lifecycle', async () => {
  let res = await fetch(`${base}/api/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'first' }),
  });
  assert.equal(res.status, 201);
  const { id } = await res.json();

  res = await fetch(`${base}/api/items/${id}`);
  assert.equal((await res.json()).name, 'first');

  res = await fetch(`${base}/api/items/9999`);
  assert.equal(res.status, 404);

  res = await fetch(`${base}/api/items/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
});

test('GET /metrics exposes custom metrics', async () => {
  await fetch(`${base}/api/hello`);
  const body = await (await fetch(`${base}/metrics`)).text();
  for (const m of ['http_requests_total', 'http_request_duration_seconds', 'hello_greetings_total', 'app_info']) {
    assert.ok(body.includes(m), `missing ${m}`);
  }
  assert.ok(body.includes('route="/api/items/:id"'));
});
