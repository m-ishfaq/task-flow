import { z } from 'zod';
import { defineEvent } from '@taskflow/events';
import { TELEPHONY_REFUSALS } from '@taskflow/contracts';

/**
 * Telephony domain events — the Wave 1 subset of ai/phase-7-voice.md §4.
 *
 * The rest of §4's catalog (CallPlaced, RecordingStarted, MessageSent, …) is
 * deliberately absent: those describe actions Wave 1 does not make possible, and
 * registering an event nothing can emit turns the registry into a list of
 * intentions rather than a description of what the system does.
 *
 * ## Why the spend events exist at all
 *
 * §4 is explicit, and it is the difference between a control and a silence: a
 * cap that only prevents the next call is "the system quietly stopped placing
 * calls." A cap that also emits a typed, outbox-carried event is "an admin found
 * out why within the hour." Phase 9 already has the notification machinery to
 * route it; this phase's job is to emit something real for it to route.
 */

/* -------------------------------------------------------------------------- *
 * Provisioning
 * -------------------------------------------------------------------------- */

export const subaccountProvisioned = defineEvent(
  'subaccount.provisioned',
  z
    .object({
      /* The SID, never the auth token. The token is a credential and an audit
         entry is a long-lived, widely-readable record — the two must not meet.
         `REDACTION_PATHS` would catch `authToken` in a log line, but an event
         payload is persisted to the outbox and projected into the audit log,
         where redaction never runs. */
      subaccountSid: z.string(),
      provider: z.string(),
    })
    .strict(),
);

