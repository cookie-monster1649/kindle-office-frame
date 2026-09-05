/**
 * The server-driven display: what `mode=server` resolves to, and how changing
 * it invalidates the device's cached frame.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Isolate the state file. `node --test` runs files in parallel, so
// sharing the default path lets these races corrupt each other - which
// showed up as an intermittent failure.
process.env.STATE_PATH = '/tmp/frame-test-status.json';
import * as store from '../src/store.js';

const WEATHER = {
  current: { temp: 18, label: 'Partly cloudy', icon: 'part' },
  today: { max: 21, min: 11 },
  forecast: [{ day: 'Fri', max: 20, min: 12, label: 'Overcast', icon: 'cloud' }],
  fetchedAt: '2026-09-04T09:00:00.000Z',
};
// A Friday. Tests must pin the date: with the weekend toggle on by default,
// running these on a Saturday would otherwise resolve everything to 'weekend'.
const NOW = new Date('2026-09-04T09:00:00Z');

test('in and out are device overrides, passed through untouched', async () => {
  await store.update({ display: 'out' });
  // The device asked for `in` explicitly, so the server's own state must not
  // override it.
  assert.equal(store.resolveMode('in', NOW), 'in');
  assert.equal(store.resolveMode('out', NOW), 'out');
});

test('server mode resolves to whatever the server currently shows', async () => {
  await store.update({ display: 'in' });
  assert.equal(store.resolveMode('server', NOW), 'in');

  await store.update({ display: 'out' });
  assert.equal(store.resolveMode('server', NOW), 'out');
});

test('rejects an unknown display, says why, and leaves state alone', async () => {
  await store.update({ display: 'in' });
  const result = await store.update({ display: 'lunch' });
  assert.equal(result.error, 'unknown display');
  assert.deepEqual(result.allowed, ['in', 'out', 'text']);
  assert.equal(store.get().display, 'in');
});

test('changing the display invalidates a server-mode ETag', async () => {
  // This is the mechanism that makes a phone-driven status change actually
  // reach the panel: without it the device would keep 304ing on the old frame.
  await store.update({ display: 'in' });
  const before = store.etagFor({ mode: 'server', orientation: 'portrait', weather: WEATHER, now: NOW });

  await store.update({ display: 'out' });
  const after = store.etagFor({ mode: 'server', orientation: 'portrait', weather: WEATHER, now: NOW });

  assert.notEqual(before, after);
});

test('a server-mode ETag matches the resolved mode, not the literal one', async () => {
  await store.update({ display: 'out' });
  const asServer = store.etagFor({ mode: 'server', orientation: 'portrait', weather: WEATHER, now: NOW });
  const asOut = store.etagFor({ mode: 'out', orientation: 'portrait', weather: WEATHER, now: NOW });
  // Same pixels, so the same validator: a device switching between "ask the
  // server" and "show out" should not be forced into a needless repaint.
  assert.equal(asServer, asOut);
});

test('display survives a reload', async () => {
  await store.update({ display: 'out' });
  const reloaded = await store.load();
  assert.equal(reloaded.display, 'out');
});
