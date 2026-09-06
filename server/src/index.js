/**
 * Frame server.
 *
 * Two endpoints, deliberately. There is no UI, no database and no user model:
 * content is pushed from elsewhere and the device only ever wants the current
 * frame. Every feature not built is one that cannot break in six months.
 *
 *   GET  /                          control page (three buttons)
 *   GET  /frame.png?mode=&orient=   the rendered frame, with ETag support
 *   GET  /status                    current and effective display
 *   POST /status                    set what `mode=server` shows
 *   POST /content                   push markdown (stored, not yet displayed)
 *   GET  /healthz                   liveness
 */

import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config, MODES, ORIENTATIONS } from './config.js';
import * as store from './store.js';
import { DISPLAYS } from './store.js';
import { getWeather } from './weather.js';
import { buildTree } from './templates/frame.js';
import { renderFrame, closeBrowser } from './render.js';
import { controlPage } from './templates/ui.js';

const app = express();
app.disable('x-powered-by');

const pick = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

/**
 * UI session.
 *
 * The control page carries no token, by design: it is meant to be opened and
 * used, not to have a secret pasted into it each time. So `GET /` issues a
 * random session cookie and the UI's writes are authorised by that instead.
 *
 * Be clear about what this is and is not. It is NOT authentication - anyone
 * who can reach `GET /` can drive the panel. **The control page must be
 * protected at the proxy** (Cloudflare Access, NPM basic auth, or LAN-only).
 *
 * What it does buy is CSRF protection: SameSite=Strict means another site
 * cannot make your browser POST here, which an entirely open endpoint would
 * allow. The Kindle's read token remains unable to write either way.
 */
const UI_SESSION = randomBytes(24).toString('hex');
const UI_COOKIE = 'frame_ui';

