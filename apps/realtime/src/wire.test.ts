import { describe, expect, it } from 'vitest';
import { boardIdOfRoom, boardRoom, JoinRequestSchema, LeaveRequestSchema } from './wire.js';

/**
 * The wire contract's security property (ai/phase-4-realtime.md §3.7, §6.4).
 *
 * §6.4: "One test is not optional: a socket presenting a VALID token for user A,
 * attempting to join a room by naming user B's id or a board A has no membership
 * on, must be refused. ... It belongs in the suite as its own named test, not
 * folded into a general 'authorization works' case that could pass while this one
 * path regressed."
 *
 * That requirement has two halves, and they are refused by two different
 * mechanisms — which is why they are two files:
 *
 *   "a board A has no membership on"  →  `rooms.test.ts`, against real Postgres:
 *                                        `can()` is consulted and says no.
 *   "by naming user B's id"           →  HERE, and not by a check at all: there
 *                                        is no field in the protocol where an
 *                                        identity can be named, and `.strict()`
 *                                        rejects one that is added.
 *
 * The second half is the one worth writing down carefully, because "we made it
 * structurally impossible" is a claim that quietly stops being true. A schema
 * that lost `.strict()`, or that gained a `userId` for some plausible-sounding
 * reason, would compile, pass every other test in this suite, and turn the
 * gateway into the exact vulnerability §3.7 describes: a handler that trusts a
 * client-supplied id and joins that user's rooms. These assertions fail the
 * moment either happens.
 */

const ORG = '0195ff00-0000-7000-8000-0000000000a1';
const BOARD = '0195ff00-0000-7000-8000-000000000a11';
const OTHER_USER = '0195ff00-0000-7000-8000-000000000a02';

describe('JoinRequestSchema — there is nowhere to assert an identity (§3.7)', () => {
  it('accepts a well-formed request naming only a scope and a resource', () => {
    const parsed = JoinRequestSchema.safeParse({ orgId: ORG, boardId: BOARD });

    expect(parsed.success).toBe(true);
  });

  /**
   * THE §6.4 test for this half. A socket authenticated as user A sends a join
   * naming user B — the shape that, taken from the payload and joined without a
   * check, harvests every user's data from a connection that proved nothing.
   *
   * It must be REJECTED, not ignored. Silently dropping the field would leave
   * the request succeeding, which reads as "the field is harmless" to the next
   * person and invites a handler that reads it.
   */
  it('REFUSES a request that names a userId, rather than ignoring the field', () => {
    const parsed = JoinRequestSchema.safeParse({
      orgId: ORG,
      boardId: BOARD,
      userId: OTHER_USER,
    });

    expect(parsed.success).toBe(false);
  });

  it('refuses any unrecognized field, not just userId', () => {
    // `.strict()` is the mechanism, so the property is general — asserted with a
    // second field so a regression that special-cased `userId` alone would
    // still fail here.
    for (const extra of [{ sub: OTHER_USER }, { role: 'owner' }, { subject: OTHER_USER }]) {
      const parsed = JoinRequestSchema.safeParse({ orgId: ORG, boardId: BOARD, ...extra });
      expect(parsed.success).toBe(false);
    }
  });

  it('has no identity-bearing key in its own shape', () => {
    /* Asserted against the PARSED OUTPUT rather than by reading the schema's
       internals: what matters is what a handler can reach, and the output is
       what a handler is handed. A field the schema stripped is invisible here,
       which is the correct answer — it cannot be read either. */
    const parsed = JoinRequestSchema.parse({ orgId: ORG, boardId: BOARD });

    expect(Object.keys(parsed).sort()).toEqual(['boardId', 'orgId']);
  });

  it('refuses ids that are not well-formed, so a malformed one never reaches a query', () => {
    expect(JoinRequestSchema.safeParse({ orgId: 'not-a-uuid', boardId: BOARD }).success).toBe(
      false,
    );
    expect(JoinRequestSchema.safeParse({ orgId: ORG, boardId: 'not-a-uuid' }).success).toBe(false);
    expect(JoinRequestSchema.safeParse({ boardId: BOARD }).success).toBe(false);
  });
});

describe('LeaveRequestSchema', () => {
  it('accepts a board id and refuses anything alongside it', () => {
    expect(LeaveRequestSchema.safeParse({ boardId: BOARD }).success).toBe(true);
    expect(LeaveRequestSchema.safeParse({ boardId: BOARD, userId: OTHER_USER }).success).toBe(
      false,
    );
  });
});

describe('room naming', () => {
  it('round-trips a board id through its room name', () => {
    expect(boardIdOfRoom(boardRoom(BOARD))).toBe(BOARD);
  });

  it('does not claim a room that is not a board room', () => {
    // Wave 2 adds no other room kinds, but Chat (Phase 5) shares this gateway
    // on its own namespace and Docs (Phase 6) joins it later — a prefix check
    // that answered for every room would silently mis-route the first one.
    expect(boardIdOfRoom('user:123')).toBeNull();
    expect(boardIdOfRoom('')).toBeNull();
  });
});
