import {
  and,
  asc,
  desc,
  eq,
  inArray,
  increment,
  decrement,
  ne,
  outboxWriter,
  schema,
  withOrgScope,
} from '@taskflow/db';
import { errors, type ChannelId } from '@taskflow/contracts';
import { createEvent, type DomainEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { channelMemberIds } from '../chat/membership.js';
import { enforceOnChannel, loadChannel } from '../chat/shared.js';
/* Repositories, not services — they mutate by design and the EVENT belongs to
   the operation a person performed, which this file knows and they do not. See
   `participants.ts`' own header, and `chat/membership.ts` for the precedent. */
import { endSessionRow, joinParticipant } from './participants.js';
import {
  rtcSessionAnswered,
  rtcSessionDeclined,
  rtcSessionEnded,
  rtcSessionJoined,
  rtcSessionLeft,
  rtcSessionStarted,
} from './events.js';
import {
  envelopeOf,
  loadSession,
  MESH_PARTICIPANT_CAP,
  orgOf,
  userOf,
  type RtcActor,
  type SessionRow,
} from './shared.js';

/**
 * In-app call sessions (ai/phase-13-webrtc.md §1, §3.5, §3.6).
 *
 * ## Every authorization decision in this file is about the CHANNEL
 *
 * There is no `can()` call here that names a session, and there must never be
 * one. §1: a call in channel X is joinable by precisely those who can read
 * channel X, so every route loads the channel through `loadChannel` and decides
 * through `enforceOnChannel` — the same two functions the chat HTTP routes and
 * `apps/realtime/src/rooms.ts` already use, and therefore the same decision, on
 * the same `Subject`, with `closed` carried by `channelTarget` exactly as it is
 * everywhere else.
 *
 * `rtc.participants` is consulted for STATE ("are you already in this call"),
 * never for permission. The moment it answers "may you", it has become the
 * `participantIds.includes(userId)` shortcut ai/phase-5-chat.md §3.3 forbids.
 *
 * ## Two questions, deliberately not merged (§3.8)
 *
 *   STARTING a call is `message:create`. A `viewer` tuple is read-and-not-write
 *   by design, and someone who cannot post into a conversation should not be
 *   able to make everyone's phone ring in it.
 *
 *   JOINING one is `channel:read`. If you can read the conversation you can be
 *   in its call — which is what makes the sentence at the top of this file true.
 *
 * Collapsing them would either stop viewers listening in on a call they are
 * entitled to hear, or let them start one.
 */

/** SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';
/** SQLSTATE for a CHECK constraint violation — how the participant cap fires. */
const CHECK_VIOLATION = '23514';

function hasSqlState(error: unknown, state: string): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current && current.code === state) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface SessionParticipant {
  readonly userId: string;
  readonly state: string;
  readonly joinedAt: Date | null;
}

export interface SessionView {
  readonly sessionId: string;
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
  readonly participants: readonly SessionParticipant[];
}

/* -------------------------------------------------------------------------- *
 * Starting
 * -------------------------------------------------------------------------- */

export interface StartSessionInput {
  readonly channelId: ChannelId;
  readonly kind: 'audio' | 'video';
}

/**
 * Rings everyone in a conversation.
 *
 * ## Who gets rung comes from the channel's member TUPLES
 *
 * `channelMemberIds` reads `authz.relationship_tuples` — the same rows `can()`
 * consults — so the ring list and the access decision cannot disagree. There is
 * no `rtc` membership concept to drift from it.
 *
 * That is also why a PUBLIC channel cannot start a call in Wave 1 (§6): a public
 * channel's readership is the whole org, expressed as a role rather than as
 * tuples, so there is no bounded roster to ring. Fanning out to every member of
 * the organization is not a smaller version of the right behaviour, it is a
 * different and much worse one. Wave 2's join-in-progress is the answer.
 */