function hasUiSession(req) {
  const raw = req.headers.cookie || '';
  const found = raw.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${UI_COOKIE}=`));
  if (!found) return false;
  const value = found.slice(UI_COOKIE.length + 1);
  const a = Buffer.from(value);
  const b = Buffer.from(UI_SESSION);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Reading a frame. The Kindle holds this token, so it must not unlock
 * anything else: the device is unattended, possibly somewhere you do not
 * control, and could be lost.
 *
 * The write token is accepted here too, so a single-token setup and a
 * hands-on debugging session both still work.
 */
function canRead(req) {
  const t = bearer(req);
  return t === config.readToken || t === config.writeToken || hasUiSession(req);
}

/**
 * Changing state: the write token, or the control page's session.
 * Deliberately never satisfied by the device's read token.
 */
function canWrite(req) {
  return bearer(req) === config.writeToken || hasUiSession(req);
}

/**
 * The control page's previews. Deliberately not satisfied by the device's read
 * token: the previews exist for the browser, and keeping the read token out
 * means this path cannot be used to sidestep the Access scoping on /frame.png.
 */
function canPreview(req) {
  return hasUiSession(req) || bearer(req) === config.writeToken;
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/**
 * The control page. Served without auth deliberately: it is inert markup that
 * exposes no state until the browser supplies a token, and leaving it open
 * means it can be bookmarked or added to a phone home screen.
 */
app.get('/', (_req, res) => {
  // Set the header directly rather than via res.cookie, so this does not
  // depend on cookie-parser being installed.
  res.setHeader('Set-Cookie',
    `${UI_COOKIE}=${UI_SESSION}; HttpOnly; SameSite=Strict; Path=/`);
  res.type('html').send(controlPage({ personName: config.personName }));
});

async function serveFrame(req, res) {
  const mode = pick(req.query.mode, MODES, 'in');
  const orientation = pick(req.query.orient, ORIENTATIONS, 'portrait');

  try {
    const weather = await getWeather();
    const etag = store.etagFor({ mode, orientation, weather });

    res.set('Cache-Control', 'no-cache');
    res.set('ETag', etag);

    // Answer conditional requests before doing any rendering work. This is
    // the common path: most polls find nothing changed.
    if (req.get('if-none-match') === etag) return res.status(304).end();

    const tree = buildTree({
      // `server` hands the decision back to us, including the weekend rule;
      // in/out/weekend from the device are explicit overrides.
      mode: store.resolveMode(mode),
      orientation,
      weather,
      markdown: store.get().markdown,
      customText: store.get().customText,
    });

    const png = await renderFrame({ tree, orientation });

    res.set('Content-Type', 'image/png');
    res.set('Content-Length', String(png.length));
    return res.send(png);
  } catch (err) {
    console.error('[frame] render failed:', err);
    return res.status(500).json({ error: 'render failed' });
  }
}

/**
 * The read endpoint is authenticated too. It is reachable from the public
 * internet through the tunnel, and the frame carries someone's location and
 * whereabouts.
 */
app.get('/frame.png', async (req, res) => {
  if (!canRead(req)) return res.status(401).json({ error: 'unauthorized' });
  return serveFrame(req, res);
});

/**
 * The same bytes as /frame.png, for the control page's previews, served from a
 * path with no `.png` extension. That is deliberate: two separate things key
 * off the extension and each breaks the previews on its own.
 *
 *   - Cloudflare Access. DEPLOY.md scopes a Service Auth application to
 *     /frame.png so a lost device unlocks nothing else. Access matches the most
 *     specific path first, and Service Auth has no interactive fallback - so a
 *     browser holding a perfectly valid SSO session still gets a hard 403, and
 *     the previews the control page promises can never load.
 *   - nginx-proxy-manager's asset caching, which matches on extension and
 *     shared-caches *.png under a key of $host$request_uri carrying no auth
 *     component, ignores the origin's Cache-Control, and stores error statuses
 *     for 30 minutes.
 *
 * Widening the Access application to the whole hostname would also fix the
 * previews, but it would let a stolen device token reach `GET /`, which hands
 * out a session cookie that authorises writes. This keeps that door shut.
 */
app.get('/preview', async (req, res) => {
  if (!canPreview(req)) return res.status(401).json({ error: 'unauthorized' });
  return serveFrame(req, res);
});

// HEAD is what the device actually polls with: it carries the ETag and costs
// a few hundred bytes. Express routes HEAD to the GET handler by default, but
// only after running it, so answer it explicitly and skip the render.
app.head('/frame.png', async (req, res) => {
  if (!canRead(req)) return res.status(401).end();

  const mode = pick(req.query.mode, MODES, 'in');
  const orientation = pick(req.query.orient, ORIENTATIONS, 'portrait');

  try {
    const weather = await getWeather();
    const etag = store.etagFor({ mode, orientation, weather });
    res.set('Cache-Control', 'no-cache');
    res.set('ETag', etag);
    res.set('Content-Type', 'image/png');
    return res.status(req.get('if-none-match') === etag ? 304 : 200).end();
  } catch (err) {
    console.error('[frame] head failed:', err);
    return res.status(500).end();
  }
});

/**
 * Set what the panel shows when the device is in `Show server` mode. This is
 * the endpoint to hit from a phone: the point of an in/out board is being
 * able to change it when you are not standing in front of it.
 */
/**
 * Pull the requested display out of whatever shape the caller sent:
 *   {"display":"out"}      JSON
 *   display=out            form-encoded, or a Slack slash command's `text`
 *   out                    a bare string body
 *   /status/out            the path form below
 */
function readDisplay(req) {
  if (req.params?.display) return String(req.params.display).trim().toLowerCase();
  if (typeof req.body === 'string') return req.body.trim().toLowerCase();
  const v = req.body?.display ?? req.body?.state;
  return v === undefined ? undefined : String(v).trim().toLowerCase();
}

function statusBody() {
  const { display, customText, weekendMode, version, updatedAt } = store.get();
  return {
    // What was selected.
    display,
    customText,
    weekendMode,
    // What the panel will actually show, once the weekend rule is applied.
    effective: store.resolveMode('server'),
    // True when the weekend rule is overriding the selection, so a caller can
    // explain an unexpected panel without reading the source.
    autoWeekend: store.isAutoWeekend(),
    version,
    updatedAt,
  };
}

/**
 * Body parsers, in order. Integrations vary in what they can send: Home
 * Assistant's rest_command does JSON easily, Slack posts form-encoded, and a
 * few webhook senders can only manage a bare string. Accepting all three
 * costs two lines and removes a whole class of "why is it 400" support.
 */
const statusBody_ = [
  express.json({ limit: '4kb' }),
  express.urlencoded({ extended: false, limit: '4kb' }),
  express.text({ type: 'text/*', limit: '4kb' }),
];

app.post('/status', statusBody_, async (req, res) => {
  if (!canWrite(req)) return res.status(403).json({ error: 'forbidden' });

  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const display = readDisplay(req);

  // `text` doubles as Slack's slash-command argument. Treat it as a display
  // name when it names one, and as custom text otherwise.
  const raw = body.text;
  const looksLikeDisplay =
    typeof raw === 'string' && DISPLAYS.includes(raw.trim().toLowerCase());

  const patch = {};
  if (display !== undefined) patch.display = display;
  if (raw !== undefined) {
    if (looksLikeDisplay) patch.display = raw.trim().toLowerCase();
    else patch.text = raw;
  }
  if (body.weekendMode !== undefined) {
    patch.weekendMode = body.weekendMode === true || body.weekendMode === 'true';
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({
      error: 'nothing to change',
      accepts: ['display', 'text', 'weekendMode'],
      allowed: DISPLAYS,
    });
  }

  const result = await store.update(patch);
  if (result.error) return res.status(400).json(result);
  return res.json({ ok: true, ...statusBody() });
});

/**
 * Path form: POST /status/out
 *
 * The lowest-effort integration surface there is - no body, no content type,
 * no JSON encoding. Everything that can send an authenticated POST can do
 * this, including Home Assistant's rest_command and a phone shortcut.
 */
app.post('/status/:display', async (req, res) => {
  if (!canWrite(req)) return res.status(403).json({ error: 'forbidden' });
  const result = await store.update({ display: readDisplay(req) });
  if (result.error) return res.status(400).json(result);
  return res.json({ ok: true, ...statusBody() });
});

app.get('/status', (req, res) => {
  if (!canRead(req)) return res.status(401).json({ error: 'unauthorized' });
  return res.json(statusBody());
});

/**
 * Markdown is stored but not yet displayed: `mode=server` resolves to in/out
 * only. Kept so enabling a 'text' display later is a small change.
 */
app.post('/content', express.text({ type: '*/*', limit: '256kb' }), async (req, res) => {
  if (!canWrite(req)) return res.status(403).json({ error: 'forbidden' });
  const updated = await store.setMarkdown(typeof req.body === 'string' ? req.body : '');
  return res.json({ ok: true, version: updated.version, updatedAt: updated.updatedAt });
});

app.get('/content', (req, res) => {
  if (!canRead(req)) return res.status(401).json({ error: 'unauthorized' });
  return res.json(store.get());
});

async function main() {
  await store.load();

  if (config.readToken === 'dev-token-change-me' || config.writeToken === 'dev-token-change-me') {
    console.warn('[config] tokens unset; using the development default.');
  }
  console.warn(
    '[security] the control page at / is not authenticated: anyone who can ' +
    'reach it can change the panel. Put it behind your proxy (Cloudflare ' +
    'Access, basic auth, or LAN-only).'
  );
  if (config.readToken === config.writeToken) {
    console.warn(
      '[config] read and write tokens are identical, so the Kindle can change ' +
      'your status. Set FRAME_READ_TOKEN and FRAME_WRITE_TOKEN separately.'
    );
  }

  const server = app.listen(config.port, () => {
    console.log(`frame server on :${config.port} (${config.location.name}, ${config.timezone})`);
  });

  const shutdown = async () => {
    server.close();
    await closeBrowser();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only start a listener when run directly, so tests can import the app.
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { app };
