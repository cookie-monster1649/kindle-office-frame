/**
 * Builds the Satori element tree for a frame.
 *
 * Satori takes a tree with inline styles and supports a subset of CSS -
 * flexbox, absolute positioning, borders, text properties. No stylesheets, no
 * grid, no selectors. That is why everything here is explicit objects rather
 * than a CSS file.
 *
 * Layout follows the panel shape rather than squashing one design into two
 * aspect ratios:
 *
 *   landscape   status | weather    side by side, 55/45
 *   portrait    status over weather, split roughly in half
 *
 * Pure black on white, with grey reserved for genuinely secondary text.
 * Mid-tones cost dithering noise and read as muddy on e-ink.
 */

import { iconDataUri } from './icons.js';
import { markdownToTree } from './markdown.js';
import { logicalSize, config } from '../config.js';

const el = (type, style, children) => ({ type, props: { style, children } });
const row = (style, children) => el('div', { display: 'flex', flexDirection: 'row', ...style }, children);
const col = (style, children) => el('div', { display: 'flex', flexDirection: 'column', ...style }, children);
const txt = (style, content) => el('div', { display: 'flex', ...style }, String(content));

// src is a prop on the element, not a style: Satori's shape is
// { type, props: { style, src, children } }.
const img = (src, style) => ({ type: 'img', props: { src, style } });

// A horizontal rule. Satori has no <hr>, so it is a zero-content flex box
// with a background.
//
// Portrait omits the line and keeps the gap. The portrait layout is already
// separated by whitespace and a change of type size, so the rules read as
// clutter there; landscape leans on them because the vertical divider sets up
// the expectation of ruled sections.
const rule = (landscape, marginTop, marginBottom) =>
  el('div', {
    display: 'flex',
    height: landscape ? 3 : 0,
    backgroundColor: landscape ? '#000' : 'transparent',
    marginTop,
    marginBottom,
  }, undefined);

const FONT = 'Frame';

function formatDate(now, tz) {
  return {
    weekday: now.toLocaleDateString('en-AU', { weekday: 'long', timeZone: tz }),
    rest: now.toLocaleDateString('en-AU', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: tz,
    }),
  };
}

function weatherPane(weather, landscape) {
  if (!weather) {
    // A visible gap, not an empty column: a weather outage should look like
    // an outage rather than a design choice.
    return txt({ fontSize: 30, color: '#555' }, 'weather unavailable');
  }

  const bigIcon = landscape ? 92 : 76;
  const rowIcon = landscape ? 44 : 40;

  return col({}, [
    row({ alignItems: 'center', marginTop: landscape ? 30 : 26 }, [
      img(iconDataUri(weather.current.icon), {
        width: bigIcon, height: bigIcon, marginRight: 22,
      }),
      col({}, [
        txt({ fontSize: landscape ? 84 : 74, lineHeight: 1 }, `${weather.current.temp}°`),
        txt({ fontSize: landscape ? 32 : 29, marginTop: 4 }, weather.current.label),
      ]),
    ]),

    row({ marginTop: 16, alignItems: 'center' }, [
      img(iconDataUri('up'), { width: 22, height: 22, marginRight: 8 }),
      txt({ fontSize: landscape ? 34 : 31, marginRight: 34 }, `${weather.today.max}°`),
      img(iconDataUri('down'), { width: 22, height: 22, marginRight: 8 }),
      txt({ fontSize: landscape ? 34 : 31 }, `${weather.today.min}°`),
    ]),

    rule(landscape, landscape ? 26 : 24, landscape ? 26 : 24),

    col({}, weather.forecast.map((d) =>
      row({ alignItems: 'center', marginBottom: landscape ? 14 : 12 }, [
        txt({ fontSize: landscape ? 32 : 29, width: landscape ? 104 : 92 }, d.day),
        img(iconDataUri(d.icon), { width: rowIcon, height: rowIcon }),
        txt({ fontSize: landscape ? 32 : 29, marginLeft: 'auto' },
          `${d.max}° / ${d.min}°`),
      ])
    )),
  ]);
}

function statusPane({ mode, markdown, customText }, landscape) {
  // `weekend` is never selected directly - it arrives resolved, because the
  // device's clock is UTC with no tzdata and could not apply the rule itself.
  if (mode === 'weekend') {
    const size = landscape ? 96 : 82;
    return col({ justifyContent: 'center' }, [
      txt({ fontSize: size, lineHeight: 1.12 }, "It's the weekend,"),
      txt({ fontSize: size, lineHeight: 1.12 }, 'go home!'),
    ]);
  }

  if (mode === 'text') {
    // Sized to the message: a couple of words should read from across the
    // room, a full sentence has to fit. Wraps rather than truncating, since a
    // half-shown message is worse than a smaller one.
    const n = (customText || '').length;
    const size = landscape
      ? (n <= 18 ? 104 : n <= 44 ? 72 : 52)
      : (n <= 18 ? 88 : n <= 44 ? 62 : 46);
    return col({ justifyContent: 'center' }, [
      el('div', {
        display: 'flex', flexWrap: 'wrap',
        fontSize: size, lineHeight: 1.14,
      }, customText || '—'),
    ]);
  }

  if (mode === 'in' || mode === 'out') {
    const size = landscape ? 112 : 98;
    return col({ justifyContent: 'center' }, [
      txt({ fontSize: size, lineHeight: 1.08 }, config.personName),
      txt({ fontSize: size, lineHeight: 1.08 }, mode === 'in' ? 'is in today' : 'is out'),
    ]);
  }
  return col({ justifyContent: 'center' }, markdownToTree(markdown, landscape ? 1.06 : 1));
}

export function buildTree({
  mode = 'in',
  orientation = 'portrait',
  weather = null,
  markdown = '',
  customText = '',
  now = new Date(),
}) {
  const { width, height } = logicalSize(orientation);
  const landscape = orientation === 'landscape';
  const { weekday, rest } = formatDate(now, config.timezone);
  const stamp = now.toLocaleTimeString('en-AU', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.timezone,
  });

  const pad = landscape ? 56 : 62;

  // Landscape keeps a vertical rule between the two columns. Portrait uses
  // whitespace alone: stacked sections read fine without a line, and the
  // horizontal rules were the main source of visual noise there.
  const divider = landscape
    ? { borderLeftWidth: 3, borderLeftColor: '#000', borderLeftStyle: 'solid', paddingLeft: 52, marginLeft: 8 }
    : { paddingTop: 8, marginTop: 8 };

  return el('div', {
    display: 'flex',
    flexDirection: landscape ? 'row' : 'column',
    width,
    height,
    backgroundColor: '#fff',
    color: '#000',
    fontFamily: FONT,
    padding: pad,
    position: 'relative',
  }, [
    el('div', {
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      flexBasis: landscape ? '55%' : '46%', flexGrow: 0, flexShrink: 0,
    }, [statusPane({ mode, markdown, customText }, landscape)]),

    el('div', {
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
      flexGrow: 1, ...divider,
    }, [
      txt({ fontSize: landscape ? 54 : 50, lineHeight: 1.1 }, weekday),
      txt({ fontSize: landscape ? 34 : 32, marginTop: 6 }, rest),
      rule(landscape, landscape ? 26 : 20, 4),
      weatherPane(weather, landscape),
    ]),

    // Rendered into every frame: e-ink fails silently, and stale content
    // presented as current is the worst available failure mode.
    txt({
      position: 'absolute', left: pad, bottom: landscape ? 26 : 34,
      fontSize: 22, color: '#555',
    }, `updated ${stamp}`),
  ]);
}
