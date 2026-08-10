import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * In-app voice domain events (ai/phase-13-webrtc.md §4).
 *
 * ## NO EVENT IN THIS FILE CARRIES AN SDP BODY, AN ICE CANDIDATE, OR A CREDENTIAL
 *
 * The same rule `apps/api/src/telephony/events.ts` states, for the same reason:
 * an outbox payload is persisted and projected into the audit log, where
 * `REDACTION_PATHS` never runs — redaction applies to log lines, not to rows. An
 * SDP body names every local network interface the browser could see, which is
 * an internal network map written into a long-lived, widely-readable record. A
 * TURN credential in an audit entry is a working credential in an audit entry.
 *
 * Consumers that need the live signalling data are peers in the call, and they
 * get it over the socket, in the room, in memory, and never from here.
 *
 * ## Names are prefixed `rtc_session`, not `call`
 *
 * `defineEvent`'s registry is a single global namespace and `call.placed` /
 * `call.status_changed` already belong to telephony (Phase 7). Two modules
 * registering one name is a startup crash, which is the good outcome — but the
 * naming also stops a Phase 9 notification rule written for "a call" from
 * silently matching a different kind of call.
 */

/* -------------------------------------------------------------------------- *
 * Session lifecycle
 * -------------------------------------------------------------------------- */

export const rtcSessionStarted = defineEvent(
  'rtc_session.started',
  z
    .object({
      sessionId: z.string(),
      /* The channel, so a notification consumer can name the conversation
         without a second query. Never the channel's NAME — a DM has none, and
         a private channel's name is exactly the thing its non-members must not
         learn from an audit entry they can read. */
      channelId: z.string(),
      kind: z.enum(['audio', 'video']),
      invitedCount: z.number().int().nonnegative(),
      /**
       * Who to ring — the payload key `event-rooms.ts` fans this event out to
       * personal rooms by.
       *
       * User ids and nothing else. That is a deliberate line: an event payload
       * is projected into the audit log where `REDACTION_PATHS` never runs, and
       * an id is the one thing about a person already present in every audit
       * entry's `actor_id`. A display name or an email here would be new PII in
       * a long-lived record, for no benefit — the client already resolves ids
       * to names through the org directory it has loaded.
       *
       * Bounded by `MESH_PARTICIPANT_CAP` at the source, so this list cannot
       * grow to the size of an org.
       */
      invitedUserIds: z.array(z.string()),
    })
    .strict(),
);

/**
 * Somebody answered, and won the race (§3.6).
 *
 * Separate from `rtc_session.joined` because exactly one of these is ever
 * emitted per session — it is the conditional UPDATE's success, the transition
 * from `ringing` to `active`. A consumer counting conversations counts these; a
 * consumer counting legs counts the joins.
 */
export const rtcSessionAnswered = defineEvent(
  'rtc_session.answered',
  z.object({ sessionId: z.string() }).strict(),
);

export const rtcSessionJoined = defineEvent(
  'rtc_session.joined',
  z
    .object({
      sessionId: z.string(),
      /* After this join. The cap is enforced by a CHECK constraint, so this
         value can never exceed `max_participants` — it is reported so an
         operator can see how close real calls get to the mesh ceiling without
         instrumenting the client. */
      participantCount: z.number().int().positive(),
    })
    .strict(),
);

export const rtcSessionLeft = defineEvent(
  'rtc_session.left',
  z.object({ sessionId: z.string() }).strict(),
);

export const rtcSessionDeclined = defineEvent(
  'rtc_session.declined',
  z.object({ sessionId: z.string() }).strict(),
);

