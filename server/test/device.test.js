/**
 * The server records when the Kindle last checked in and last downloaded an
 * image, for the control page. Only the device's own requests count.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

const READ = 'device-read-token';
const WRITE = 'device-write-token';
const PORT = 8127;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = '/tmp/frame-device-test-state.json';

let server;
let store;

before(async () => {
  process.env.FRAME_READ_TOKEN = READ;
  process.env.FRAME_WRITE_TOKEN = WRITE;
  process.env.STATE_PATH = STATE;
  process.env.WEATHER_ENABLED = 'false';
  await rm(STATE, { force: true });

  const { app } = await import('../src/index.js');
  store = await import('../src/store.js');
  await store.load();
  server = app.listen(PORT);
  await new Promise((r) => server.once('listening', r));
});

after(async () => {
  server?.close();
  await rm(STATE, { force: true });
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const url = `${BASE}/frame.png?mode=server&orient=landscape`;
const status = async () =>
  (await (await fetch(`${BASE}/status`, { headers: auth(READ) })).json()).device;

test('nothing recorded before the device calls in', async () => {
  const d = await status();
  assert.equal(d.checkedAt, null);
  assert.equal(d.fetchedAt, null);
});

test('the write token and the previews are not the device', async () => {
  await fetch(url, { headers: auth(WRITE) });
  await fetch(url, { method: 'HEAD', headers: auth(WRITE) });
  const d = await status();
  assert.equal(d.checkedAt, null);
  assert.equal(d.fetchedAt, null);
});

test('a device HEAD records a check, and whether anything changed', async () => {
  const first = await fetch(url, { method: 'HEAD', headers: auth(READ) });
  assert.equal(first.status, 200);
  let d = await status();
  assert.ok(d.checkedAt);
  assert.equal(d.checkResult, 'changed');
  assert.equal(d.fetchedAt, null, 'a HEAD downloads nothing');

  const etag = first.headers.get('etag');
  const again = await fetch(url, { method: 'HEAD', headers: { ...auth(READ), 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  d = await status();
  assert.equal(d.checkResult, 'unchanged');
});

test('a device GET records the download and its orientation', async () => {
  const res = await fetch(url, { headers: auth(READ) });
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  const d = await status();
  assert.ok(d.fetchedAt);
  assert.equal(d.orientation, 'landscape');
});

test('recording the device does not change the ETag', async () => {
  const a = (await fetch(url, { method: 'HEAD', headers: auth(READ) })).headers.get('etag');
  await fetch(url, { method: 'HEAD', headers: auth(READ) });
  const b = (await fetch(url, { method: 'HEAD', headers: auth(READ) })).headers.get('etag');
  assert.equal(a, b);
});

test('the record survives a reload from disk', async () => {
  const before = store.get().device.fetchedAt;
  await store.load();
  assert.equal(store.get().device.fetchedAt, before);
});
