/**
 * Dates in the display timezone, not UTC.
 *
 * This matters more than it looks. The ETag previously keyed on the UTC date,
 * so in Melbourne (UTC+10/+11) the frame's "day" rolled over at 10am local
 * rather than midnight. Anything that depends on which day it is - the printed
 * date, and now the weekend message - would have been correct in the render
 * but stale in the cache, so the device would have kept 304ing on Saturday
 * morning while still showing Friday's frame.
 *
 * The Kindle cannot help here: it has no tzdata for Australia/Melbourne, so
 * `TZ=... date` is silently ignored and its clock stays UTC. Anything
 * day-dependent has to be decided server-side.
 */

/** YYYY-MM-DD in the given zone. en-CA formats in ISO order. */
export function localDateKey(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 'Mon' … 'Sun' in the given zone. */
export function localWeekdayShort(now, timeZone) {
  return new Intl.DateTimeFormat('en-AU', { timeZone, weekday: 'short' }).format(now);
}

export function isWeekend(now, timeZone) {
  const day = localWeekdayShort(now, timeZone);
  return day === 'Sat' || day === 'Sun';
}