export async function startSession(
  actor: RtcActor,
  input: StartSessionInput,
): Promise<{ readonly sessionId: string; readonly invitedUserIds: readonly string[] }> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);
  const sessionId = newId<'RtcSessionId'>();

  const invitedUserIds = await withOrgScope(orgId, async (tx) => {
    const channel = await loadChannel(tx, input.channelId);

    /* Layer 2. `message:create`, not `channel:read` — see the file header. */
    enforceOnChannel(actor, 'message:create', channel);

    if (channel.archivedAt !== null) {
      throw errors.conflict('This conversation is archived.');
    }

    if (channel.type === 'public') {
      /* CONFLICT rather than FORBIDDEN: the caller is entitled to do this, the
         feature does not exist yet. A FORBIDDEN here would send someone
         hunting through the permission model for a grant that would not have
         helped. */
      throw errors.conflict(
        'Calls in public channels are not available yet — start one from a direct message or a private channel.',
      );
    }

    const roster = await channelMemberIds(tx, input.channelId);
    const invited = roster.filter((id) => id !== userId);

    if (invited.length === 0) {
      throw errors.conflict('There is nobody else in this conversation to call.');
    }

    /* Refused UP FRONT rather than letting the first N members in and dropping
       the rest — a call that silently excludes some of the people it rang is a
       worse outcome than one that refuses to start. The database's CHECK is
       still the enforcement (§3.5); this is the readable failure in front of
       it. */
    if (roster.length > MESH_PARTICIPANT_CAP) {
      throw errors.quotaExceeded(
        `Calls are limited to ${String(MESH_PARTICIPANT_CAP)} people. This conversation has ${String(roster.length)}.`,
      );
    }

    try {
      await tx.insert(schema.rtcSessions).values({
        id: sessionId,
        orgId,
        channelId: input.channelId,
        kind: input.kind,
        status: 'ringing',
        initiatedBy: userId,
        maxParticipants: MESH_PARTICIPANT_CAP,
        /* The initiator is IN the call from the moment it exists — they are not
           going to ring themselves — so the count starts at one and the cap
           accounts for them. */
        joinedCount: 1,
      });
    } catch (error) {
      /* `sessions_one_live_per_channel` (migration 0041): a partial unique
         index over the non-ended sessions of one channel. Two people pressing
         "call" in the same DM within a second of each other is the ordinary
         case, not an attack, and without this it produces two sessions that
         ring past each other — which presents as "the network dropped". */
      if (hasSqlState(error, UNIQUE_VIOLATION)) {
        throw errors.conflict('A call is already in progress in this conversation.');
      }
      throw error;
    }

    const now = new Date();
    await tx.insert(schema.rtcParticipants).values([
      { sessionId, orgId, userId, state: 'joined', joinedAt: now },
      ...invited.map((invitee) => ({ sessionId, orgId, userId: invitee, state: 'invited' })),
    ]);

    await outboxWriter.append(tx, [
      createEvent(
        rtcSessionStarted,
        {
          sessionId,
          channelId: input.channelId,
          kind: input.kind,
          invitedCount: invited.length,
          /* What `event-rooms.ts` fans this out to personal rooms by, so every
             invitee's phone rings on whatever page they are on. Ids only — see
             the event's own comment on why no names travel here. */
          invitedUserIds: [...invited],
        },
        envelopeOf(actor),
      ),
    ]);

    return invited;
  });

  return { sessionId, invitedUserIds };
}

/* -------------------------------------------------------------------------- *
 * Joining — and first-answer-wins
 * -------------------------------------------------------------------------- */

/**
 * Joins a call, promoting it out of `ringing` if this is the first answer.
 *
 * ## First-answer-wins is a CONDITIONAL UPDATE, not a check-then-write (§3.6)
 *
 * "All are notified, anyone can answer" is a race — two tabs of the same callee,
 * or two members of a group DM tapping accept at the same instant. Reading the
 * status and then writing it means both see `ringing`, both write `active`, and
 * both emit `rtc_session.answered`; the call then has two "first" answers, and
 * anything counting conversations counts one call twice.
 *
 * So the current status goes in the WHERE clause and the returned row count is
 * the answer. Exactly `claimForScanning`'s shape in the attachment pipeline.
 *
 * ## Answer and join are one operation on purpose
 *
 * A second person joining a call already in progress runs this same function;
 * the conditional UPDATE simply matches nothing and no `answered` event fires.
 * Two routes would mean the client had to know which state the call was in
 * before choosing one — a decision it can only make from data that may already
 * be stale.
 */
