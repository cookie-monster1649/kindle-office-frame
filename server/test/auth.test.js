/**
 * Read and write are separately authorised.
 *
 * The Kindle holds the read token. It sits unattended, possibly somewhere you
 * do not control, and could be lost or taken - so it must be able to fetch
 * frames and nothing else. These tests exist to stop that boundary quietly
 * eroding.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

const READ = 'read-only-token';
const WRITE = 'write-token';
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

before(async () => {
  process.env.FRAME_READ_TOKEN = READ;
  process.env.FRAME_WRITE_TOKEN = WRITE;
  process.env.PORT = String(PORT);
  process.env.STATE_PATH = '/tmp/frame-auth-test-state.json';
  process.env.WEATHER_ENABLED = 'false';
  await rm(process.env.STATE_PATH, { force: true });

  const { app } = await import('../src/index.js');
  const store = await import('../src/store.js');
  await store.load();
  server = app.listen(PORT);
  await new Promise((r) => server.once('listening', r));
});

after(async () => {
  server?.close();
  await rm('/tmp/frame-auth-test-state.json', { force: true });
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

test('no token cannot read', async () => {
  const res = await fetch(`${BASE}/frame.png?mode=in`);
  assert.equal(res.status, 401);
});

test('read token can read a frame', async () => {
  const res = await fetch(`${BASE}/frame.png?mode=in&orient=portrait`, { headers: auth(READ) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('read token CANNOT change status', async () => {
  const res = await fetch(`${BASE}/status`, {
    method: 'POST',
    headers: { ...auth(READ), 'Content-Type': 'application/json' },
    body: JSON.stringify({ display: 'out' }),
  });
  assert.equal(res.status, 403);

  // And the state really is untouched, not merely reported as refused.
  const check = await fetch(`${BASE}/status`, { headers: auth(READ) });
  assert.equal((await check.json()).display, 'in');
});

test('read token CANNOT push content', async () => {
  const res = await fetch(`${BASE}/content`, {
    method: 'POST',
    headers: { ...auth(READ), 'Content-Type': 'text/plain' },
    body: '# nope',
  });
  assert.equal(res.status, 403);
});

test('write token can change status', async () => {
  const res = await fetch(`${BASE}/status`, {
    method: 'POST',
    headers: { ...auth(WRITE), 'Content-Type': 'application/json' },
    body: JSON.stringify({ display: 'out' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).display, 'out');
});

test('write token can also read, for debugging', async () => {
  const res = await fetch(`${BASE}/status`, { headers: auth(WRITE) });
  assert.equal(res.status, 200);
});

test('a wrong token is refused outright', async () => {
  const res = await fetch(`${BASE}/frame.png?mode=in`, { headers: auth('guess') });
  assert.equal(res.status, 401);
});
