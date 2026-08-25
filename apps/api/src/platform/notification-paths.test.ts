import { describe, expect, it } from 'vitest';
import { notificationPath } from './notification-paths.js';

/**
 * `notificationPath`'s closed switch decides, for every notification kind,
 * whether a delivery has anywhere to open. A missing case does not error —
 * it silently returns `null`, which `notification-push.ts` reads as
 * "nothing to send to" and `notification.projection.ts` reads as "no email
 * delivery row at all" (`path !== null` gates both). `operator_broadcast`
 * shipped with `subjectType: 'operator_broadcast'` and no case here, so
 * every broadcast's push was marked `failed` on sight and no email
 * delivery row was ever written for the event-driven path either — this
 * pure function is cheap enough to have had a test from the start, and its
 * absence is exactly why that went unnoticed.
 */
describe('notificationPath', () => {
  it('resolves operator_broadcast to a real, non-null path', () => {
    const path = notificationPath({
      subjectType: 'operator_broadcast',
      subjectId: 'broadcast-1',
      channelId: null,
      boardId: null,
    });
    expect(path).not.toBeNull();
    expect(path).toBe('/home');
  });

  it('returns null for a subjectType this switch has no case for', () => {
    const path = notificationPath({
      subjectType: 'not-a-real-kind',
      subjectId: 'x',
      channelId: null,
      boardId: null,
    });
    expect(path).toBeNull();
  });

  it('resolves message/card/call to null when their required id is missing', () => {
    expect(
      notificationPath({ subjectType: 'message', subjectId: 'x', channelId: null, boardId: null }),
    ).toBeNull();
    expect(
      notificationPath({ subjectType: 'card', subjectId: 'x', channelId: null, boardId: null }),
    ).toBeNull();
    expect(
      notificationPath({ subjectType: 'call', subjectId: 'x', channelId: null, boardId: null }),
    ).toBeNull();
  });
});
