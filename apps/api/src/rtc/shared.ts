import { eq, schema, type withOrgScope } from '@taskflow/db';
import { errors, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import type { Subject } from '@taskflow/policy';

/**
 * Shared plumbing for in-app voice (ai/phase-13-webrtc.md §1, §3.5).
 *
 * ## The one idea in this file
 *
 * A call session is a pointer at a CHANNEL, and everything about who may reach
 * it is decided by asking `can()` about that channel — through `loadChannel` and
 * `channelTarget` in `apps/api/src/chat/shared.ts`, the same two functions the
 * HTTP chat routes and the socket gateway already use.
 *
 * `loadSession` below therefore returns `channelId` prominently, and there is
 * deliberately no `loadSessionForUser`, no `assertParticipant`, and no
 * `isInvited` helper anywhere in this module's authorization path.
 * `rtc.participants` is a record of what happened; consulting it to decide who
 * may join would be the `participantIds.includes(userId)` shortcut
 * ai/phase-5-chat.md §3.3 forbids, rebuilt in a new schema.
 *
 * The one place participation IS consulted is the TURN gate (`turn-gate.ts`),
 * and that is not an authorization decision about the conversation — it is a
 * spend decision about whether to hand someone a relay capability. A person who
 * can read the channel may join the call; only a person actually in the call
 * gets bandwidth spent on them.
 */

export interface RtcActor {
  /** Role and resolved tuples, from `subjectOf(ctx.principal)`. */
  readonly subject: Subject;
  readonly requestId: RequestId;
}

export function orgOf(actor: RtcActor): OrgId {
  return actor.subject.orgId;
}

export function userOf(actor: RtcActor): UserId {
  return actor.subject.userId;
}

/** Envelope for an event write — see the Chat equivalent on why this is a helper. */
export function envelopeOf(actor: RtcActor): {
  readonly orgId: OrgId;
  readonly actorId: UserId;
  readonly requestId: RequestId;
} {
  return { orgId: actor.subject.orgId, actorId: actor.subject.userId, requestId: actor.requestId };
}

/**
 * The mesh ceiling (§3.5).
 *
 * Wave 1 is peer-to-peer mesh: every participant holds a connection to every
 * other, so both bandwidth and CPU grow as N². Four is where a laptop on a
 * domestic uplink stops coping; eight is the database's absolute ceiling
 * (`sessions_cap_sane`), left higher than this so raising the product limit is a
 * constant change rather than a migration on a live table.
 *
 * Written into each session row at creation rather than read at join time, so
 * changing this constant cannot retroactively evict someone from a call that is
 * already in progress.
 */
export const MESH_PARTICIPANT_CAP = 4;

type RtcTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/** Everything an authorization decision or a state transition needs. */
export interface SessionRow {
  readonly id: string;
  readonly orgId: string;
  readonly channelId: string;
  readonly kind: string;
  readonly status: string;
  readonly initiatedBy: string;
  readonly maxParticipants: number;
  readonly joinedCount: number;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
  readonly createdAt: Date;
  /** Recording state (migration 0042) — see `recording.service.ts`. */
  readonly recordingState: string;
  readonly recordingRequestedBy: string | null;
  readonly recordingStartedAt: Date | null;
  /**
   * How many joined participants have agreed to be recorded.
   *
   * Read alongside `joinedCount` because those two columns are what
   * `sessions_recording_needs_consent` compares — a caller deciding anything
   * about recording needs both or neither.
   */
  readonly consentCount: number;
}

/**
 * Loads a session, or throws NOT_FOUND.
 *
 * NOT_FOUND rather than FORBIDDEN for a session in another tenant is not a
 * choice made here — RLS has already erased the distinction, because a session
 * outside this org is simply not among the rows this scope can see.
 *
 * This function makes NO authorization decision. The caller loads the channel it
 * names and asks `can()` about that.
 */
export async function loadSession(tx: RtcTx, sessionId: string): Promise<SessionRow> {
  const rows = await tx
    .select({
      id: schema.rtcSessions.id,
      orgId: schema.rtcSessions.orgId,
      channelId: schema.rtcSessions.channelId,
      kind: schema.rtcSessions.kind,
      status: schema.rtcSessions.status,
      initiatedBy: schema.rtcSessions.initiatedBy,
      maxParticipants: schema.rtcSessions.maxParticipants,
      joinedCount: schema.rtcSessions.joinedCount,
      startedAt: schema.rtcSessions.startedAt,
      endedAt: schema.rtcSessions.endedAt,
      endReason: schema.rtcSessions.endReason,
      createdAt: schema.rtcSessions.createdAt,
      recordingState: schema.rtcSessions.recordingState,
      recordingRequestedBy: schema.rtcSessions.recordingRequestedBy,
      recordingStartedAt: schema.rtcSessions.recordingStartedAt,
      consentCount: schema.rtcSessions.consentCount,
    })
    .from(schema.rtcSessions)
    .where(eq(schema.rtcSessions.id, sessionId))
    .limit(1);

  const session = rows[0];
  if (!session) throw errors.notFound('No such call.');
  return session;
}

/**
 * Seconds a session was a CONVERSATION, from answer to end.
 *
 * Zero for a session nobody answered. Deliberately not measured from
 * `created_at`: the time a phone rang unanswered is not call duration, and
 * counting it makes every average-length figure wrong in the direction that
 * hides a product problem (people not picking up).
 */
export function durationSecondsOf(session: {
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
}): number {
  if (session.startedAt === null || session.endedAt === null) return 0;
  const ms = session.endedAt.getTime() - session.startedAt.getTime();
  return ms > 0 ? Math.floor(ms / 1000) : 0;
}
