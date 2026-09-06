import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTree } from '../src/templates/frame.js';

// The in/out headline sizes, duplicated here on purpose: the point of these
// tests is that custom text matches them, so reading the same constant the
// implementation uses would assert nothing.
const HEADLINE = { landscape: 112, portrait: 98 };

/** The font size the message block was laid out at. */
function messageSize(orientation, customText) {
  const tree = buildTree({
    mode: 'text', orientation, weather: null, markdown: '', customText,
  });
  let found = null;
  (function walk(node) {
    if (!node || typeof node !== 'object' || found !== null) return;
    const { style = {}, children } = node.props ?? {};
    if (style.flexWrap === 'wrap' && typeof children === 'string') {
      found = style.fontSize;
      return;
    }
    if (Array.isArray(children)) children.forEach(walk);
    else if (children && typeof children === 'object') walk(children);
  }(tree));
  return found;
}

for (const orientation of ['landscape', 'portrait']) {
  test(`${orientation}: a short message matches the in/out headline size`, () => {
    assert.equal(messageSize(orientation, 'Back at 3pm'), HEADLINE[orientation]);
  });

  test(`${orientation}: a message too long for two lines steps down`, () => {
    const long = 'Away on leave until the 14th of next month, please contact the team inbox';
    const size = messageSize(orientation, long);
    assert.ok(size < HEADLINE[orientation],
      `expected a step down from ${HEADLINE[orientation]}, got ${size}`);
  });

  test(`${orientation}: never larger than the headline`, () => {
    for (const t of ['Hi', 'Back at 3pm today, ping me on Slack', 'x'.repeat(120)]) {
      assert.ok(messageSize(orientation, t) <= HEADLINE[orientation]);
    }
  });

  test(`${orientation}: an empty message still renders at the headline size`, () => {
    // Falls back to an em dash, which is short - so it should look like a status.
    assert.equal(messageSize(orientation, ''), HEADLINE[orientation]);
  });
}
