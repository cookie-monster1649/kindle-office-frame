/**
 * What the server currently wants shown, plus the pushed content.
 *
 * Two ways the panel decides what to display:
 *
 *   device-driven   the Kindle's menu picks In office / Out of office, and
 *                   asks for that mode explicitly. A local override.
 *   server-driven   the Kindle's menu picks Show server, and asks for
 *                   mode=server. The server then answers with `display`,
 *                   which is settable over POST /status from anywhere.
 *
 * The second is the useful one for an in/out board: you decide you are
 * working from home on the way in, not while standing at the panel.
 *
 * Deliberately a single in-memory record with a version counter. There is no
 * database because there is nothing to query - the device only ever wants the
 * current frame. Persisted to disk purely so a restart does not blank the
 * panel or silently flip your status.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import { localDateKey, isWeekend } from './localdate.js';
import { config } from './config.js';

const md = new MarkdownIt({ html: false, linkify: false, typographer: true });

const STORE = process.env.STATE_PATH || process.env.CONTENT_PATH ||
  join(process.cwd(), 'data', 'state.json');

/**
 * What can be chosen. `weekend` is deliberately not in this list: it is a
 * *rule*, not a choice, driven by the weekendMode toggle. Making it a
 * selectable value as well would mean two ways to express the same thing and
 * an obvious question about which wins.
 */
export const DISPLAYS = ['in', 'out', 'text'];

const MAX_TEXT = 120;

let state = {
  display: 'in',
  // Shown when display is 'text'. Short by design: this is a headline on a
  // panel read from across a room, not a document.
  customText: '',
  // "Show away on weekends". When on, Saturday and Sunday override whatever
  // is selected.
  weekendMode: true,
  markdown: '',
  version: 0,
  updatedAt: null,
};

export async function load() {
  try {
    const parsed = JSON.parse(await readFile(STORE, 'utf8'));
    state = {
      display: DISPLAYS.includes(parsed.display) ? parsed.display : 'in',
      customText: String(parsed.customText ?? '').slice(0, MAX_TEXT),
      weekendMode: parsed.weekendMode !== false,
      markdown: parsed.markdown ?? '',
      version: parsed.version ?? 0,
      updatedAt: parsed.updatedAt ?? null,
    };
  } catch {
    // No stored state yet is the normal first run, not an error.
  }
  return get();
}

async function persist() {
  await mkdir(dirname(STORE), { recursive: true });
  await writeFile(STORE, JSON.stringify(state, null, 2), 'utf8');
}

export function get() {
  return { ...state };
}

/**
 * Apply any subset of the settings. Returns null with a reason if a value is
 * rejected, so callers can say what was wrong rather than failing opaquely.
 *
 * Everything goes through one function because every change has to bump the
 * same version counter - that counter is what invalidates the device's cached
 * frame, and a change that forgot to bump it would simply never reach the
 * panel.
 */
export async function update({ display, text, weekendMode }) {
  const next = { ...state };

  if (display !== undefined) {
    if (!DISPLAYS.includes(display)) {
      return { error: 'unknown display', allowed: DISPLAYS, received: display };
    }
    next.display = display;
  }

  if (text !== undefined) {
    next.customText = String(text).slice(0, MAX_TEXT);
    // Setting text is almost always meant as "show this now", so save the
    // extra call rather than leaving the panel unchanged and puzzling.
    if (display === undefined && next.customText) next.display = 'text';
  }

  if (weekendMode !== undefined) {
    next.weekendMode = Boolean(weekendMode);
  }

  state = {
    ...next,
    version: state.version + 1,
    updatedAt: new Date().toISOString(),
  };
  await persist();
  return { state: get() };
}

/**
 * What should actually be shown, once the weekend rule is applied.
 *
 * The toggle wins over the selection: that is the point of it. Turn it off if
 * you work weekends.
 *
 * The Kindle cannot decide this itself - its clock is UTC and it ships no
 * tzdata - so the day is always resolved here, in the display timezone.
 */
export function effectiveDisplay(now = new Date()) {
  if (state.weekendMode && isWeekend(now, config.timezone)) return 'weekend';
  return state.display;
}

/** Whether the weekend rule is currently overriding the selection. */
export function isAutoWeekend(now = new Date()) {
  return state.weekendMode && isWeekend(now, config.timezone);
}

/**
 * Markdown is stored and rendered but not yet reachable: `mode=server`
 * resolves to in/out only. Kept wired and tested so adding a 'text' display
 * later is a small change rather than a rebuild.
 */
export async function setMarkdown(markdown) {
  state = {
    ...state,
    markdown: String(markdown ?? ''),
    version: state.version + 1,
    updatedAt: new Date().toISOString(),
  };
  await persist();
  return get();
}

export function renderHtml(markdown = state.markdown) {
  return md.render(markdown || '');
}

/**
 * Resolve a requested mode to what should actually be drawn.
 *
 * `in` and `out` are the device overriding the server. `server` hands the
 * decision back, which is the whole point of that menu option.
 */
export function resolveMode(requested, now = new Date()) {
  return requested === 'server' ? effectiveDisplay(now) : requested;
}

/**
 * ETag inputs: everything that changes what the frame *says*, and nothing
 * that does not.
 *
 * Deliberately excluded:
 *
 *   the current time  Including it would change the ETag every minute, so
 *                     every poll would return 200 and repaint the panel,
 *                     defeating the point of conditional requests.
 *   weather.fetchedAt Moves on every cache refresh even when the readings are
 *                     identical, which would churn the ETag for nothing.
 *
 * The rendered "updated" stamp therefore shows when the frame was last
 * genuinely re-rendered, not when it was last requested. If the server dies,
 * the panel keeps its old stamp and the staleness is visible rather than
 * silently refreshed.
 *
 * The date is included so the frame turns over at midnight - and it is the
 * date in the *display* timezone, not UTC. Keying on the UTC date would roll
 * the frame over at 10am Melbourne time, so Saturday's weekend message would
 * not reach a device that kept 304ing until then.
 *
 * The *effective* mode is hashed, not the requested one, so a status change
 * made over POST /status invalidates the cache for a device asking for
 * `server`.
 */
export function etagFor({ mode, orientation, weather, now = new Date() }) {
  const h = createHash('sha256');
  // The resolved display already folds in the weekend rule and the local
  // date, so hashing it covers both without a separate weekend term.
  h.update(String(resolveMode(mode, now)));
  h.update(String(orientation));
  h.update(String(state.version));
  h.update(localDateKey(now, config.timezone));

  if (weather) {
    const { fetchedAt, ...significant } = weather;
    h.update(JSON.stringify(significant));
  } else {
    h.update('no-weather');
  }

  // Weak validator: two renders of the same inputs are equivalent for display
  // purposes even if the PNG bytes differ by a dither detail.
  return `W/"${h.digest('hex')}"`;
}