export async function joinSession(
  actor: RtcActor,
  input: { readonly sessionId: string },
): Promise<SessionView> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);

  return withOrgScope(orgId, async (tx) => {
    const session = await loadSession(tx, input.sessionId);

    /* THE authorization decision, and it is about the channel. */
    const channel = await loadChannel(tx, session.channelId as ChannelId);
    enforceOnChannel(actor, 'channel:read', channel);

    if (session.status === 'ended') {
      throw errors.conflict('This call has ended.');
    }

    const now = new Date();

    /* The conditional UPDATE. `returning` length is the race's verdict. */
    const answered = await tx
      .update(schema.rtcSessions)
      .set({ status: 'active', startedAt: now, updatedAt: now })
      .where(and(eq(schema.rtcSessions.id, session.id), eq(schema.rtcSessions.status, 'ringing')))
      .returning({ id: schema.rtcSessions.id });

    const wonTheRace = answered.length === 1;

    const transitioned = await joinParticipant(tx, {
      sessionId: session.id,
      orgId,
      userId,
      now,
    });

    if (transitioned) {
      try {
        await tx
          .update(schema.rtcSessions)
          .set({
            joinedCount: increment(schema.rtcSessions.joinedCount),
            /* SOMEBODY JOINING A RECORDING CALL PAUSES IT (migration 0042).
             *
             * This is not a courtesy — it is what keeps the join possible. A new
             * participant increments `joined_count` and not `consent_count`, so
             * an `active` recording would violate
             * `sessions_recording_needs_consent` and the JOIN would fail. Being
             * unable to answer a call is a worse failure than a pause, so the
             * recording drops back to `pending` in the same transaction.
             *
             * The result is what a compliance review would ask for anyway:
             * capture stops the moment somebody who has not agreed can hear it,
             * and resumes only when they do. The constraint is what forces that
             * rather than leaving it to be remembered. */
            ...(session.recordingState === 'active' ? { recordingState: 'pending' as const } : {}),
            updatedAt: now,
          })
          .where(eq(schema.rtcSessions.id, session.id));
      } catch (error) {
        /* `sessions_joined_within_cap` — the mesh ceiling, enforced by Postgres
           (§3.5). This is the branch that makes the cap real under
           concurrency: two people joining the last seat both pass any
           count-then-insert check written in JavaScript, and exactly one of
           them gets this. The whole transaction rolls back, so the participant
           row written a moment ago goes with it. */
        if (hasSqlState(error, CHECK_VIOLATION)) {
          throw errors.quotaExceeded('This call is full.');
        }
        throw error;
      }
    }

    const events: DomainEvent[] = [];
    if (wonTheRace) {
      events.push(createEvent(rtcSessionAnswered, { sessionId: session.id }, envelopeOf(actor)));
    }
    if (transitioned) {
      events.push(
        createEvent(
          rtcSessionJoined,
          { sessionId: session.id, participantCount: session.joinedCount + 1 },
          envelopeOf(actor),
        ),
      );
    }
    if (events.length > 0) await outboxWriter.append(tx, events);

    return readSessionView(tx, session.id);
  });
}

type RtcTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/* -------------------------------------------------------------------------- *
 * Leaving, declining, ending
 * -------------------------------------------------------------------------- */

/**
 * Leaves a call, ending it when the last person goes.
 *
 * No authorization check beyond membership of the org, and that is correct
 * rather than an omission: this only ever writes the CALLER's own participant
 * row and can do nothing to anyone else's. A `can()` call here would be asking
 * whether someone may stop doing something, which is not a question the
 * permission model has an answer to — and refusing it would leave a person stuck
 * in a call their channel access had just been revoked from.
 */
export async function leaveSession(
  actor: RtcActor,
  input: { readonly sessionId: string },
): Promise<void> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);

  await withOrgScope(orgId, async (tx) => {
    const session = await loadSession(tx, input.sessionId);
    if (session.status === 'ended') return;

    const now = new Date();

    const left = await tx
      .update(schema.rtcParticipants)
      .set({ state: 'left', leftAt: now })
      .where(
        and(
          eq(schema.rtcParticipants.sessionId, session.id),
          eq(schema.rtcParticipants.userId, userId),
          eq(schema.rtcParticipants.state, 'joined'),
        ),
      )
      .returning({ userId: schema.rtcParticipants.userId });

    if (left.length === 0) return;

    const remaining = await tx
      .update(schema.rtcSessions)
      .set({ joinedCount: decrement(schema.rtcSessions.joinedCount), updatedAt: now })
      .where(eq(schema.rtcSessions.id, session.id))
      .returning({ joinedCount: schema.rtcSessions.joinedCount });

    const events: DomainEvent[] = [
      createEvent(rtcSessionLeft, { sessionId: session.id }, envelopeOf(actor)),
    ];

    /* The last leg out ends the call. Without this a session stays `active`
       forever with nobody in it, holding the one-live-session-per-channel
       index and making the next call in that conversation impossible to
       start — a dead call that blocks every future one. */
    if ((remaining[0]?.joinedCount ?? 0) <= 0) {
      const ended = await endSessionRow(tx, session, 'empty', now);
      events.push(createEvent(rtcSessionEnded, { ...ended, channelId: session.channelId, notifyUserIds: [...ended.notifyUserIds], missedUserIds: [...ended.missedUserIds] }, envelopeOf(actor)));
    }

    await outboxWriter.append(tx, events);
  });
}

