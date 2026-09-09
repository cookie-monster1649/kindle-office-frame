/**
 * Windowed rain: the morning and afternoon chance printed under the high/low,
 * and the rule that promotes a forecast day's icon to rain.
 *
 * Driven through getWeather with a stubbed fetch rather than by exporting the
 * internals, so the request parameters are covered too - asking Open-Meteo for
 * the wrong fields would leave every window null, and that failure looks
 * exactly like a dry day.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getWeather, _resetCacheForTests } from '../src/weather.js';
import { buildTree } from '../src/templates/frame.js';

const DAY = '2026-09-09';

/** An hourly series for one day: 24 entries, with overrides by hour. */
function hourly(probabilities = {}, mms = {}) {
  const time = [];
  const precipitation_probability = [];
  const precipitation = [];
  for (let h = 0; h < 24; h += 1) {
    time.push(`${DAY}T${String(h).padStart(2, '0')}:00`);
    precipitation_probability.push(probabilities[h] ?? 0);
    precipitation.push(mms[h] ?? 0);
  }
  return { time, precipitation_probability, precipitation };
}

function stubOpenMeteo({ hourlyBlock = hourly(), dailyProb = [0, 0, 0, 0], codes = [3, 3, 3, 3] } = {}) {
  const captured = {};
  globalThis.fetch = async (url) => {
    captured.url = url;
    return {
      ok: true,
      json: async () => ({
        current: { temperature_2m: 18, weather_code: 2 },
        hourly: hourlyBlock,
        daily: {
          time: [DAY, '2026-09-10', '2026-09-11', '2026-09-12'],
          weather_code: codes,
          temperature_2m_max: [21, 20, 23, 17],
          temperature_2m_min: [11, 12, 13, 11],
          precipitation_probability_max: dailyProb,
        },
      }),
    };
  };
  return captured;
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  _resetCacheForTests();
  globalThis.fetch = realFetch;
});

test('the request asks for the hourly fields the windows are built from', async () => {
  const captured = stubOpenMeteo();
  await getWeather({ force: true });
  const params = captured.url.searchParams;
  assert.equal(params.get('hourly'), 'precipitation_probability,precipitation');
  assert.match(params.get('daily'), /precipitation_probability_max/);
});

test('probability is the peak in the window, not the average', async () => {
  // A single wet hour in the morning still means take a coat.
  stubOpenMeteo({ hourlyBlock: hourly({ 6: 0, 7: 80, 8: 0, 9: 0, 10: 0, 11: 0 }) });
  const w = await getWeather({ force: true });
  assert.equal(w.today.rain.am.probability, 80);
});

test('millimetres are summed across the window', async () => {
  stubOpenMeteo({ hourlyBlock: hourly({}, { 6: 0.4, 7: 0.4, 8: 0.2 }) });
  const w = await getWeather({ force: true });
  assert.ok(Math.abs(w.today.rain.am.mm - 1.0) < 1e-9);
});

test('the windows are 06-12 and 15-19 local, and exclude their end hour', async () => {
  // 12:00 and 19:00 sit outside; 06:00 and 15:00 sit inside.
  stubOpenMeteo({ hourlyBlock: hourly({ 6: 10, 12: 90, 15: 20, 19: 95 }) });
  const w = await getWeather({ force: true });
  assert.equal(w.today.rain.am.probability, 10, '12:00 must not leak into AM');
  assert.equal(w.today.rain.pm.probability, 20, '19:00 must not leak into PM');
});

test('hours outside both windows are ignored entirely', async () => {
  // 02:00 and 22:00 are the overnight hours the panel is asleep through.
  stubOpenMeteo({ hourlyBlock: hourly({ 2: 100, 22: 100 }) });
  const w = await getWeather({ force: true });
  assert.equal(w.today.rain.am.probability, 0);
  assert.equal(w.today.rain.pm.probability, 0);
});

test('a missing hourly block yields null windows rather than a false 0%', async () => {
  stubOpenMeteo({ hourlyBlock: { time: [] } });
  const w = await getWeather({ force: true });
  assert.equal(w.today.rain.am, null);
  assert.equal(w.today.rain.pm, null);
});

test('a forecast day above 10% gets the rain icon despite its weather code', async () => {
  // Code 3 is overcast. 40% is worth knowing about, so the icon says so.
  stubOpenMeteo({ dailyProb: [0, 40, 0, 0], codes: [3, 3, 3, 3] });
  const w = await getWeather({ force: true });
  assert.equal(w.forecast[0].icon, 'rain');
});

test('a forecast day at or below 10% keeps its own icon', async () => {
  // The case that made the threshold necessary: 3% on a dry overcast day.
  stubOpenMeteo({ dailyProb: [0, 3, 10, 0], codes: [3, 3, 3, 3] });
  const w = await getWeather({ force: true });
  assert.equal(w.forecast[0].icon, 'cloud');
  assert.equal(w.forecast[1].icon, 'cloud', '10% is not above 10%');
});

test('snow and storm keep their glyph however wet the day is', async () => {
  stubOpenMeteo({ dailyProb: [0, 95, 95, 0], codes: [3, 73, 95, 3] });
  const w = await getWeather({ force: true });
  assert.equal(w.forecast[0].icon, 'snow');
  assert.equal(w.forecast[1].icon, 'storm');
});

// ------------------------------------------------------------- rendering ---

const flatten = (node) => {
  const out = [];
  const walk = (n) => {
    if (n == null || n === false) return;
    if (typeof n === 'string') { out.push(n); return; }
    if (Array.isArray(n)) { n.forEach(walk); return; }
    walk(n.props?.children);
  };
  walk(node);
  return out;
};
const frameText = (weather, orientation = 'portrait') =>
  flatten(buildTree({ mode: 'in', orientation, weather })).join(' ');

const withRain = (am, pm) => ({
  current: { temp: 18, label: 'Partly cloudy', icon: 'part' },
  today: { max: 21, min: 11, rain: { am, pm } },
  forecast: [{ day: 'Fri', max: 20, min: 12, label: 'Overcast', icon: 'cloud' }],
});

test('the frame prints both windows', () => {
  const text = frameText(withRain({ probability: 39, mm: 0 }, { probability: 3, mm: 0.1 }));
  assert.match(text, /AM 39%/);
  assert.match(text, /PM 3% · 0\.1mm/);
});

test('a dry window shows the percentage and no millimetres', () => {
  const text = frameText(withRain({ probability: 0, mm: 0 }, { probability: 0, mm: 0 }));
  assert.match(text, /AM 0%/);
  assert.doesNotMatch(text, /mm/, 'a dry day must not read "0.0mm"');
});

test('millimetres lose the decimal once there are ten of them', () => {
  const text = frameText(withRain({ probability: 100, mm: 12.4 }, { probability: 85, mm: 8.25 }));
  assert.match(text, /AM 100% · 12mm/);
  assert.match(text, /PM 85% · 8\.3mm/);
});

test('a trace below 0.05mm is not worth a number', () => {
  const text = frameText(withRain({ probability: 20, mm: 0.04 }, { probability: 0, mm: 0 }));
  assert.match(text, /AM 20%/);
  assert.doesNotMatch(text, /mm/);
});

test('the row disappears entirely when neither window has data', () => {
  const text = frameText(withRain(null, null));
  assert.doesNotMatch(text, /AM |PM /);
});

test('one usable window still renders', () => {
  const text = frameText(withRain({ probability: 55, mm: 1.2 }, null));
  assert.match(text, /AM 55% · 1\.2mm/);
  assert.doesNotMatch(text, /PM /);
});