export const rtcSessionEnded = defineEvent(
  'rtc_session.ended',
  z
    .object({
      sessionId: z.string(),
      reason: z.enum(['hung_up', 'declined', 'no_answer', 'empty', 'org_suspended']),
      /**
       * Wall-clock seconds from answer to end, or 0 for a call nobody answered.
       *
       * From `started_at`, not from `created_at`: the time a phone rang
       * unanswered is not call duration, and reporting it as such makes every
       * "average call length" figure wrong in the direction that hides a
       * product problem.
       */
      durationSeconds: z.number().int().nonnegative(),
      /**
       * Everyone who was in or invited to this call, so their phones stop.
       *
       * A ring that only stops on the next poll keeps ringing for up to six
       * seconds after the call is over — which, for the person who declined by
       * hanging up on the other end, reads as the app not having noticed.
       * Same id-only rule as `invitedUserIds` above.
       */
      notifyUserIds: z.array(z.string()),
      /**
       * Who was still ringing when it ended — the missed-call notification's
       * recipients (Phase 9's projection reads this).
       *
       * A SUBSET of `notifyUserIds`, and deliberately a separate field rather
       * than something the consumer derives: "was still invited at the moment
       * the call ended" is a fact only the ending transaction can see, and by
       * the time any consumer reads the row every participant has been settled
       * into `missed` or `left`. Recomputing it downstream would tell everyone
       * who was ON the call that they missed it.
       */
      missedUserIds: z.array(z.string()),
      /** The channel, so the notification can link back to the conversation. */
      channelId: z.string(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * TURN (§3.4)
 * -------------------------------------------------------------------------- */

/**
 * A relay capability was handed out — a READ that gets an event.
 *
 * Guardrail 11 is framed around state mutation, and issuing a credential does
 * mutate (`rtc.turn_issuance`), but that is not why this is here. It is here for
 * the reason `recording.downloaded` is: this is the moment a bandwidth bill
 * becomes possible, and §3.4's whole argument is that TURN is a spend surface
 * that deserves the same visibility telephony's spend has.
 *
 * `ttlSeconds` and not the credential. The credential is the capability.
 */
export const turnCredentialIssued = defineEvent(
  'turn_credential.issued',
  z.object({ sessionId: z.string(), ttlSeconds: z.number().int().positive() }).strict(),
);

/**
 * The gate refused to mint one.
 *
 * Named for what happened rather than for which check fired, with the reason as
 * a closed union — the same shape `spend.limit_exceeded` uses, and for the same
 * reason: one event to alert on, so a refusal reason added later cannot bypass
 * an alert written against the three that existed when it was set up.
 *
 * A cap that only refuses is "the system quietly stopped connecting calls". A
 * cap that also emits this is "an operator found out within the hour."
 */
/* -------------------------------------------------------------------------- *
 * Recording (§3.9)
 *
 * Six events for what looks like one action, and the split is the point: PLAN.md
 * §8.5's standard for PSTN is that the consent DECISION is in the audit log, not
 * merely the recording. `call.consent_recorded` is its own event in Phase 7 for
 * exactly this reason, and a compliance review two years from now needs to find
 * "who agreed, and when" without unpacking another event's payload looking for
 * a boolean.
 *
 * No event here carries audio, an object key, or a presigned URL. A key is the
 * name of a thing in a bucket and a URL is a bearer credential for it; an outbox
 * payload is projected into the audit log, which is longer-lived and more widely
 * readable than the recording row itself.
 * -------------------------------------------------------------------------- */

export const rtcRecordingRequested = defineEvent(
  'rtc_recording.requested',
  z.object({ sessionId: z.string() }).strict(),
);

/**
 * One person agreed to be recorded.
 *
 * The actor is the person who agreed — carried by the envelope, not repeated in
 * the payload, so there is exactly one place the identity comes from. That is
 * what makes the audit trail answer "did everyone consent" by counting entries
 * rather than by trusting a summary somebody computed.
 */
export const rtcRecordingConsented = defineEvent(
  'rtc_recording.consented',
  z.object({ sessionId: z.string() }).strict(),
);

export const rtcRecordingDeclined = defineEvent(
  'rtc_recording.declined',
  z.object({ sessionId: z.string() }).strict(),
);

export const rtcRecordingStarted = defineEvent(
  'rtc_recording.started',
  z.object({ sessionId: z.string(), recordingId: z.string() }).strict(),
);

export const rtcRecordingStopped = defineEvent(
  'rtc_recording.stopped',
  z.object({ sessionId: z.string(), durationSeconds: z.number().int().nonnegative() }).strict(),
);

export const rtcRecordingStored = defineEvent(
  'rtc_recording.stored',
  z
    .object({
      sessionId: z.string(),
      recordingId: z.string(),
      bytes: z.number().int().nonnegative(),
      durationSeconds: z.number().int().nonnegative(),
    })
    .strict(),
);

/**
 * A stored recording was handed a download URL.
 *
 * A READ that gets an event — the same exception `turn_credential.issued`
 * takes (§4's own table) and the one `apps/api/src/telephony/events.ts`'s
 * `recordingDownloaded` takes for PSTN: issuing a link to a captured
 * conversation is the moment a durable copy becomes possible, and "who took
 * one" is a question only the audit trail can answer after the fact.
 */
export const rtcRecordingDownloaded = defineEvent(
  'rtc_recording.downloaded',
  z.object({ sessionId: z.string(), recordingId: z.string() }).strict(),
);

export const turnCredentialRefused = defineEvent(
  'turn_credential.refused',
  z
    .object({
      reason: z.enum(['org_suspended', 'not_a_participant', 'session_over', 'issuance_cap']),
      issuedInWindow: z.number().int().nonnegative(),
      capPerWindow: z.number().int().nonnegative(),
    })
    .strict(),
);