/**
 * Refuses an incoming call.
 *
 * Ends the whole session when nobody is left to answer — otherwise a declined
 * 1:1 call would ring the caller's UI indefinitely, and the "call" button in
 * that conversation would stay blocked by the live-session index.
 */
export async function declineSession(
  actor: RtcActor,
  input: { readonly sessionId: string },
): Promise<void> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);

  await withOrgScope(orgId, async (tx) => {
    const session = await loadSession(tx, input.sessionId);
    if (session.status === 'ended') return;

    const now = new Date();

    const declined = await tx
      .update(schema.rtcParticipants)
      .set({ state: 'declined' })
      .where(
        and(
          eq(schema.rtcParticipants.sessionId, session.id),
          eq(schema.rtcParticipants.userId, userId),
          eq(schema.rtcParticipants.state, 'invited'),
        ),
      )
      .returning({ userId: schema.rtcParticipants.userId });

    if (declined.length === 0) return;

    const events: DomainEvent[] = [
      createEvent(rtcSessionDeclined, { sessionId: session.id }, envelopeOf(actor)),
    ];

    const stillInvited = await tx
      .select({ userId: schema.rtcParticipants.userId })
      .from(schema.rtcParticipants)
      .where(
        and(
          eq(schema.rtcParticipants.sessionId, session.id),
          eq(schema.rtcParticipants.state, 'invited'),
        ),
      )
      .limit(1);

    /* Only a session nobody has ANSWERED ends on a decline. Declining after
       someone else picked up is one person opting out of a conversation that
       is happening — ending it for everyone else would be the caller hanging
       up on their own call by refusing it. */
    if (stillInvited.length === 0 && session.status === 'ringing') {
      const ended = await endSessionRow(tx, session, 'declined', now);
      events.push(createEvent(rtcSessionEnded, { ...ended, channelId: session.channelId, notifyUserIds: [...ended.notifyUserIds], missedUserIds: [...ended.missedUserIds] }, envelopeOf(actor)));
    }

    await outboxWriter.append(tx, events);
  });
}

/**
 * Cancels a call the caller started, before anyone answered.
 *
 * Restricted to the INITIATOR, and that is a product rule read off
 * `rtc.participants`/`sessions.initiated_by` — not an authorization decision.
 * The distinction matters because everything §1 promises rests on authorization
 * questions being asked of the channel: "may this person be in this call" is
 * `can()`, and "is this person the one who placed it" is a fact about a row.
 */
export async function cancelSession(
  actor: RtcActor,
  input: { readonly sessionId: string },
): Promise<void> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);

  await withOrgScope(orgId, async (tx) => {
    const session = await loadSession(tx, input.sessionId);
    if (session.status === 'ended') return;

    if (session.initiatedBy !== userId) {
      throw errors.forbidden('Only the person who started this call can cancel it.');
    }

    const now = new Date();
    const ended = await endSessionRow(
      tx,
      session,
      session.status === 'ringing' ? 'no_answer' : 'hung_up',
      now,
    );

    await outboxWriter.append(tx, [createEvent(rtcSessionEnded, { ...ended, channelId: session.channelId, notifyUserIds: [...ended.notifyUserIds], missedUserIds: [...ended.missedUserIds] }, envelopeOf(actor))]);
  });
}

/* -------------------------------------------------------------------------- *
 * Reading
 * -------------------------------------------------------------------------- */

