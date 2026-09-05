/**
 * Weekend handling, and the timezone bug it exposed.
 *
 * The device cannot decide this for itself: its clock is UTC and it has no
 * tzdata, so `TZ=... date` is silently ignored. Anything day-dependent has to
 * be resolved server-side, in the display timezone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWeekend, localDateKey, localWeekdayShort } from '../src/localdate.js';
import { buildTree } from '../src/templates/frame.js';
import * as store from '../src/store.js';

const MEL = 'Australia/Melbourne';

// 2026-09-05 is a Saturday; 2026-09-07 a Monday.
const SAT_LOCAL = new Date('2026-09-05T02:00:00Z'); // Sat 12:00 Melbourne
const MON_LOCAL = new Date('2026-09-07T02:00:00Z'); // Mon 12:00 Melbourne

// 22:00 UTC Friday is already Saturday 08:00 in Melbourne. This is the case
// that a UTC-based check gets wrong.
const FRI_UTC_BUT_SAT_MEL = new Date('2026-09-04T22:00:00Z');

test('recognises Saturday and Sunday in the display timezone', () => {
  assert.equal(isWeekend(SAT_LOCAL, MEL), true);
  assert.equal(isWeekend(new Date('2026-09-06T02:00:00Z'), MEL), true); // Sunday
  assert.equal(isWeekend(MON_LOCAL, MEL), false);
});

test('uses local days, not UTC days', () => {
  // Still Friday in UTC, already Saturday in Melbourne. The panel is in
  // Melbourne, so Melbourne wins.
  assert.equal(FRI_UTC_BUT_SAT_MEL.toISOString().slice(0, 10), '2026-09-04');
  assert.equal(localDateKey(FRI_UTC_BUT_SAT_MEL, MEL), '2026-09-05');
  assert.equal(localWeekdayShort(FRI_UTC_BUT_SAT_MEL, MEL), 'Sat');
  assert.equal(isWeekend(FRI_UTC_BUT_SAT_MEL, MEL), true);
});

const flatten = (node, acc = []) => {
  if (typeof node === 'string') acc.push(node);
  else if (Array.isArray(node)) node.forEach((n) => flatten(n, acc));
  else if (node && typeof node === 'object') flatten(node.props?.children, acc);
  return acc;
};
const frameText = (opts) => flatten(buildTree(opts)).join(' ');

test('a weekend mode renders the weekend message', () => {
  const text = frameText({ mode: 'weekend', orientation: 'portrait', now: SAT_LOCAL });
  assert.match(text, /It's the weekend/);
  assert.match(text, /go home/);
  assert.doesNotMatch(text, /is in today|is out/);
});

test('in and out still render the status', () => {
  assert.match(frameText({ mode: 'in', orientation: 'portrait', now: MON_LOCAL }), /is in today/);
  assert.match(frameText({ mode: 'out', orientation: 'portrait', now: MON_LOCAL }), /is out/);
});

test('Saturday resolves to weekend without anyone setting it', async () => {
  // The rule lives in the store, not the template: the template renders the
  // mode it is handed. This is the layer that decides.
  await store.update({ display: 'in', weekendMode: true });
  assert.equal(store.resolveMode('server', SAT_LOCAL), 'weekend');
  assert.equal(store.isAutoWeekend(SAT_LOCAL), true);
});

test('the toggle overrides the selection, which is the point of it', async () => {
  await store.update({ display: 'in', weekendMode: true });
  assert.equal(store.resolveMode('server', SAT_LOCAL), 'weekend');
  assert.equal(store.resolveMode('server', MON_LOCAL), 'in');
});

test('turning the toggle off lets a weekend show the real status', async () => {
  // For someone who works weekends, or a public holiday you want marked.
  await store.update({ display: 'in', weekendMode: false });
  assert.equal(store.resolveMode('server', SAT_LOCAL), 'in');
  assert.equal(store.isAutoWeekend(SAT_LOCAL), false);
});

test('weekend is not a selectable display', async () => {
  // One way to express a thing. Allowing it as a value too would raise an
  // obvious question about which wins.
  const result = await store.update({ display: 'weekend' });
  assert.equal(result.error, 'unknown display');
});

test('custom text is shown and is capped', async () => {
  await store.update({ text: 'Back at 3pm' });
  // Setting text implies showing it; not doing so leaves the panel unchanged
  // and puzzling.
  assert.equal(store.get().display, 'text');
  assert.equal(store.resolveMode('server', MON_LOCAL), 'text');

  await store.update({ text: 'x'.repeat(500) });
  assert.equal(store.get().customText.length, 120);
});

test('the frame renders the custom text', () => {
  const text = frameText({
    mode: 'text', orientation: 'portrait', customText: 'Back at 3pm', now: MON_LOCAL,
  });
  assert.match(text, /Back at 3pm/);
});

test('the ETag changes at local midnight, not UTC midnight', () => {
  // Friday 21:00 Melbourne vs Saturday 08:00 Melbourne. Both are 2026-09-04
  // in UTC, so a UTC-keyed ETag would call them identical and the device would
  // keep 304ing straight through the weekend rollover.
  const friEvening = new Date('2026-09-04T11:00:00Z');
  const satMorning = FRI_UTC_BUT_SAT_MEL;

  assert.equal(
    friEvening.toISOString().slice(0, 10),
    satMorning.toISOString().slice(0, 10),
    'precondition: both fall on the same UTC date'
  );

  const a = store.etagFor({ mode: 'in', orientation: 'portrait', weather: null, now: friEvening });
  const b = store.etagFor({ mode: 'in', orientation: 'portrait', weather: null, now: satMorning });
  assert.notEqual(a, b);
});
