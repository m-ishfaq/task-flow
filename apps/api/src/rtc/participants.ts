import { and, decrement, eq, increment, isNull, ne, schema, type withOrgScope } from '@taskflow/db';
import type { OrgId, UserId } from '@taskflow/contracts';
import { durationSecondsOf, loadSession, type SessionRow } from './shared.js';

/**
 * Participant and session-row writes — the repository behind `session.service.ts`.
 *
 * ## Why this is not a `*.service.ts` file
 *
 * Guardrail 11 requires every state-mutating SERVICE method to emit a domain
 * event, and the rule is scoped by filename precisely so that repositories,
 * which mutate by design, are not forced to invent an event per row they touch.
 * `chat/membership.ts`, `work/counters.ts` and `work/rebalance.ts` are the
 * existing examples, and this file is the same shape.
 *
 * The distinction is not cosmetic. `endSession` writes three tables, and the
 * EVENT belongs to the thing a person did — hanging up, declining, the last leg
 * leaving — which the service knows and this file does not. An
 * `rtc_participant.state_changed` event emitted from here would be a second,
 * lower-level record of the same fact, and two audit entries per call is worse
 * than one.
 *
 * The lint rule firing on these two functions while they lived in the service
 * file is the guardrail working, and moving them is the fix. Disabling it would
 * have been the fix that removes the rule's ability to notice the next one.
 */

type RtcTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

export type EndReason = 'hung_up' | 'declined' | 'no_answer' | 'empty' | 'org_suspended';

/**
 * Moves a caller into `joined`, and reports whether that was a TRANSITION.
 *
 * The distinction is what keeps `joined_count` honest. A second tab, a retried
 * request, or a client that calls join twice must not each add a seat — the
 * count is people in the call, not calls to this function. Returning false for
 * "already joined" is how the caller knows not to increment.
 *
 * The insert branch is join-in-progress: someone who can read the channel but
 * was not on the ring list, because they were added to the conversation after it
 * started. They are admitted because `can()` said so — which is the only thing
 * that decides it — and get a participant row recording that they arrived late.
 */
export async function joinParticipant(
  tx: RtcTx,
  input: {
    readonly sessionId: string;
    readonly orgId: OrgId;
    readonly userId: UserId;
    readonly now: Date;
  },
): Promise<boolean> {
  const claimed = await tx
    .update(schema.rtcParticipants)
    .set({ state: 'joined', joinedAt: input.now, leftAt: null })
    .where(
      and(
        eq(schema.rtcParticipants.sessionId, input.sessionId),
        eq(schema.rtcParticipants.userId, input.userId),
        /* Conditional, like the session's own answer claim: a row already in
           `joined` must not be counted a second time, and putting the current
           state in the WHERE is what makes that true under two concurrent
           requests rather than only under one. */
        ne(schema.rtcParticipants.state, 'joined'),
      ),
    )
    .returning({ userId: schema.rtcParticipants.userId });

  if (claimed.length === 1) return true;

  /* Nothing was claimed, which is two different situations: a row that is
     already `joined` (no transition, no seat), or no row at all (join in
     progress — see the header). Only a read tells them apart. */
  const existing = await tx
    .select({ state: schema.rtcParticipants.state })
    .from(schema.rtcParticipants)
    .where(
      and(
        eq(schema.rtcParticipants.sessionId, input.sessionId),
        eq(schema.rtcParticipants.userId, input.userId),
      ),
    )
    .limit(1);

  if (existing.length > 0) return false;

  await tx.insert(schema.rtcParticipants).values({
    sessionId: input.sessionId,
    orgId: input.orgId,
    userId: input.userId,
    state: 'joined',
    joinedAt: input.now,
  });

  return true;
}

/**
 * Records this caller's own recording decision, and keeps `consent_count` true.
 *
 * ## Why the counter is maintained here rather than recomputed
 *
 * `sessions_recording_needs_consent` compares `consent_count` with
 * `joined_count`, and a CHECK can only see the row it is checking — so the
 * count has to be a column. Incrementing it in the same statement-sequence as
 * the participant's own answer is what keeps the two from drifting: a recount
 * done later would be a second source of truth for the value the constraint
 * enforces.
 *
 * Returns whether this was a TRANSITION, for the same reason `joinParticipant`
 * does: a second click, or a retried request, must not add a second consent.
 */