async function readSessionView(tx: RtcTx, sessionId: string): Promise<SessionView> {
  const session = await loadSession(tx, sessionId);

  const participants = await tx
    .select({
      userId: schema.rtcParticipants.userId,
      state: schema.rtcParticipants.state,
      joinedAt: schema.rtcParticipants.joinedAt,
    })
    .from(schema.rtcParticipants)
    .where(eq(schema.rtcParticipants.sessionId, sessionId))
    .orderBy(asc(schema.rtcParticipants.invitedAt));

  return {
    sessionId: session.id,
    channelId: session.channelId,
    kind: session.kind,
    status: session.status,
    initiatedBy: session.initiatedBy,
    maxParticipants: session.maxParticipants,
    joinedCount: session.joinedCount,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    endReason: session.endReason,
    createdAt: session.createdAt,
    participants,
  };
}

/** One call, for a caller who can read its channel. */
export async function getSession(
  actor: RtcActor,
  input: { readonly sessionId: string },
): Promise<SessionView> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const session = await loadSession(tx, input.sessionId);
    const channel = await loadChannel(tx, session.channelId as ChannelId);
    enforceOnChannel(actor, 'channel:read', channel);

    return readSessionView(tx, session.id);
  });
}

/**
 * The live call in a conversation, or null.
 *
 * What the chat header renders its "Join call" affordance from. Returns at most
 * one row by construction — `sessions_one_live_per_channel` is a unique index,
 * not a convention.
 */
export async function activeSessionForChannel(
  actor: RtcActor,
  input: { readonly channelId: ChannelId },
): Promise<SessionView | null> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:read', channel);

    const rows = await tx
      .select({ id: schema.rtcSessions.id })
      .from(schema.rtcSessions)
      .where(
        and(
          eq(schema.rtcSessions.channelId, input.channelId),
          ne(schema.rtcSessions.status, 'ended'),
        ),
      )
      .limit(1);

    const found = rows[0];
    return found === undefined ? null : readSessionView(tx, found.id);
  });
}

export interface HistoryParticipant {
  readonly userId: string;
  readonly state: string;
  readonly joinedAt: Date | null;
  readonly leftAt: Date | null;
}

export interface SessionHistoryEntry {
  readonly sessionId: string;
  readonly channelId: string;
  readonly kind: string;
  readonly status: string;
  readonly initiatedBy: string;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
  readonly createdAt: Date;
  readonly participants: readonly HistoryParticipant[];
}

/** Bounds one page of history — a details panel and a message timeline both
    want "recent", never "every call this conversation has ever had". */
const MAX_HISTORY_PAGE = 50;

/**
 * Every call that has happened in a conversation, newest first.
 *
 * Feeds two surfaces that did not exist through Wave 2: the Calls tab in the
 * details panel and the call cards in the message timeline (§6's "recordings
 * have no listing UI" — the same gap extends to the sessions themselves, since
 * neither ever got a read path beyond `active`/`get`/`incoming`).
 *
 * `channel:read`, same as every other read in this file: a call's record is
 * exactly as visible as the conversation it belongs to, never narrower — there
 * is no separate "was I on this call" gate, for the reason §1 gives everywhere
 * else: `rtc.participants` is consulted for STATE, never for permission.
 */
