import { describe, expect, it } from 'vitest';
import type { OutboxRow } from '@taskflow/db';
import { callWakeEvent } from './call-wake.js';

/**
 * `callWakeEvent` — the one piece of `call-wake.ts` that needs no database to
 * test. `drainCallWake` itself is `withAuditScope`-backed, the same split
 * `expo-push.test.ts`'s own header explains: real coverage for that half
 * lives against a real Postgres instance, which this sandbox does not have.
 */

const ALICE = '0195ee05-0000-7000-8000-000000000001';
const BOB = '0195ee05-0000-7000-8000-000000000002';

/** An outbox row shaped like the relay produces, with an overridable payload — mirrors `notification.projection.test.ts`'s own `row()`. */
function row(name: string, payload: unknown): OutboxRow {
  return {
    id: '0195ee05-0000-7000-8000-0000000000ff',
    orgId: '0195ee05-0000-7000-8000-00000000000a',
    name,
    version: 1,
    actorId: ALICE,
    occurredAt: new Date(),
    requestId: null,
    causationDepth: 0,
    payload,
    attempts: 0,
  };
}

describe('callWakeEvent', () => {
  it('reads channelId and invitedUserIds off a real rtc_session.started row', () => {
    const event = callWakeEvent(
      row('rtc_session.started', {
        sessionId: '0195ee05-0000-7000-8000-000000000030',
        channelId: '0195ee05-0000-7000-8000-000000000020',
        kind: 'audio',
        invitedCount: 2,
        invitedUserIds: [ALICE, BOB],
      }),
    );

    expect(event).toEqual({
      channelId: '0195ee05-0000-7000-8000-000000000020',
      invitedUserIds: [ALICE, BOB],
    });
  });

  it('ignores every other event name', () => {
    expect(
      callWakeEvent(row('rtc_session.ended', { channelId: 'x', invitedUserIds: [ALICE] })),
    ).toBeNull();
    expect(
      callWakeEvent(row('message.sent', { channelId: 'x', invitedUserIds: [ALICE] })),
    ).toBeNull();
  });

  it('rejects a payload missing channelId', () => {
    expect(callWakeEvent(row('rtc_session.started', { invitedUserIds: [ALICE] }))).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(callWakeEvent(row('rtc_session.started', null))).toBeNull();
    expect(callWakeEvent(row('rtc_session.started', 'not an object'))).toBeNull();
  });

  it('defaults invitedUserIds to empty when absent or malformed, rather than throwing', () => {
    expect(callWakeEvent(row('rtc_session.started', { channelId: 'x' }))).toEqual({
      channelId: 'x',
      invitedUserIds: [],
    });

    expect(
      callWakeEvent(row('rtc_session.started', { channelId: 'x', invitedUserIds: 'not-an-array' })),
    ).toEqual({ channelId: 'x', invitedUserIds: [] });
  });

  it('filters non-string entries out of invitedUserIds rather than rejecting the whole row', () => {
    expect(
      callWakeEvent(
        row('rtc_session.started', { channelId: 'x', invitedUserIds: [ALICE, 42, null, BOB] }),
      ),
    ).toEqual({ channelId: 'x', invitedUserIds: [ALICE, BOB] });
  });
});
