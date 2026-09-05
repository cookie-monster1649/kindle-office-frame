/**
 * Element tree -> SVG -> PNG -> e-ink-ready PNG.
 *
 * Satori and resvg replace headless Chromium here. A browser bought real CSS
 * layout, but cost ~400MB of image, 150-300MB of RSS per render, a 256MB
 * shm_size workaround, zombie reaping, and - most annoyingly - output that
 * could drift when Chromium changed its font hinting. Satori renders a fixed
 * subset deterministically from fonts we ship ourselves, in ~9MB.
 *
 * The two device constraints below are unchanged, and both fail silently on
 * the Kindle if you get them wrong:
 *
 *  1. Quantisation. The panel has 16 fixed grey levels (i*255/15).
 *     ImageMagick's `-colors 16` picks an *adaptive* palette from image
 *     content instead - 18 content-derived levels when measured - so the
 *     device re-quantises with a worse algorithm. We remap onto an explicit
 *     ramp.
 *
 *  2. PNG colour type. eips rejects palette-indexed PNGs outright with
 *     "paint_image> ... 8bit only". Remapping produces one by default, so the
 *     result must be forced back to true greyscale samples (colour-type 0).
 *
 * Landscape frames are composed at 1448x1072 and rotated 90 CW into the
 * 1072x1448 buffer, because eips always paints into the portrait framebuffer
 * however the device is held.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

import { DEVICE, logicalSize } from './config.js';
import { loadFonts } from './fonts.js';

const exec = promisify(execFile);

/**
 * 16 evenly spaced greys as a 16x1 PNG, for -remap.
 *
 * Built once into its own directory: the per-render temp dir is deleted after
 * each frame, so a cached path pointing into it would dangle on the second
 * render. (It did.)
 */
let palettePromise = null;
async function palettePath() {
  if (palettePromise) return palettePromise;
  palettePromise = (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frame-palette-'));
    const p = join(dir, 'palette16.png');
    const args = [];
    for (let i = 0; i < DEVICE.greyLevels; i += 1) {
      const v = Math.round((i * 255) / (DEVICE.greyLevels - 1));
      args.push('-size', '1x1', `xc:rgb(${v},${v},${v})`);
    }
    args.push('+append', '-depth', '8', p);
    await exec('magick', args);
    return p;
  })();
  return palettePromise;
}

export async function treeToSvg(tree, orientation) {
  const { width, height } = logicalSize(orientation);
  const { fonts } = await loadFonts();
  return satori(tree, { width, height, fonts });
}

export function svgToPng(svg, orientation) {
  const { width } = logicalSize(orientation);
  const resvg = new Resvg(svg, {
    // Render at exactly the logical width; no scaling, so text lands on whole
    // pixels rather than being resampled.
    fitTo: { mode: 'width', value: width },
    background: '#ffffff',
    font: { loadSystemFonts: false },
  });
  return resvg.render().asPng();
}

/** Greyscale, dither onto the panel's fixed levels, rotate if landscape. */
export async function toEink(pngBuffer, orientation) {
  const dir = await mkdtemp(join(tmpdir(), 'frame-'));
  try {
    const src = join(dir, 'in.png');
    const out = join(dir, 'out.png');
    await writeFile(src, pngBuffer);
    const pal = await palettePath();

    const args = [src];
    if (orientation === 'landscape') args.push('-rotate', '90');
    args.push(
      '-colorspace', 'Gray',
      '-dither', 'FloydSteinberg',
      '-remap', pal,
      '-type', 'Grayscale',
      '-depth', '8',
      '-define', 'png:color-type=0',
      out
    );

    await exec('magick', args);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function renderFrame({ tree, orientation }) {
  const svg = await treeToSvg(tree, orientation);
  const png = svgToPng(svg, orientation);
  return toEink(png, orientation);
}

/** Kept for API compatibility with the old Chromium renderer. */
export async function closeBrowser() {}

/** Used by tests and the preview to assert the output is device-legal. */
export async function describePng(buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'frame-check-'));
  try {
    const p = join(dir, 'x.png');
    await writeFile(p, buffer);
    const { stdout } = await exec('magick', ['identify', '-format', '%w %h %k', p]);
    const [width, height, levels] = stdout.trim().split(/\s+/).map(Number);
    // Colour type is byte 25 of the IHDR: 0 greyscale, 3 palette.
    return { width, height, levels, colorType: buffer[25] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