export async function answerRecordingConsent(
  tx: RtcTx,
  input: {
    readonly sessionId: string;
    readonly userId: UserId;
    readonly agreed: boolean;
    readonly now: Date;
  },
): Promise<boolean> {
  /* Conditional on BOTH answer columns being null — the row's own
     "unanswered" state — so this is a claim rather than a check-then-write.
     Two tabs pressing Agree at once produce one increment. */
  const claimed = await tx
    .update(schema.rtcParticipants)
    .set(input.agreed ? { recordingConsentAt: input.now } : { recordingDeclinedAt: input.now })
    .where(
      and(
        eq(schema.rtcParticipants.sessionId, input.sessionId),
        eq(schema.rtcParticipants.userId, input.userId),
        eq(schema.rtcParticipants.state, 'joined'),
        isNull(schema.rtcParticipants.recordingConsentAt),
        isNull(schema.rtcParticipants.recordingDeclinedAt),
      ),
    )
    .returning({ userId: schema.rtcParticipants.userId });

  if (claimed.length === 0) return false;

  if (input.agreed) {
    await tx
      .update(schema.rtcSessions)
      .set({ consentCount: increment(schema.rtcSessions.consentCount), updatedAt: input.now })
      .where(eq(schema.rtcSessions.id, input.sessionId));
  }

  return true;
}

/**
 * Clears every consent answer for a session, and zeroes the counter.
 *
 * Run when recording STOPS. A consent given for one recording must not be
 * inherited by the next one somebody starts twenty minutes later — that is the
 * difference between "you agreed to be recorded" and "you agreed to be
 * recordable", and only the first is a thing anyone actually agreed to.
 */
export async function resetRecordingConsent(
  tx: RtcTx,
  sessionId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(schema.rtcParticipants)
    .set({ recordingConsentAt: null, recordingDeclinedAt: null })
    .where(eq(schema.rtcParticipants.sessionId, sessionId));

  await tx
    .update(schema.rtcSessions)
    .set({ consentCount: 0, updatedAt: now })
    .where(eq(schema.rtcSessions.id, sessionId));
}

/**
 * Writes the terminal state, and settles everyone still in the call.
 *
 * `missed` for anyone still ringing, so "did I miss a call" is a question the
 * participants table answers directly instead of one a reader has to infer by
 * joining against the session's status. `left` for anyone who was connected, so
 * no row is left claiming to be in a call that is over.
 */
export async function endSessionRow(
  tx: RtcTx,
  session: SessionRow,
  reason: EndReason,
  now: Date,
): Promise<{
  readonly sessionId: string;
  readonly reason: EndReason;
  readonly durationSeconds: number;
  readonly notifyUserIds: readonly string[];
  readonly missedUserIds: readonly string[];
}> {
  /* Read BEFORE the state changes below, and it has to be: the updates settle
     everyone into `missed` or `left`, so a read afterwards would still find the
     same rows — but the ordering is what makes this correct if a future state
     ever removes a row rather than transitioning it. Everyone who was in or
     invited to the call is told it is over, so a phone that is ringing stops
     ringing now rather than on the next six-second poll. */
  const audience = await tx
    .select({ userId: schema.rtcParticipants.userId, state: schema.rtcParticipants.state })
    .from(schema.rtcParticipants)
    .where(eq(schema.rtcParticipants.sessionId, session.id));

  /* Read BEFORE the `invited -> missed` update below, and it HAS to be: after
     it, everyone reads as `missed` and the distinction between "never answered"
     and "was in the call" is gone. This is what feeds the missed-call
     notification, so getting the ordering wrong would tell everyone who was on
     the call that they missed it. */
  const missedUserIds = audience.filter((row) => row.state === 'invited').map((row) => row.userId);

  await tx
    .update(schema.rtcSessions)
    .set({ status: 'ended', endedAt: now, endReason: reason, joinedCount: 0, updatedAt: now })
    .where(eq(schema.rtcSessions.id, session.id));

  await tx
    .update(schema.rtcParticipants)
    .set({ state: 'missed' })
    .where(
      and(
        eq(schema.rtcParticipants.sessionId, session.id),
        eq(schema.rtcParticipants.state, 'invited'),
      ),
    );

  await tx
    .update(schema.rtcParticipants)
    .set({ state: 'left', leftAt: now })
    .where(
      and(
        eq(schema.rtcParticipants.sessionId, session.id),
        eq(schema.rtcParticipants.state, 'joined'),
      ),
    );

  return {
    sessionId: session.id,
    reason,
    durationSeconds: durationSecondsOf({ startedAt: session.startedAt, endedAt: now }),
    notifyUserIds: audience.map((row) => row.userId),
    missedUserIds,
  };
}

/**
 * Whether the leg that just left was the last one worth keeping the call
 * open for — shared by `session.service.ts`'s `leaveSession` and
 * `leaveAllActiveSessionsFor` below, which needs the identical rule from a
 * different door (a membership removal, not a person clicking "leave").
 *
 * A 1:1 call has nobody left to talk to the moment EITHER person leaves —
 * waiting for `joinedCount` to reach zero means the remaining party sits in
 * a call with no one on the other end until they, too, click "leave". A
 * group call dropping to one person is different: that person may be
 * waiting for others to rejoin, so only a call with exactly two participants
 * total ever gets this early ending.
 */
