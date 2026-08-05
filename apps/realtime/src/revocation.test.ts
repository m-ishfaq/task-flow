import { describe, expect, it } from 'vitest';
import { createLogger } from '@taskflow/observability';
import type { OrgId, UserId } from '@taskflow/contracts';
import { applyRevocation, revocationOf } from './revocation.js';
import type { GatewayServer, GatewaySocket } from './socket-data.js';
import type { OutboxRow } from '@taskflow/db';

/**
 * Keeping a long-lived connection honest (ai/phase-4-realtime.md §3.3, §7.2,
 * §6.4).
 *
 * §6.4: "a force-disconnect test for at least one of the §3.3 events." Below
 * is one for EACH half of §7.2's split — `session.revoked` (full disconnect)
 * and `member.removed` (leaves only the affected org's rooms) — because the
 * split itself, not merely that *something* disconnects, is the property this
 * module exists to get right: kicking a user off every board they had open
 * over a revoked SHARE would be a correctness bug the same shape as the one
 * this test suite is here to prevent.
 *
 * `recheck_user` / `recheck_org` (the `grant.revoked` / `member.role_changed`
 * path) call the real `authorizeJoin`, which needs real Postgres — that
 * variant lives in `revocation.recheck.test.ts`, not here.
 */

const logger = createLogger({ name: 'revocation-test', level: 'silent' });

const ORG = 'org-1' as OrgId;
const OTHER_ORG = 'org-2' as OrgId;
const USER = 'user-1' as UserId;
const OTHER_USER = 'user-2' as UserId;

function eventFor(name: string, payload: Record<string, unknown>): OutboxRow {
  return {
    id: 'evt-1',
    orgId: ORG,
    name,
    version: 1,
    actorId: null,
    occurredAt: new Date(),
    requestId: null,
    payload,
    attempts: 0,
  };
}

describe('revocationOf', () => {
  it('maps session.revoked to a session revocation', () => {
    expect(revocationOf(eventFor('session.revoked', { sessionId: 'sess-1' }))).toEqual({
      kind: 'session',
      sessionId: 'sess-1',
      reason: 'session_revoked',
    });
  });

  /**
   * §7.2's own header names this specifically: the spec first wrote the event
   * as `token.reuse_detected`, and the real definition
   * (`apps/api/src/identity/events.ts`) is `session.token_reuse_detected`. A
   * name that does not exist produces no error anywhere — it simply never
   * matches — so this is the test that would have caught that exact mismatch.
   */
  it('maps session.token_reuse_detected to a session revocation', () => {
    expect(revocationOf(eventFor('session.token_reuse_detected', { sessionId: 'sess-1' }))).toEqual(
      {
        kind: 'session',
        sessionId: 'sess-1',
        reason: 'token_reuse_detected',
      },
    );
  });

  it('maps member.removed to member_removed, scoped to the event’s org', () => {
    expect(revocationOf(eventFor('member.removed', { userId: 'user-9' }))).toEqual({
      kind: 'member_removed',
      orgId: ORG,
      userId: 'user-9',
    });
  });

  it('maps member.role_changed to a per-user recheck', () => {
    expect(revocationOf(eventFor('member.role_changed', { userId: 'user-9' }))).toEqual({
      kind: 'recheck_user',
      orgId: ORG,
      userId: 'user-9',
    });
  });

  it('maps a grant.revoked naming a user subject to a per-user recheck', () => {
    expect(
      revocationOf(eventFor('grant.revoked', { subjectType: 'user', subjectId: 'user-9' })),
    ).toEqual({ kind: 'recheck_user', orgId: ORG, userId: 'user-9' });
  });

  it('maps a grant.revoked naming a TEAM subject to an org-wide recheck', () => {
    // Expanding a team grant to its members here would mean reading the very
    // relation the event says just changed — recheck_org is correct without
    // needing to know who was in the team.
    expect(
      revocationOf(eventFor('grant.revoked', { subjectType: 'team', subjectId: 'team-1' })),
    ).toEqual({ kind: 'recheck_org', orgId: ORG });
  });

  it('falls back to an org-wide recheck when a grant.revoked names no subject', () => {
    expect(revocationOf(eventFor('grant.revoked', {}))).toEqual({
      kind: 'recheck_org',
      orgId: ORG,
    });
  });

  it('returns null for an event this table does not describe', () => {
    expect(revocationOf(eventFor('card.moved', { boardId: 'board-1' }))).toBeNull();
  });

  it('returns null rather than guess when the expected field is missing', () => {
    expect(revocationOf(eventFor('session.revoked', {}))).toBeNull();
    expect(revocationOf(eventFor('member.removed', {}))).toBeNull();
  });
});

