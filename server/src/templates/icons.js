/**
 * Weather glyphs as standalone SVG, returned as data URIs.
 *
 * Two reasons not to use Unicode weather characters (☀ ☁ ☂): they render
 * inconsistently depending on which font happens to supply the glyph, and
 * they come out spindly and grey once dithered to 16 levels. Hand-drawn
 * strokes stay crisp because we control the weight, which matters on a panel
 * with no anti-aliasing to hide behind.
 *
 * Satori renders SVG through <img src="data:...">, not as inline elements,
 * so these are emitted as complete documents.
 */

const CLOUD_PATH =
  'M18 46h27a10 10 0 0 0 .6-20 15 15 0 0 0-28.4 4A9 9 0 0 0 18 46z';

const RAYS = [
  'M32 6v6', 'M32 52v6', 'M6 32h6', 'M52 32h6',
  'M13.6 13.6l4.2 4.2', 'M46.2 46.2l4.2 4.2',
  'M13.6 50.4l4.2-4.2', 'M46.2 17.8l4.2-4.2',
].map((d) => `<path d="${d}"/>`).join('');

const bodies = {
  sun: `<circle cx="32" cy="32" r="12"/>${RAYS}`,

  part:
    `<circle cx="24" cy="24" r="9"/>` +
    `<path d="M24 9v4M9 24h4M13.4 13.4l2.8 2.8M34.6 13.4l-2.8 2.8"/>` +
    `<path d="${CLOUD_PATH}" fill="#fff"/>`,

  cloud: `<path d="${CLOUD_PATH}"/>`,

  rain:
    `<path d="${CLOUD_PATH}"/>` +
    `<path d="M24 52l-3 7M34 52l-3 7M44 52l-3 7"/>`,

  snow:
    `<path d="${CLOUD_PATH}"/>` +
    `<path d="M23 55h4M25 53v4M37 55h4M39 53v4"/>`,

  storm:
    `<path d="${CLOUD_PATH}"/>` +
    `<path d="M34 50l-8 8h8l-6 8"/>`,

  fog:
    `<path d="${CLOUD_PATH}"/>` +
    `<path d="M16 54h32M20 61h24"/>`,
};

/**
 * Arrows are drawn rather than typed.
 *
 * Satori has no font fallback: it renders only from the faces handed to it,
 * so any character the shipped font lacks comes out as a tofu box. Georgia
 * has no U+2191/U+2193, which is exactly how the high/low arrows first
 * appeared. Drawing them removes the dependency on glyph coverage entirely
 * and keeps the stroke weight consistent with the weather icons.
 */
const arrows = {
  up: '<path d="M32 54V14M18 28l14-14 14 14"/>',
  down: '<path d="M32 10v40M18 36l14 14 14-14"/>',
};

export function iconSvg(name) {
  const isArrow = name in arrows;
  const body = isArrow ? arrows[name] : bodies[name] || bodies.cloud;
  // Arrows are drawn small next to text, so they need a heavier stroke to
  // read at the same visual weight as the larger weather glyphs.
  const stroke = isArrow ? 6 : 3.5;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" ` +
    `width="64" height="64" fill="none" stroke="#000" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  );
}

/**
 * Base64 rather than percent-encoded: resvg is stricter than a browser about
 * unescaped characters in data URIs, and base64 sidesteps the question.
 */
export function iconDataUri(name) {
  return `data:image/svg+xml;base64,${Buffer.from(iconSvg(name)).toString('base64')}`;
}