export async function isLastLegOut(
  tx: RtcTx,
  sessionId: string,
  joinedCount: number,
): Promise<boolean> {
  if (joinedCount <= 0) return true;
  if (joinedCount !== 1) return false;

  const participants = await tx
    .select({ userId: schema.rtcParticipants.userId })
    .from(schema.rtcParticipants)
    .where(eq(schema.rtcParticipants.sessionId, sessionId));
  return participants.length === 2;
}

/**
 * Force-leaves a user from every RTC session they are currently `joined` to
 * in this org — called from WITHIN another operation's own transaction
 * (`tenancy/member.service.ts`'s `removeMember`), never through its own
 * `withOrgScope`, because the fact that triggers this — the membership row
 * itself is about to disappear — has to commit atomically with the leave.
 *
 * ## Why this cannot just be `leaveSession`, called once per session
 *
 * `leaveSession` reads the caller's OWN identity from an `RtcActor` and asks
 * "did *I* leave" — there is no actor here, only a person being removed by
 * someone else, so this takes the target explicitly and mirrors the same
 * participant-leave / `isLastLegOut` / `endSessionRow` shape by hand.
 *
 * ## The gap this closes
 *
 * Without it, removing someone from an org left their `rtc.participants`
 * row `joined` forever: their own client's follow-up "I left" call is
 * refused with `NOT_A_MEMBER` (they are not a member anymore, that is the
 * whole point), and the failure is silently swallowed as best-effort. The
 * session then never ends — `joined_count` stays inflated, the channel's
 * one-live-session-per-channel index blocks any new call in that
 * conversation, and anyone still on the call is left listening to nobody.
 *
 * Returns what happened per session so the caller — a `*.service.ts` file,
 * and therefore the one guardrail 11 requires to emit the event, not this
 * repository — can build `rtc_session.left`/`.ended` exactly as
 * `leaveSession` itself does.
 */
export async function leaveAllActiveSessionsFor(
  tx: RtcTx,
  input: { readonly orgId: OrgId; readonly userId: UserId; readonly now: Date },
): Promise<
  readonly {
    readonly sessionId: string;
    readonly channelId: string;
    readonly ended: boolean;
    readonly endedDetails?: {
      readonly reason: EndReason;
      readonly durationSeconds: number;
      readonly notifyUserIds: readonly string[];
      readonly missedUserIds: readonly string[];
    };
  }[]
> {
  const joinedRows = await tx
    .select({ sessionId: schema.rtcParticipants.sessionId })
    .from(schema.rtcParticipants)
    .innerJoin(schema.rtcSessions, eq(schema.rtcSessions.id, schema.rtcParticipants.sessionId))
    .where(
      and(
        eq(schema.rtcParticipants.orgId, input.orgId),
        eq(schema.rtcParticipants.userId, input.userId),
        eq(schema.rtcParticipants.state, 'joined'),
        ne(schema.rtcSessions.status, 'ended'),
      ),
    );

  const results: {
    sessionId: string;
    channelId: string;
    ended: boolean;
    endedDetails?: {
      reason: EndReason;
      durationSeconds: number;
      notifyUserIds: readonly string[];
      missedUserIds: readonly string[];
    };
  }[] = [];

  for (const row of joinedRows) {
    const session = await loadSession(tx, row.sessionId);
    if (session.status === 'ended') continue; // Ended by an earlier iteration's own end, or a race.

    const left = await tx
      .update(schema.rtcParticipants)
      .set({ state: 'left', leftAt: input.now })
      .where(
        and(
          eq(schema.rtcParticipants.sessionId, session.id),
          eq(schema.rtcParticipants.userId, input.userId),
          eq(schema.rtcParticipants.state, 'joined'),
        ),
      )
      .returning({ userId: schema.rtcParticipants.userId });

    if (left.length === 0) continue;

    const remaining = await tx
      .update(schema.rtcSessions)
      .set({ joinedCount: decrement(schema.rtcSessions.joinedCount), updatedAt: input.now })
      .where(eq(schema.rtcSessions.id, session.id))
      .returning({ joinedCount: schema.rtcSessions.joinedCount });

    const joinedCount = remaining[0]?.joinedCount ?? 0;
    const shouldEnd = await isLastLegOut(tx, session.id, joinedCount);

    if (!shouldEnd) {
      results.push({ sessionId: session.id, channelId: session.channelId, ended: false });
      continue;
    }

    const ended = await endSessionRow(tx, session, 'empty', input.now);
    results.push({
      sessionId: session.id,
      channelId: session.channelId,
      ended: true,
      endedDetails: {
        reason: ended.reason,
        durationSeconds: ended.durationSeconds,
        notifyUserIds: ended.notifyUserIds,
        missedUserIds: ended.missedUserIds,
      },
    });
  }

  return results;
}