/** A socket recording enough to assert on, satisfying just what applyRevocation reads. */
function fakeSocket(userId: UserId, sessionId: string, rooms: [string, OrgId][]) {
  const emitted: { event: string; payload: unknown }[] = [];
  const left: string[] = [];
  let disconnected = false;

  const socket = {
    data: {
      identity: { userId, sessionId },
      rooms: new Map(rooms),
      address: '127.0.0.1',
    },
    emit: (event: string, payload: unknown) => {
      emitted.push({ event, payload });
    },
    leave: (room: string) => {
      left.push(room);
    },
    disconnect: (_close: boolean) => {
      disconnected = true;
    },
  };

  return {
    socket: socket as unknown as GatewaySocket,
    emitted,
    left,
    isDisconnected: () => disconnected,
  };
}

function fakeIo(sockets: GatewaySocket[]): GatewayServer {
  const map = new Map(sockets.map((socket, index) => [String(index), socket]));
  return { sockets: { sockets: map } } as unknown as GatewayServer;
}

describe('applyRevocation', () => {
  it('a session revocation disconnects only the matching session, and only after emitting session:ended', async () => {
    const target = fakeSocket(USER, 'sess-target', [['board-1', ORG]]);
    const bystander = fakeSocket(OTHER_USER, 'sess-other', [['board-1', ORG]]);

    await applyRevocation(
      fakeIo([target.socket, bystander.socket]),
      { kind: 'session', sessionId: 'sess-target', reason: 'session_revoked' },
      logger,
    );

    expect(target.isDisconnected()).toBe(true);
    expect(target.emitted).toEqual([
      { event: 'session:ended', payload: { reason: 'session_revoked' } },
    ]);

    expect(bystander.isDisconnected()).toBe(false);
    expect(bystander.emitted).toEqual([]);
  });

  it('member_removed leaves only the rooms held in that org, and disconnects nothing', async () => {
    const affected = fakeSocket(USER, 'sess-1', [
      ['board-in-org', ORG],
      ['board-in-other-org', OTHER_ORG],
    ]);

    await applyRevocation(
      fakeIo([affected.socket]),
      { kind: 'member_removed', orgId: ORG, userId: USER },
      logger,
    );

    expect(affected.isDisconnected()).toBe(false);
    expect(affected.left).toEqual(['board:board-in-org']);
    expect(affected.socket.data.rooms.has('board-in-org')).toBe(false);
    // The OTHER org's room is untouched — a revoked share must not read as an
    // outage on every board the user had open (§3.3, §7.2).
    expect(affected.socket.data.rooms.has('board-in-other-org')).toBe(true);
  });

  it('member_removed for a different user leaves that socket untouched', async () => {
    const bystander = fakeSocket(OTHER_USER, 'sess-1', [['board-1', ORG]]);

    await applyRevocation(
      fakeIo([bystander.socket]),
      { kind: 'member_removed', orgId: ORG, userId: USER },
      logger,
    );

    expect(bystander.left).toEqual([]);
    expect(bystander.socket.data.rooms.has('board-1')).toBe(true);
  });
});
