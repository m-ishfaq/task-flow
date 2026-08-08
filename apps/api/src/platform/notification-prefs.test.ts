import { describe, expect, it } from 'vitest';
import { categoryOfKind, resolvePref } from './notification-prefs.js';

describe('categoryOfKind', () => {
  it('buckets every registered kind', () => {
    expect(categoryOfKind('chat.mention')).toBe('direct');
    expect(categoryOfKind('chat.direct')).toBe('direct');
    expect(categoryOfKind('chat.thread_reply')).toBe('activity');
    expect(categoryOfKind('card.assigned')).toBe('direct');
    expect(categoryOfKind('card.comment_mention')).toBe('direct');
    expect(categoryOfKind('card.due_soon')).toBe('activity');
    expect(categoryOfKind('page.comment_mention')).toBe('direct');
  });

  it('falls back to the conservative default for an unknown kind', () => {
    // Should not happen — every registered kind has an entry — but a bug that
    // adds a kind without a category must not crash the projection.
    expect(categoryOfKind('something.unregistered')).toBe('activity');
  });
});

describe('resolvePref', () => {
  it('uses the coded default when no explicit row exists', () => {
    expect(resolvePref([], 'direct', 'email')).toBe(true);
    expect(resolvePref([], 'direct', 'sms')).toBe(false);
    expect(resolvePref([], 'activity', 'email')).toBe(false);
    expect(resolvePref([], 'activity', 'push')).toBe(false);
  });

  it('an explicit row always wins over the default', () => {
    expect(
      resolvePref([{ category: 'direct', channel: 'email', enabled: false }], 'direct', 'email'),
    ).toBe(false);
    expect(
      resolvePref([{ category: 'activity', channel: 'email', enabled: true }], 'activity', 'email'),
    ).toBe(true);
  });

  it('an explicit row for a DIFFERENT cell does not leak into this one', () => {
    expect(
      resolvePref([{ category: 'direct', channel: 'email', enabled: false }], 'direct', 'push'),
    ).toBe(true); // still the default for direct/push
    expect(
      resolvePref([{ category: 'direct', channel: 'email', enabled: false }], 'activity', 'email'),
    ).toBe(false); // still the default for activity/email
  });
});
