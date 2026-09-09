import type { FeedCard } from './calendar-feed.service.js';

/**
 * Rendering a personal calendar feed as ICS text (RFC 5545) — the pure half
 * of the calendar-sync feature, split out so it can be tested directly
 * against real `FeedCard` fixtures rather than only through a live route.
 *
 * Deliberately minimal: `SUMMARY` and `URL` only, no `DESCRIPTION` — this
 * URL sits in a place (Google/Outlook/Apple's own server-side subscription
 * storage) this deployment cannot control or audit, so the feed carries the
 * least content that is still useful. An all-day event (`DTSTART;VALUE=DATE`,
 * no time component) — a card's due date has no time of day in this
 * product, and inventing midnight would imply a precision the data does
 * not have.
 */

/** Line folding, escaping and the CRLF line endings RFC 5545 §3.1 requires. */
function escapeText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll('\n', '\\n');
}

/** `20260315T091500Z` — UTC, no separators, the one DTSTAMP format every reader accepts. */
function stampOf(now: Date): string {
  // "2026-03-15T09:15:00.000Z" -> "20260315T091500Z": strip the punctuation,
  // then the milliseconds (always exactly ".000" from toISOString's own
  // fixed-width output), rather than indexing into a split() result that
  // `noUncheckedIndexedAccess` would type as possibly undefined.
  return now.toISOString().replace(/[-:]/g, '').replace('.000', '');
}

/** `20260315` from a `YYYY-MM-DD` due date — an all-day event has no time component at all. */
function dateOf(isoDate: string): string {
  return isoDate.replaceAll('-', '');
}

export function formatIcsFeed(cards: readonly FeedCard[], now: Date = new Date()): string {
  const stamp = stampOf(now);

  const events = cards.map((card) =>
    [
      'BEGIN:VEVENT',
      `UID:${card.cardId}@taskflow`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dateOf(card.dueDate)}`,
      `SUMMARY:${escapeText(`${card.reference} ${card.title}`)}`,
      `URL:${escapeText(card.url)}`,
      'END:VEVENT',
    ].join('\r\n'),
  );

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TaskFlow//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
}
