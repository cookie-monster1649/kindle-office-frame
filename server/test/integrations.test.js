/**
 * The integration surface.
 *
 * Callers vary in what they can send - Home Assistant does JSON, Slack posts
 * form-encoded, phone shortcuts often manage only a bare POST to a URL. Each
 * shape is tested because a 400 from a webhook is close to undebuggable from
 * the sending end.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

const READ = 'read-tok';
const WRITE = 'write-tok';
const PORT = 8124;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = '/tmp/frame-integration-test.json';

let server;

before(async () => {
  process.env.FRAME_READ_TOKEN = READ;
  process.env.FRAME_WRITE_TOKEN = WRITE;
  process.env.PORT = String(PORT);
  process.env.STATE_PATH = STATE;
  process.env.WEATHER_ENABLED = 'false';
  await rm(STATE, { force: true });

  const { app } = await import('../src/index.js');
  const store = await import('../src/store.js');
  await store.load();
  server = app.listen(PORT);
  await new Promise((r) => server.once('listening', r));
});

after(async () => {
  server?.close();
  await rm(STATE, { force: true });
});

const write = { Authorization: `Bearer ${WRITE}` };
const read = { Authorization: `Bearer ${READ}` };

// Spread options first: putting it last would overwrite the merged headers
// with options.headers and silently drop the Authorization.
const post = (path, options = {}) =>
  fetch(`${BASE}${path}`, {
    ...options,
    method: 'POST',
    headers: { ...write, ...(options.headers || {}) },
  });

test('JSON body — Home Assistant rest_command', async () => {
  const res = await post('/status', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display: 'out' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).display, 'out');
});

test('form-encoded body — Slack slash command', async () => {
  // Slack sends the command argument as `text`, not `display`.
  const res = await post('/status', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ text: 'in', user_name: 'jj' }).toString(),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).display, 'in');
});

test('bare string body', async () => {
  const res = await post('/status', {
    headers: { 'Content-Type': 'text/plain' },
    body: 'out',
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).display, 'out');
});

test('custom text via JSON', async () => {
  const res = await post('/status', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Back at 3pm' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.customText, 'Back at 3pm');
  assert.equal(body.display, 'text');
});

test('the weekend toggle is settable over the API', async () => {
  const off = await post('/status', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weekendMode: false }),
  });
  assert.equal((await off.json()).weekendMode, false);

  const on = await post('/status', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ weekendMode: true }),
  });
  assert.equal((await on.json()).weekendMode, true);
});

test('path form with no body at all', async () => {
  const res = await post('/status/out');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).display, 'out');
});

test('case and whitespace are tolerated', async () => {
  const res = await post('/status', {
    headers: { 'Content-Type': 'text/plain' },
    body: '  IN  ',
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).display, 'in');
});

test('an unknown value says what is allowed', async () => {
  // A webhook that fails opaquely is very hard to debug from the sending end.
  const res = await post('/status/lunch');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.deepEqual(body.allowed, ['in', 'out', 'text']);
  assert.equal(body.received, 'lunch');
});

test('the path form is not a way around the write token', async () => {
  const res = await fetch(`${BASE}/status/out`, { method: 'POST', headers: read });
  assert.equal(res.status, 403);
});

test('status reports both the choice and what is actually shown', async () => {
  await post('/status/in');
  const res = await fetch(`${BASE}/status`, { headers: read });
  const body = await res.json();
  assert.equal(body.display, 'in');
  assert.ok('effective' in body);
  assert.ok('autoWeekend' in body);
  assert.ok(typeof body.version === 'number');
});

test('the control page loads without a token and leaks no state', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Frame<\/title>/);
  // Inert markup only: no token and no current status baked into the page.
  assert.doesNotMatch(html, new RegExp(WRITE));
  assert.doesNotMatch(html, new RegExp(READ));
});
