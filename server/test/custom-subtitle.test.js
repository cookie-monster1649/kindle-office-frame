/**
 * The custom message's optional subtitle: stored and capped like the title,
 * and laid out the way "Please use this desk" sits under the out card.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STATE_PATH = '/tmp/frame-test-subtitle.json';
const store = await import('../src/store.js');
const { buildTree } = await import('../src/templates/frame.js');

// Duplicated on purpose, as in text-sizing.test.js: the point is that the
// custom card matches these, so reading the implementation's constants would
// assert nothing.
const HEADLINE = { landscape: 112, portrait: 98 };
const RATIO = 0.68;
const PORTRAIT_COLUMN = 609; // 46% of the portrait inner height

/** The wrapped text blocks in the status pane: [title, subtitle?]. */
function blocks(orientation, customText, customSubtitle) {
  const tree = buildTree({
    mode: 'text', orientation, weather: null, markdown: '', customText, customSubtitle,
  });
  const found = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    const { style = {}, children } = node.props ?? {};
    if (style.flexWrap === 'wrap' && typeof children === 'string') {
      found.push({ size: style.fontSize, lineHeight: style.lineHeight, marginTop: style.marginTop, text: children });
      return;
    }
    if (Array.isArray(children)) children.forEach(walk);
    else if (children && typeof children === 'object') walk(children);
  }(tree));
  return found;
}

for (const orientation of ['landscape', 'portrait']) {
  test(`${orientation}: no subtitle renders one block, exactly as before`, () => {
    assert.equal(blocks(orientation, 'Back at 3pm', '').length, 1);
    assert.equal(blocks(orientation, 'Back at 3pm', '   ').length, 1, 'whitespace is no subtitle');
  });

  test(`${orientation}: a short title and subtitle match the out card`, () => {
    const [title, sub] = blocks(orientation, 'JJ is at lunch', 'Back at 2pm');
    assert.equal(title.size, HEADLINE[orientation]);
    assert.equal(sub.size, Math.round(HEADLINE[orientation] * RATIO));
    assert.equal(sub.text, 'Back at 2pm');
    assert.equal(sub.marginTop, orientation === 'landscape' ? 18 : 14);
  });

  test(`${orientation}: the subtitle is always ${RATIO} of the title`, () => {
    const long = 'Working from home this week. Back in the office on Monday, '
      + 'ping me on Slack if anything urgent';
    const [title, sub] = blocks(orientation, long, 'Slack is the fastest way to reach me today');
    assert.ok(title.size < HEADLINE[orientation], 'a long pair should step down');
    assert.equal(sub.size, Math.round(title.size * RATIO));
  });

  test(`${orientation}: a long subtitle word is hyphenated, not overrun`, () => {
    const [, sub] = blocks(orientation, 'Away', 'x'.repeat(80));
    assert.ok(sub.text.includes('-'));
  });
}

test('portrait: the worst-case pair fits the status column', () => {
  // Both fields at their caps, as words, so wrapping is realistic.
  const title = ('word '.repeat(24)).trim();            // 119 chars
  const subtitle = ('word '.repeat(16)).trim();         // 79 chars
  const [t, s] = blocks('portrait', title, subtitle);
  // Independent of the implementation's estimate: the real inner width (1072
  // less 62px padding each side) and a deliberately wide 0.55em per character,
  // wider than the serif faces really run, so this errs towards failing.
  const width = 1072 - 62 * 2;
  const lines = (text, size) => Math.ceil(text.length / (width / (size * 0.55)));
  const height = lines(title, t.size) * t.size * t.lineHeight
    + s.marginTop + lines(subtitle, s.size) * s.size * s.lineHeight;
  assert.ok(height <= PORTRAIT_COLUMN, `pair is ${Math.round(height)}px, column is ${PORTRAIT_COLUMN}px`);
});

test('store: subtitle is saved, capped, and cleared', async () => {
  await store.update({ display: 'text', text: 'At lunch', subtitle: 'Back at 2pm' });
  assert.equal(store.get().customSubtitle, 'Back at 2pm');

  await store.update({ subtitle: 'y'.repeat(200) });
  assert.equal(store.get().customSubtitle.length, 80);

  await store.update({ subtitle: '' });
  assert.equal(store.get().customSubtitle, '');
});

test('store: a subtitle change bumps the version, so the device repaints', async () => {
  const before = store.get().version;
  await store.update({ subtitle: 'Back soon' });
  assert.equal(store.get().version, before + 1);
});

test('store: setting a subtitle with a title already saved switches to it', async () => {
  await store.update({ display: 'in', text: 'At lunch' });
  await store.update({ display: 'in' });
  await store.update({ subtitle: 'Back at 2pm' });
  assert.equal(store.get().display, 'text');
});

test('store: a subtitle with no title does not switch the display', async () => {
  await store.update({ display: 'in', text: '' });
  await store.update({ subtitle: 'Back at 2pm' });
  assert.equal(store.get().display, 'in');
});