export const subaccountStatusChanged = defineEvent(
  'subaccount.status_changed',
  z
    .object({
      subaccountSid: z.string(),
      status: z.enum(['active', 'suspended', 'closed']),
      /* Whether the carrier itself was updated, or only our record of it.
         These come apart when Twilio is unreachable during a freeze, and the
         difference is the whole question an incident responder has: is the
         compromised credential still usable directly against Twilio? */
      carrierUpdated: z.boolean(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Spend
 * -------------------------------------------------------------------------- */

/**
 * An outbound action was REFUSED by the gate.
 *
 * Named for what happened rather than for which check fired, with the reason in
 * the payload as a closed union — one event to subscribe to, so a future
 * refusal reason cannot quietly bypass an alert that was written to listen for
 * the three that existed when it was set up.
 */
export const spendLimitExceeded = defineEvent(
  'spend.limit_exceeded',
  z
    .object({
      reason: z.enum(TELEPHONY_REFUSALS),
      kind: z.enum(['call', 'sms', 'number_purchase', 'verification']),
      /* Cents, never the destination number. A refusal event is exactly the
         kind of thing that ends up on a dashboard, and §8.5's PII obligations
         do not pause because the action was denied. */
      estimatedCents: z.number().int().nonnegative(),
      spentCents: z.number().int().nonnegative(),
      capCents: z.number().int().nonnegative(),
    })
    .strict(),
);

/**
 * The org crossed a warning threshold of its cap while still being ALLOWED.
 *
 * Separate from the refusal above on purpose: by the time a call is refused the
 * org is already stopped, and "you have been cut off" is a worse first
 * notification than "you are at 80%". This is the one that gives someone time
 * to act.
 */
export const spendCapReached = defineEvent(
  'spend.cap_reached',
  z
    .object({
      spentCents: z.number().int().nonnegative(),
      capCents: z.number().int().nonnegative(),
      thresholdPercent: z.number().int().positive(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Wave 2 — numbers, calls, recordings, transcripts (§4)
 *
 * NO EVENT IN THIS FILE CARRIES A PHONE NUMBER.
 *
 * An outbox payload is persisted and projected into the audit log, where
 * `REDACTION_PATHS` never runs — redaction applies to log lines, not to rows.
 * So an event that carried `to` or `from` would write the PII that
 * `comms.calls` goes to the trouble of encrypting into a plaintext jsonb column
 * next to it. Consumers that need the number read the row, under RLS, with the
 * permission that guards it.
 * -------------------------------------------------------------------------- */

export const phoneNumberPurchased = defineEvent(
  'phone_number.purchased',
  z.object({ phoneNumberId: z.string(), isoCountry: z.string() }).strict(),
);

export const phoneNumberReleased = defineEvent(
  'phone_number.released',
  z.object({ phoneNumberId: z.string() }).strict(),
);

/**
 * A number's inbound routing config changed.
 *
 * No routing content in the payload, on the same reasoning as every other
 * event in this file — a route can name a forwarding target, and an outbox
 * payload is projected into the audit log where `REDACTION_PATHS` never
 * runs. Consumers that need the current config read the row, under RLS,
 * with `phoneNumber:read`.
 */
export const phoneNumberRouteChanged = defineEvent(
  'phone_number.route_changed',
  z.object({ phoneNumberId: z.string() }).strict(),
);

export const callPlaced = defineEvent(
  'call.placed',
  z.object({ callId: z.string(), direction: z.enum(['inbound', 'outbound']) }).strict(),
);

export const callStatusChanged = defineEvent(
  'call.status_changed',
  z
    .object({
      callId: z.string(),
      status: z.string(),
      durationSeconds: z.number().int().nonnegative().optional(),
    })
    .strict(),
);

/**
 * The consent decision for one call (§3.5).
 *
 * Its OWN event, not a field buried in `call.status_changed`. PLAN.md §8.5
 * requires the consent decision in the audit log, and `legal_hold.changed` from
 * Chat is the shape to follow: an entry naming a governance decision about a
 * resource, which a compliance review can find without knowing to unpack
 * another event's payload looking for it.
 */
export const consentRecorded = defineEvent(
  'call.consent_recorded',
  z
    .object({
      callId: z.string(),
      rule: z.enum(['all_party', 'one_party']),
      announcementRequired: z.boolean(),
      announcementPlayed: z.boolean(),
      /** WHY the requirement was what it was, e.g. `us_all_party_npa:415`. */
      basis: z.string(),
    })
    .strict(),
);

/**
 * The consent announcement finished playing (§3.5).
 *
 * Its own event rather than folded into `call.status_changed`, for the same
 * reason `call.consent_recorded` is its own event: `markAnnouncementPlayed`
 * is the write the `calls_recording_after_announcement` CHECK constraint
 * depends on — the fact that recording was allowed to start traces back to
 * this row, and a compliance review must be able to find it without
 * unpacking an unrelated status transition.
 */
export const callAnnouncementPlayed = defineEvent(
  'call.announcement_played',
  z.object({ callId: z.string() }).strict(),
);

export const recordingStarted = defineEvent(
  'recording.started',
  z.object({ callId: z.string(), recordingId: z.string() }).strict(),
);

export const recordingStored = defineEvent(
  'recording.stored',
  z
    .object({
      recordingId: z.string(),
      bytes: z.number().int().nonnegative(),
      durationSeconds: z.number().int().nonnegative(),
    })
    .strict(),
);

/**
 * A recording was DOWNLOADED — a read that gets an event anyway (§4).
 *
 * Guardrail 11 is framed around state mutation, and this mutates nothing. It is
 * here because PLAN.md §8.5 says "every download audited", and an action this
 * sensitive — step-up-gated, Owner-only access to a recorded phone call — is
 * exactly the read CLAUDE.md's audit section already treats as
 * compliance-relevant regardless of whether a row changed. Chat's
 * `compliance.exported` is the same exception.
 */
export const recordingDownloaded = defineEvent(
  'recording.downloaded',
  z.object({ recordingId: z.string(), callId: z.string() }).strict(),
);

export const transcriptionCompleted = defineEvent(
  'transcription.completed',
  z
    .object({
      recordingId: z.string(),
      transcriptId: z.string(),
      /* Which redaction rules fired, and how often. Never what they matched —
         that would put the PII into the audit log by the one route redaction
         cannot see. */
      redactionCounts: z.record(z.string(), z.number().int().nonnegative()),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Wave 3 — messaging (§4)
 *
 * As above: no event here carries a phone number or a message body. The body is
 * readable content, but an outbox payload is projected into the audit log, and
 * an audit entry is a far longer-lived and more widely-readable record than the
 * message row it describes.
 * -------------------------------------------------------------------------- */

/**
 * A new SMS conversation started (§3.8).
 *
 * `ensureThread` reports whether it created the row or found an existing
 * one, and this fires only on creation — a thread reused by a later message
 * mutates nothing new, and firing on every message would make this
 * indistinguishable from `message.sent`/`message.received`, which already
 * exist for that.
 */
export const messageThreadCreated = defineEvent(
  'message_thread.created',
  z.object({ threadId: z.string() }).strict(),
);

export const messageSent = defineEvent(
  'message.sent',
  z
    .object({
      threadId: z.string(),
      messageId: z.string(),
      segments: z.number().int().positive(),
    })
    .strict(),
);

export const messageReceived = defineEvent(
  'message.received',
  z.object({ threadId: z.string(), messageId: z.string() }).strict(),
);

export const messageDeliveryFailed = defineEvent(
  'message.delivery_failed',
  z
    .object({
      messageId: z.string(),
      status: z.string(),
      /* The carrier's error code, which names a CLASS of failure (unreachable
         handset, blocked number) and identifies nobody. */
      errorCode: z.string().optional(),
    })
    .strict(),
);

/**
 * Someone texted STOP (§8.5).
 *
 * Its own event rather than a flag on `message.received`, for the reason
 * `call.consent_recorded` is separate too: this is a governance decision about
 * a person's relationship with the org, and a compliance review must be able to
 * find it without knowing to unpack another event's payload.
 */
export const messageThreadOptedOut = defineEvent(
  'message_thread.opted_out',
  z
    .object({
      threadId: z.string(),
      reason: z.enum(['stop_keyword', 'manual', 'carrier_report']),
      revoked: z.boolean(),
    })
    .strict(),
);

export const recordingAttachedToCard = defineEvent(
  'recording.attached_to_card',
  z.object({ recordingId: z.string(), cardId: z.string() }).strict(),
);

export const recordingDetachedFromCard = defineEvent(
  'recording.detached_from_card',
  z.object({ recordingId: z.string(), cardId: z.string() }).strict(),
);

export const spendPolicyChanged = defineEvent(
  'spend_policy.changed',
  z
    .object({
      capCents: z.number().int().nonnegative(),
      previousCapCents: z.number().int().nonnegative(),
      windowDays: z.number().int().positive(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Wave 4 — Twilio Verify (§3.12, §4)
 *
 * No phone number here either, for the same reason as every other event in
 * this file — and doubly so for these three: a verification code exists to
 * prove a *person* controls a number, which makes the number the one piece of
 * PII an audit trail around this feature is least entitled to keep forever.
 * -------------------------------------------------------------------------- */

export const verificationStarted = defineEvent(
  'verification.started',
  z.object({ channel: z.enum(['sms', 'call']) }).strict(),
);

export const verificationSucceeded = defineEvent('verification.succeeded', z.object({}).strict());

export const verificationFailed = defineEvent('verification.failed', z.object({}).strict());
