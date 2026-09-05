/**
 * Configuration, all overridable by environment.
 *
 * The device geometry is not configurable: the PW3 framebuffer is always
 * 1072x1448 regardless of how the device is held, and eips paints into that
 * buffer directly. "Landscape" therefore means composing at 1448x1072 and
 * rotating into the portrait buffer, which the renderer handles.
 */

export const DEVICE = {
  width: 1072,
  height: 1448,
  // The panel has 16 fixed grey levels. Quantising to an adaptive palette
  // instead produces levels the hardware cannot actually display, so the
  // device ends up doing its own, worse, conversion.
  greyLevels: 16,
  dpi: 300,
};

export function logicalSize(orientation) {
  return orientation === 'landscape'
    ? { width: DEVICE.height, height: DEVICE.width }
    : { width: DEVICE.width, height: DEVICE.height };
}

const int = (v, d) => (v === undefined ? d : Number.parseInt(v, 10));

export const config = {
  port: int(process.env.PORT, 8080),

  // Two tokens, because the two sides have genuinely different threat models.
  //
  // The read token lives on the Kindle - a device that sits unattended on a
  // desk, may be somewhere you do not control, and could be lost or taken. It
  // must not be able to change anything, only fetch frames.
  //
  // The write token sets your status and lives wherever you actually push
  // from: a phone shortcut, a script, Home Assistant. The Kindle never sees
  // it.
  //
  // FRAME_TOKEN remains as a fallback for both so existing deployments keep
  // working, but setting the two separately is the point.
  readToken:
    process.env.FRAME_READ_TOKEN || process.env.FRAME_TOKEN || 'dev-token-change-me',
  writeToken:
    process.env.FRAME_WRITE_TOKEN || process.env.FRAME_TOKEN || 'dev-token-change-me',

  timezone: process.env.TZ_NAME || 'Australia/Melbourne',

  location: {
    name: process.env.LOCATION_NAME || 'Melbourne',
    latitude: Number.parseFloat(process.env.LATITUDE || '-37.8136'),
    longitude: Number.parseFloat(process.env.LONGITUDE || '144.9631'),
  },

  // Whose name appears on the in/out cards.
  personName: process.env.PERSON_NAME || 'JJ',

  weather: {
    // Open-Meteo needs no API key, which keeps this deployable without
    // secret management. Swap the provider in weather.js if you'd rather
    // pull from Home Assistant.
    enabled: process.env.WEATHER_ENABLED !== 'false',
    // Weather changes slowly and the panel refreshes every 15 minutes;
    // there is no reason to hit the API on every request.
    cacheSeconds: int(process.env.WEATHER_CACHE_SECONDS, 900),
    timeoutMs: int(process.env.WEATHER_TIMEOUT_MS, 8000),
  },
};

export const MODES = ['server', 'in', 'out', 'weekend'];
export const ORIENTATIONS = ['portrait', 'landscape'];
