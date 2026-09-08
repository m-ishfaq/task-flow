import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearPendingNext,
  inviteTokenFromNext,
  peekPendingNext,
  storePendingNext,
} from './pending-next.js';

beforeEach(() => {
  window.localStorage.clear();
});

describe('inviteTokenFromNext', () => {
  it('extracts the token from an /invite/accept next path', () => {
    expect(inviteTokenFromNext('/invite/accept?token=abc123')).toBe('abc123');
  });

  it('returns undefined for a next path that is not /invite/accept', () => {
    expect(inviteTokenFromNext('/projects')).toBeUndefined();
  });

  it('returns undefined when next is undefined', () => {
    expect(inviteTokenFromNext(undefined)).toBeUndefined();
  });

  it('returns undefined for /invite/accept with no token', () => {
    expect(inviteTokenFromNext('/invite/accept')).toBeUndefined();
  });

  it('returns undefined for /invite/accept with an empty token', () => {
    expect(inviteTokenFromNext('/invite/accept?token=')).toBeUndefined();
  });

  it('URL-decodes the token', () => {
    expect(inviteTokenFromNext('/invite/accept?token=a%2Bb')).toBe('a+b');
  });
});

describe('storePendingNext / peekPendingNext / clearPendingNext', () => {
  it('round-trips a stored value', () => {
    storePendingNext('/invite/accept?token=xyz');
    expect(peekPendingNext()).toBe('/invite/accept?token=xyz');
  });

  it('peek does not consume — calling it twice returns the same value', () => {
    storePendingNext('/invite/accept?token=xyz');
    expect(peekPendingNext()).toBe('/invite/accept?token=xyz');
    expect(peekPendingNext()).toBe('/invite/accept?token=xyz');
  });

  it('clear removes the stored value', () => {
    storePendingNext('/invite/accept?token=xyz');
    clearPendingNext();
    expect(peekPendingNext()).toBeNull();
  });

  it('clearing when nothing was stored is a harmless no-op', () => {
    expect(() => {
      clearPendingNext();
    }).not.toThrow();
    expect(peekPendingNext()).toBeNull();
  });

  it('peek returns null when nothing was ever stored', () => {
    expect(peekPendingNext()).toBeNull();
  });
});
