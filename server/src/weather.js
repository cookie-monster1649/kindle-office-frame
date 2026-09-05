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
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min');
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
          ...describeCode(json.daily.weather_code[n]),
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