export async function listSessionsForChannel(
  actor: RtcActor,
  input: { readonly channelId: ChannelId; readonly limit?: number },
): Promise<readonly SessionHistoryEntry[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:read', channel);

    const sessions = await tx
      .select({
        id: schema.rtcSessions.id,
        channelId: schema.rtcSessions.channelId,
        kind: schema.rtcSessions.kind,
        status: schema.rtcSessions.status,
        initiatedBy: schema.rtcSessions.initiatedBy,
        startedAt: schema.rtcSessions.startedAt,
        endedAt: schema.rtcSessions.endedAt,
        endReason: schema.rtcSessions.endReason,
        createdAt: schema.rtcSessions.createdAt,
      })
      .from(schema.rtcSessions)
      .where(eq(schema.rtcSessions.channelId, input.channelId))
      .orderBy(desc(schema.rtcSessions.createdAt))
      .limit(Math.min(input.limit ?? MAX_HISTORY_PAGE, MAX_HISTORY_PAGE));

    if (sessions.length === 0) return [];

    /* One query for every session's roster rather than one per row — the same
       batching `listSaved`'s excerpt read uses, and for the same reason: a
       conversation with fifty calls in its history should cost this endpoint
       two round trips, not fifty-one. */
    const participantRows = await tx
      .select({
        sessionId: schema.rtcParticipants.sessionId,
        userId: schema.rtcParticipants.userId,
        state: schema.rtcParticipants.state,
        joinedAt: schema.rtcParticipants.joinedAt,
        leftAt: schema.rtcParticipants.leftAt,
      })
      .from(schema.rtcParticipants)
      .where(
        inArray(
          schema.rtcParticipants.sessionId,
          sessions.map((session) => session.id),
        ),
      )
      .orderBy(asc(schema.rtcParticipants.invitedAt));

    const byId = new Map<string, HistoryParticipant[]>();
    for (const row of participantRows) {
      const list = byId.get(row.sessionId) ?? [];
      list.push({
        userId: row.userId,
        state: row.state,
        joinedAt: row.joinedAt,
        leftAt: row.leftAt,
      });
      byId.set(row.sessionId, list);
    }

    return sessions.map((session) => ({
      sessionId: session.id,
      channelId: session.channelId,
      kind: session.kind,
      status: session.status,
      initiatedBy: session.initiatedBy,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      endReason: session.endReason,
      createdAt: session.createdAt,
      participants: byId.get(session.id) ?? [],
    }));
  });
}

export interface IncomingCall {
  readonly sessionId: string;
  readonly channelId: string;
  readonly kind: string;
  readonly initiatedBy: string;
  readonly createdAt: Date;
}

/**
 * "Is anyone ringing me?"
 *
 * Keyed on the caller's OWN participant rows, so it discloses nothing about
 * calls they were not invited to — which is why it needs no `can()` check of its
 * own and can be a `memberRoute`. Every row it returns is one this person was
 * explicitly rung for, by someone who held `message:create` on a channel they
 * were a member of at the time.
 *
 * It does NOT re-check `channel:read` per row. That is deliberate and worth
 * being explicit about: the payload is a session id, a channel id, and who
 * called — the same facts a `channel.member_added` notification already carries
 * — and joining is where the real decision is made, by `joinSession`, against
 * the channel, every time. Losing channel access between being rung and
 * answering therefore shows a stale ringing card that refuses on answer, which
 * is the correct failure and not a disclosure.
 */
export async function incomingCalls(actor: RtcActor): Promise<readonly IncomingCall[]> {
  return withOrgScope(orgOf(actor), async (tx) =>
    tx
      .select({
        sessionId: schema.rtcSessions.id,
        channelId: schema.rtcSessions.channelId,
        kind: schema.rtcSessions.kind,
        initiatedBy: schema.rtcSessions.initiatedBy,
        createdAt: schema.rtcSessions.createdAt,
      })
      .from(schema.rtcParticipants)
      .innerJoin(
        schema.rtcSessions,
        and(
          eq(schema.rtcSessions.id, schema.rtcParticipants.sessionId),
          eq(schema.rtcSessions.orgId, schema.rtcParticipants.orgId),
        ),
      )
      .where(
        and(
          eq(schema.rtcParticipants.userId, userOf(actor)),
          eq(schema.rtcParticipants.state, 'invited'),
          /* NOT `status = 'ringing'`. Somebody else answering moves the session
             to `active`, and a filter on `ringing` would silence everyone
             else's phone the instant the first person picked up — so a
             three-way call could only ever have two people in it. The invite
             stands until this person answers, declines, or the call ends,
             which is what their own participant state already says. */
          ne(schema.rtcSessions.status, 'ended'),
        ),
      )
      .orderBy(asc(schema.rtcSessions.createdAt)),
  );
}

/**
 * Exported for the TURN service, which needs the channel a session belongs to in
 * order to ask `can()` about it. Kept here rather than duplicated there so there
 * is one place that turns a session id into an authorization decision.
 */
export async function enforceCanJoinSession(
  actor: RtcActor,
  sessionId: string,
): Promise<SessionRow> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const session = await loadSession(tx, sessionId);
    const channel = await loadChannel(tx, session.channelId as ChannelId);

    /* `enforceOnChannel` builds the target through `channelTarget`, which is
       what carries `closed`. A target assembled inline without it grants every
       org member every DM, with a decision trace that reads as entirely
       correct — which is why no file outside `chat/shared.ts` builds one. */
    enforceOnChannel(actor, 'channel:read', channel);

    return session;
  });
}
