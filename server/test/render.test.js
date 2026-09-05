/**
 * Renders real frames and asserts the constraints the Kindle actually
 * enforces. All three of these were silent failures during development: eips
 * simply refuses the image, or paints it in the wrong place, with no error
 * visible on the device.
 *
 * No browser needed - Satori and resvg run in-process.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from '../src/templates/frame.js';
import { renderFrame, describePng, closeBrowser } from '../src/render.js';
import { DEVICE } from '../src/config.js';

const WEATHER = {
  current: { temp: 18, label: 'Partly cloudy', icon: 'part' },
  today: { max: 21, min: 11 },
  forecast: [
    { day: 'Fri', max: 20, min: 12, label: 'Overcast', icon: 'cloud' },
    { day: 'Sat', max: 23, min: 13, label: 'Clear', icon: 'sun' },
    { day: 'Sun', max: 17, min: 11, label: 'Rain', icon: 'rain' },
  ],
  fetchedAt: new Date().toISOString(),
};

after(() => closeBrowser());

for (const orientation of ['portrait', 'landscape']) {
  test(`${orientation}: fills the framebuffer exactly`, async () => {
    const png = await renderFrame({
      tree: buildTree({ mode: 'in', orientation, weather: WEATHER }),
      orientation,
    });
    const info = await describePng(png);
    // Landscape composes at 1448x1072 then rotates, so both orientations must
    // still come out as the portrait framebuffer.
    assert.equal(info.width, DEVICE.width);
    assert.equal(info.height, DEVICE.height);
  });

  test(`${orientation}: uses no more than 16 grey levels`, async () => {
    const png = await renderFrame({
      tree: buildTree({ mode: 'in', orientation, weather: WEATHER }),
      orientation,
    });
    const info = await describePng(png);
    assert.ok(
      info.levels <= DEVICE.greyLevels,
      `got ${info.levels} levels; the panel can only display ${DEVICE.greyLevels}`
    );
  });

  test(`${orientation}: is true greyscale, not palette-indexed`, async () => {
    const png = await renderFrame({
      tree: buildTree({ mode: 'in', orientation, weather: WEATHER }),
      orientation,
    });
    const info = await describePng(png);
    // eips rejects colour-type 3 with "paint_image> ... 8bit only".
    assert.equal(info.colorType, 0);
  });
}

test('renders with no weather at all', async () => {
  // A dead weather API must not take the frame down: a panel showing the date
  // and someone's status beats a blank panel or a stale one.
  const png = await renderFrame({
    tree: buildTree({ mode: 'out', orientation: 'portrait', weather: null }),
    orientation: 'portrait',
  });
  const info = await describePng(png);
  assert.equal(info.width, DEVICE.width);
  assert.equal(info.height, DEVICE.height);
});

test('markdown becomes an element tree, never raw HTML', async () => {
  // Satori takes a tree, so there is no HTML string to inject into. This
  // asserts the shape rather than escaping: any stray markup would have to
  // survive as an element type, which markdownToTree never emits.
  const tree = buildTree({
    mode: 'server',
    orientation: 'portrait',
    weather: WEATHER,
    markdown: '# Hi\n\n<script>alert(1)</script>\n\n- one\n- two',
  });
  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type) seen.add(node.type);
    const kids = node.props?.children;
    if (Array.isArray(kids)) kids.forEach(walk);
    else walk(kids);
  })(tree);
  assert.ok(!seen.has('script'));
  assert.deepEqual([...seen].filter((t) => !['div', 'span', 'img'].includes(t)), []);
});

test('renders long markdown without throwing', async () => {
  const md = ['# Title', '', 'Body **bold** and *italic* and `code`.', '',
    ...Array.from({ length: 12 }, (_, i) => `- item ${i + 1}`)].join('\n');
  const png = await renderFrame({
    tree: buildTree({ mode: 'server', orientation: 'landscape', weather: WEATHER, markdown: md }),
    orientation: 'landscape',
  });
  const info = await describePng(png);
  assert.equal(info.width, DEVICE.width);
  assert.equal(info.colorType, 0);
});
