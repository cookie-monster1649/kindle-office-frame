#!/usr/bin/env node
/**
 * Render every mode/orientation combination to ./out/ so the design can be
 * reviewed on a laptop without touching a Kindle.
 *
 * Each frame is checked against the constraints the device actually enforces,
 * because both are silent failures otherwise: a palette PNG is refused by eips
 * with "8bit only", and wrong dimensions simply paint in the wrong place.
 *
 *   node scripts/preview.js              real weather, needs network
 *   OFFLINE=1 node scripts/preview.js    fixture weather, fully offline
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildTree } from '../src/templates/frame.js';
import { renderFrame, treeToSvg, describePng, closeBrowser } from '../src/render.js';
import { getWeather } from '../src/weather.js';
import * as store from '../src/store.js';
import { DEVICE, MODES, ORIENTATIONS } from '../src/config.js';

const OUT = join(process.cwd(), 'out');

export const FIXTURE_WEATHER = {
  current: { temp: 18, label: 'Partly cloudy', icon: 'part' },
  today: { max: 21, min: 11 },
  forecast: [
    { day: 'Fri', max: 20, min: 12, label: 'Overcast', icon: 'cloud' },
    { day: 'Sat', max: 23, min: 13, label: 'Clear', icon: 'sun' },
    { day: 'Sun', max: 17, min: 11, label: 'Rain', icon: 'rain' },
  ],
  fetchedAt: new Date().toISOString(),
};

const SAMPLE_MARKDOWN = `# Today

Standup moved to **10:30**. Deploy window is open until 16:00.

## Notes

- Review the render pipeline PR
- Chase the WPA3 question
- Battery check on the panel
`;

async function main() {
  await mkdir(OUT, { recursive: true });

  const offline = process.env.OFFLINE === '1';
  const weather = offline ? FIXTURE_WEATHER : (await getWeather()) ?? FIXTURE_WEATHER;

  if (!offline && weather === FIXTURE_WEATHER) {
    console.warn('weather unavailable, falling back to the fixture');
  }

  await store.setMarkdown(SAMPLE_MARKDOWN);

  let failures = 0;

  for (const mode of MODES) {
    for (const orientation of ORIENTATIONS) {
      const tree = buildTree({
        mode,
        orientation,
        weather,
        markdown: store.get().markdown,
      });

      const png = await renderFrame({ tree, orientation });
      const name = `${mode}-${orientation}.png`;
      await writeFile(join(OUT, name), png);

      const info = await describePng(png);
      const problems = [];
      if (info.width !== DEVICE.width || info.height !== DEVICE.height) {
        problems.push(`expected ${DEVICE.width}x${DEVICE.height}, got ${info.width}x${info.height}`);
      }
      if (info.levels > DEVICE.greyLevels) {
        problems.push(`${info.levels} grey levels, panel supports ${DEVICE.greyLevels}`);
      }
      if (info.colorType !== 0) {
        problems.push(`PNG colour-type ${info.colorType}; eips only accepts 0 (greyscale)`);
      }
      if (info.bitDepth !== 8) {
        problems.push(`PNG bit-depth ${info.bitDepth}; eips only accepts 8 ("8bit only")`);
      }

      if (problems.length) {
        failures += 1;
        console.log(`  FAIL ${name}: ${problems.join('; ')}`);
      } else {
        console.log(`  ok   ${name}  ${info.width}x${info.height}  ${info.levels} levels`);
      }
    }
  }

  // Satori has no HTML intermediate to dump, but the SVG is useful: it opens
  // in any browser and shows the layout before quantisation.
  for (const orientation of ORIENTATIONS) {
    const svg = await treeToSvg(
      buildTree({ mode: 'server', orientation, weather, markdown: store.get().markdown }),
      orientation
    );
    await writeFile(join(OUT, `server-${orientation}.svg`), svg);
  }

  await closeBrowser();
  console.log(`\nwrote ${OUT}`);
  if (failures) {
    console.error(`${failures} frame(s) failed device constraints`);
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await closeBrowser();
  process.exit(1);
});
