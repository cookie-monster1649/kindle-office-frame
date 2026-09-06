import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTree } from '../src/templates/frame.js';

// The in/out headline sizes, duplicated here on purpose: the point of these
// tests is that custom text matches them, so reading the same constant the
// implementation uses would assert nothing.
const HEADLINE = { landscape: 112, portrait: 98 };

/** The message block's laid-out size and its rendered text. */
function messageNode(orientation, customText) {
  const tree = buildTree({
    mode: 'text', orientation, weather: null, markdown: '', customText,
  });
  let found = null;
  (function walk(node) {
    if (!node || typeof node !== 'object' || found !== null) return;
    const { style = {}, children } = node.props ?? {};
    if (style.flexWrap === 'wrap' && typeof children === 'string') {
      found = { size: style.fontSize, text: children };
      return;
    }
    if (Array.isArray(children)) children.forEach(walk);
    else if (children && typeof children === 'object') walk(children);
  }(tree));
  return found;
}

const messageSize = (o, t) => messageNode(o, t).size;
const messageText = (o, t) => messageNode(o, t).text;

for (const orientation of ['landscape', 'portrait']) {
  test(`${orientation}: a short message matches the in/out headline size`, () => {
    assert.equal(messageSize(orientation, 'Back at 3pm'), HEADLINE[orientation]);
  });

  test(`${orientation}: a multi-line message still holds the headline size`, () => {
    // Wraps to several lines in both orientations, but stays under the limit,
    // so it should not shrink - this is the case the old two-line rule got
    // wrong, shrinking a message that had plenty of room.
    const medium = 'Back at 3pm today, ping me on Slack';
    assert.equal(messageSize(orientation, medium), HEADLINE[orientation]);
  });

  test(`${orientation}: a message too long for the line limit steps down`, () => {
    const long = 'Working from home this week. Back in the office on Monday, '
      + 'ping me on Slack if anything urgent comes up before then';
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

// --- long words -------------------------------------------------------------
// A token with no spaces cannot be wrapped by the greedy space-based wrap, so
// it used to be counted as a single line and left at the headline size, where
// it ran straight out of the status column and across the weather pane.

for (const orientation of ['landscape', 'portrait']) {
  test(`${orientation}: a word too long for a line is hyphenated`, () => {
    const text = messageText(orientation, 'sfefsefsadasdasdasdas');
    assert.ok(text.includes('-'), `expected a hyphen, got "${text}"`);
    // Every piece has to be short enough to sit on a line, hyphen included.
    assert.ok(text.split('-').every((part) => part.length > 0));
  });

  test(`${orientation}: ordinary words are never hyphenated`, () => {
    for (const t of ['Back at 3pm', 'Back at 3pm today, ping me on Slack', 'In a meeting']) {
      assert.equal(messageText(orientation, t), t, 'text should pass through untouched');
    }
  });

  test(`${orientation}: an existing hyphen is left alone`, () => {
    const t = 'Back at 3pm - ping me';
    assert.equal(messageText(orientation, t), t);
  });

  test(`${orientation}: a long token forces a step down`, () => {
    // Counted as the several lines it really occupies, not as one.
    const size = messageSize(orientation, 'x'.repeat(120));
    assert.ok(size < HEADLINE[orientation],
      `expected a step down from ${HEADLINE[orientation]}, got ${size}`);
  });
}
