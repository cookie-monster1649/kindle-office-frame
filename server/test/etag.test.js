import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.js';

const WEATHER = {
  current: { temp: 18, label: 'Partly cloudy', icon: 'part' },
  today: { max: 21, min: 11 },
  forecast: [{ day: 'Fri', max: 20, min: 12, label: 'Overcast', icon: 'cloud' }],
  fetchedAt: '2026-09-04T09:00:00.000Z',
};

const base = { mode: 'in', orientation: 'portrait', weather: WEATHER };

test('is stable across calls with identical inputs', () => {
  const now = new Date('2026-09-04T09:00:00Z');
  assert.equal(store.etagFor({ ...base, now }), store.etagFor({ ...base, now }));
});

test('ignores the clock within a day', () => {
  // The whole point of conditional requests: a poll 20 minutes later with
  // nothing changed must still 304, or the panel repaints every cycle.
  const morning = store.etagFor({ ...base, now: new Date('2026-09-04T09:00:00Z') });
  const later = store.etagFor({ ...base, now: new Date('2026-09-04T09:20:00Z') });
  assert.equal(morning, later);
});

test('ignores weather.fetchedAt when the readings are unchanged', () => {
  // fetchedAt moves on every cache refresh; treating it as significant would
  // churn the ETag for no visible change.
  const a = store.etagFor({ ...base, now: new Date('2026-09-04T09:00:00Z') });
  const b = store.etagFor({
    ...base,
    weather: { ...WEATHER, fetchedAt: '2026-09-04T09:15:00.000Z' },
    now: new Date('2026-09-04T09:00:00Z'),
  });
  assert.equal(a, b);
});

test('changes when the date rolls over', () => {
  const thu = store.etagFor({ ...base, now: new Date('2026-09-04T09:00:00Z') });
  const fri = store.etagFor({ ...base, now: new Date('2026-09-05T09:00:00Z') });
  assert.notEqual(thu, fri);
});

test('changes with mode and with orientation', () => {
  const now = new Date('2026-09-04T09:00:00Z');
  const inPortrait = store.etagFor({ ...base, now });
  assert.notEqual(inPortrait, store.etagFor({ ...base, mode: 'out', now }));
  assert.notEqual(inPortrait, store.etagFor({ ...base, orientation: 'landscape', now }));
});

test('changes when the weather readings change', () => {
  const now = new Date('2026-09-04T09:00:00Z');
  const before = store.etagFor({ ...base, now });
  const after = store.etagFor({
    ...base,
    weather: { ...WEATHER, current: { ...WEATHER.current, temp: 24 } },
    now,
  });
  assert.notEqual(before, after);
});

test('changes when content is pushed', async () => {
  const now = new Date('2026-09-04T09:00:00Z');
  const before = store.etagFor({ ...base, mode: 'server', now });
  await store.setMarkdown('# something new');
  const after = store.etagFor({ ...base, mode: 'server', now });
  assert.notEqual(before, after);
});

test('is a quoted weak validator', () => {
  // If-None-Match is ignored by servers when the quotes are stripped, which
  // silently defeats the 304 path. This bit us on the device already.
  const etag = store.etagFor({ ...base, now: new Date('2026-09-04T09:00:00Z') });
  assert.match(etag, /^W\/"[0-9a-f]{64}"$/);
});
