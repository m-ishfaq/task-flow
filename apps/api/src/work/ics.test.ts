import { describe, expect, it } from 'vitest';
import { formatIcsFeed } from './ics.js';
import type { FeedCard } from './calendar-feed.service.js';

const NOW = new Date('2026-03-15T09:15:00Z');

function card(overrides: Partial<FeedCard> = {}): FeedCard {
  return {
    orgId: 'org-1',
    cardId: 'card-1',
    reference: 'WEB-142',
    title: 'Fix login redirect',
    dueDate: '2026-03-20',
    url: 'https://app.example.test/boards/board-1?view=board&card=card-1&project=proj-1',
    ...overrides,
  };
}

describe('formatIcsFeed', () => {
  it('produces a well-formed empty calendar for no cards', () => {
    const ics = formatIcsFeed([], NOW);
    expect(ics).toBe(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//TaskFlow//Calendar Feed//EN',
        'CALSCALE:GREGORIAN',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
  });

  it('uses CRLF line endings throughout, per RFC 5545', () => {
    const ics = formatIcsFeed([card()], NOW);
    expect(ics).not.toContain('\n\n');
    expect(ics.split('\r\n').every((line) => !line.includes('\n'))).toBe(true);
  });

  it('renders one all-day VEVENT per card, with no time component', () => {
    const ics = formatIcsFeed([card()], NOW);
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260320');
    expect(ics).toContain('UID:card-1@taskflow');
    expect(ics).toContain('SUMMARY:WEB-142 Fix login redirect');
    expect(ics).toContain(
      'URL:https://app.example.test/boards/board-1?view=board&card=card-1&project=proj-1',
    );
    expect(ics).toContain('END:VEVENT');
  });

  it('stamps DTSTAMP as a bare UTC timestamp with no separators', () => {
    const ics = formatIcsFeed([card()], NOW);
    expect(ics).toContain('DTSTAMP:20260315T091500Z');
  });

  it('never emits a DESCRIPTION field — the feed carries no card content', () => {
    const ics = formatIcsFeed([card({ title: 'Something with a description-like body' })], NOW);
    expect(ics).not.toContain('DESCRIPTION');
  });

  it('escapes commas, semicolons and backslashes in the title', () => {
    const ics = formatIcsFeed([card({ title: 'Fix a, b; and c\\d' })], NOW);
    expect(ics).toContain('SUMMARY:WEB-142 Fix a\\, b\\; and c\\\\d');
  });

  it('renders every card, in the order given', () => {
    const ics = formatIcsFeed(
      [
        card({ cardId: 'card-1', reference: 'WEB-1' }),
        card({ cardId: 'card-2', reference: 'WEB-2' }),
      ],
      NOW,
    );
    const firstIndex = ics.indexOf('WEB-1');
    const secondIndex = ics.indexOf('WEB-2');
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });
});
