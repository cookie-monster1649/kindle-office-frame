/**
 * Weather via Open-Meteo.
 *
 * Chosen because it needs no API key, which means this whole service can be
 * deployed without secret management. The shape returned here is deliberately
 * provider-agnostic, so swapping to Home Assistant or anything else only means
 * rewriting fetchWeather().
 */

import { config } from './config.js';

// WMO weather codes, collapsed into the handful of categories that are
// actually distinguishable as a glyph on a 1-bit-ish e-ink panel.
const WMO = {
  0: ['Clear', 'sun'],
  1: ['Mainly clear', 'sun'],
  2: ['Partly cloudy', 'part'],
  3: ['Overcast', 'cloud'],
  45: ['Fog', 'fog'],
  48: ['Rime fog', 'fog'],
  51: ['Light drizzle', 'rain'],
  53: ['Drizzle', 'rain'],
  55: ['Heavy drizzle', 'rain'],
  56: ['Freezing drizzle', 'rain'],
  57: ['Freezing drizzle', 'rain'],
  61: ['Light rain', 'rain'],
  63: ['Rain', 'rain'],
  65: ['Heavy rain', 'rain'],
  66: ['Freezing rain', 'rain'],
  67: ['Freezing rain', 'rain'],
  71: ['Light snow', 'snow'],
  73: ['Snow', 'snow'],
  75: ['Heavy snow', 'snow'],
  77: ['Snow grains', 'snow'],
  80: ['Showers', 'rain'],
  81: ['Showers', 'rain'],
  82: ['Heavy showers', 'rain'],
  85: ['Snow showers', 'snow'],
  86: ['Snow showers', 'snow'],
  95: ['Thunderstorm', 'storm'],
  96: ['Thunderstorm', 'storm'],
  99: ['Thunderstorm', 'storm'],
};

export function describeCode(code) {
  const [label, icon] = WMO[code] || ['—', 'cloud'];
  return { label, icon };
}

// The two windows the panel reports a rain chance for, as [from, until) in
// local hours. Morning is the commute in and the first half of the day;
// afternoon stops at 19:00 because a chance of rain after you have gone home
// is not something a desk display can help with.
export const RAIN_WINDOWS = {
  am: [6, 12],
  pm: [15, 19],
};

// A day's icon switches to rain above this chance. Not zero: Open-Meteo
// returns single-digit probabilities on days with no rain in them at all - an
// overcast Thursday came back at 3% with 0.0mm - and the icon is the only
// weather signal on a forecast row, so at >0 it would show rain most days and
// mean nothing. Snow and storm keep their own glyph either way: swapping a
// thunderstorm for plain rain would lose the more important warning.
const RAIN_ICON_THRESHOLD = 10;
const KEEP_ICON = new Set(['snow', 'storm']);

/**
 * Peak chance of rain, and total expected fall, within one window of one day.
 *
 * Probability is the max rather than the mean: the question the panel answers
 * is "do I need a coat", not "how much of the morning is wet". Millimetres are
 * summed, because that one is a quantity.
 *
 * Hourly timestamps come back in the display timezone - the request sets
 * `timezone` - so the hour can be read straight off the string without any
 * conversion here.
 */
function windowRain(hourly, dateKey, [from, until]) {
  let probability = 0;
  let mm = 0;
  let seen = false;

  const times = hourly?.time || [];
  for (let i = 0; i < times.length; i += 1) {
    const [date, clock] = String(times[i]).split('T');
    if (date !== dateKey) continue;
    const hour = Number.parseInt(clock.slice(0, 2), 10);
    if (hour < from || hour >= until) continue;

    seen = true;
    probability = Math.max(probability, hourly.precipitation_probability?.[i] ?? 0);
    mm += hourly.precipitation?.[i] ?? 0;
  }

  // No hourly rows for the window at all - the provider dropped the field, or
  // the day is past the end of the forecast. Say nothing rather than claim 0%.
  if (!seen) return null;
  return { probability: Math.round(probability), mm };
}

/**
 * Promote a day's icon to rain when the chance is high enough to act on.
 *
 * Open-Meteo's weather code describes the dominant condition, so a day that is
 * mostly overcast with a wet afternoon comes back as `cloud`. On a forecast row
 * the icon is the only weather the panel shows, so it should carry the thing
 * worth knowing.
 */
function rainAwareIcon({ label, icon }, probability) {
  if (KEEP_ICON.has(icon)) return { label, icon };
  if ((probability ?? 0) > RAIN_ICON_THRESHOLD) return { label, icon: 'rain' };
  return { label, icon };
}

let cache = { at: 0, data: null };

/**
 * Returns null rather than throwing when the provider is unreachable.
 *
 * A dead weather API must not take the whole frame down: a panel showing the
 * date and someone's in/out status with the weather column missing is far
 * better than a panel showing a stale frame forever, or nothing at all.
 */
export async function getWeather({ force = false } = {}) {
  if (!config.weather.enabled) return null;

  const ageSeconds = (Date.now() - cache.at) / 1000;
  if (!force && cache.data && ageSeconds < config.weather.cacheSeconds) {
    return cache.data;
  }

  const { latitude, longitude } = config.location;
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('current', 'temperature_2m,weather_code');
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  );
  // Windowed rain needs the hourly series: the daily block only carries a
  // whole-day figure, which cannot be split into morning and afternoon.
  url.searchParams.set('hourly', 'precipitation_probability,precipitation');
  url.searchParams.set('timezone', config.timezone);
  url.searchParams.set('forecast_days', '4');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.weather.timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`open-meteo returned ${res.status}`);
    const json = await res.json();

    const data = {
      current: {
        temp: Math.round(json.current.temperature_2m),
        ...describeCode(json.current.weather_code),
      },
      today: {
        max: Math.round(json.daily.temperature_2m_max[0]),
        min: Math.round(json.daily.temperature_2m_min[0]),
        rain: {
          am: windowRain(json.hourly, json.daily.time[0], RAIN_WINDOWS.am),
          pm: windowRain(json.hourly, json.daily.time[0], RAIN_WINDOWS.pm),
        },
      },
      // Skip index 0: that is today, already shown as the current conditions.
      forecast: json.daily.time.slice(1, 4).map((date, i) => {
        const n = i + 1;
        return {
          day: new Date(`${date}T00:00:00`).toLocaleDateString('en-AU', {
            weekday: 'short',
            timeZone: config.timezone,
          }),
          max: Math.round(json.daily.temperature_2m_max[n]),
          min: Math.round(json.daily.temperature_2m_min[n]),
          ...rainAwareIcon(
            describeCode(json.daily.weather_code[n]),
            json.daily.precipitation_probability_max?.[n],
          ),
        };
      }),
      fetchedAt: new Date().toISOString(),
    };

    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    console.warn(`[weather] fetch failed: ${err.message}`);
    // Prefer stale data over no data; the frame carries its own timestamp so
    // staleness is visible rather than silent.
    return cache.data;
  } finally {
    clearTimeout(timer);
  }
}

export function _resetCacheForTests() {
  cache = { at: 0, data: null };
}
