/**
 * Font loading for Satori.
 *
 * Unlike a browser, Satori has no font discovery: every weight must be handed
 * to it as a buffer. That is a feature here - it means the container renders
 * with exactly the fonts we shipped, so output cannot drift when a base image
 * changes its font set.
 *
 * TrueType collections (.ttc) are not supported, which rules out macOS's
 * Charter. Georgia is the local fallback instead: also a Matthew Carter
 * design for low-resolution screens, so the same reasoning applies.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const CANDIDATES = {
  regular: [
    process.env.FONT_REGULAR,
    // Debian: fonts-sil-charis. Charter's direct descendant, OFL licensed.
    '/usr/share/fonts/truetype/charis/CharisSIL-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    '/System/Library/Fonts/Supplemental/Georgia.ttf',
    '/System/Library/Fonts/Supplemental/Times New Roman.ttf',
  ],
  bold: [
    process.env.FONT_BOLD,
    '/usr/share/fonts/truetype/charis/CharisSIL-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Georgia Bold.ttf',
    '/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf',
  ],
};

function resolve(list) {
  return list.filter(Boolean).find((p) => existsSync(p)) ?? null;
}

let cached = null;

export async function loadFonts() {
  if (cached) return cached;

  const regularPath = resolve(CANDIDATES.regular);
  if (!regularPath) {
    throw new Error(
      'No usable font found. Set FONT_REGULAR to a .ttf path ' +
        '(TrueType collections such as Charter.ttc are not supported).'
    );
  }

  const boldPath = resolve(CANDIDATES.bold);

  const fonts = [
    { name: 'Frame', data: await readFile(regularPath), weight: 400, style: 'normal' },
  ];

  if (boldPath) {
    fonts.push({ name: 'Frame', data: await readFile(boldPath), weight: 700, style: 'normal' });
  } else {
    // Satori does not synthesise weights: without a bold face, bold text
    // silently renders at regular weight. Say so rather than leave it puzzling.
    console.warn('[fonts] no bold face found; bold text will render at regular weight');
  }

  cached = { fonts, regularPath, boldPath };
  return cached;
}

export function _resetForTests() {
  cached = null;
}
