import {
  claimPending,
  inArray,
  markDispatched,
  recordOperationalEvent,
  schema,
  withAuditScope,
  type OutboxRow,
} from '@taskflow/db';
import type { Logger } from '@taskflow/observability';
import { errorMessageOf } from './notification-push.js';
import { resolveActorLabels } from './notification.projection.js';
import type { ExpoPushProvider } from './push-provider.js';

/**
 * Native mobile push for a RINGING call (Phase 14, Tier 3 Pass B off the
 * mobile-vs-web audit) — the killed/backgrounded half of the gap
 * `apps/mobile/src/lib/call-keep.ts` names in its own header as out of its
 * scope. That file bridges an ALIVE app's own state to CallKit/
 * ConnectionService; this consumer is what still reaches a phone whose app
 * process is not running at all, or is backgrounded with its socket
 * disconnected — the case `rtc.incoming`'s six-second poll cannot help,
 * because nothing is polling.
 *
 * ## A real, visible push — not a silent wake, and that is a deliberate,
 * documented scope correction from this pass's original plan
 *
 * The original plan (named in the mobile README before this file existed)
 * was a DATA-ONLY push received by an `expo-notifications` background task
 * that calls `RNCallKeep.displayIncomingCall` directly, mirroring true VoIP
 * push. Two things make that the wrong shape for what Expo's push service
 * can actually deliver: `ExpoPushProvider`'s own header already establishes
 * that Expo's relay has no exposed `content-available`/silent-push knob —
 * inventing one here would be code nobody could verify does what its name
 * claims — and a background task on Android is not guaranteed to run at all
 * once the process is fully killed (OEM battery management, not this
 * codebase, decides that). A REAL, ordinary, visible push notification —
 * exactly what `ExpoPushProvider.send` already sends for every other
 * notification kind — needs neither claim: the OS shows it unconditionally,
 * tapping it opens the app and navigates through the exact same
 * `data.path` -> `mobilePathFor` -> `attachNotificationResponseListener`
 * pipeline every other push already uses (`notification-path.ts`,
 * `push-notifications.ts`), and once the app is open, `call-keep.ts`'s own
 * bridge and `IncomingCallBanner` pick the ringing call straight back up
 * from `rtc.incoming`. It does not put the call on the lock screen the way
 * real VoIP push would (Pass C, still not built) — it reaches the person at
 * all, which today it does not.
 *
 * ## A SEPARATE consumer, deliberately not a new `planNotifications` case
 *
 * `notification.projection.ts`'s own header, on `rtc_session.ended`'s
 * `call.missed`, already argues why a RINGING call cannot go through that
 * pipeline: "a notification for a call that is currently ringing would
 * arrive alongside the live ring the socket already delivers, and would
 * then be read minutes later as a row saying 'someone is calling' about a
 * call that ended long ago." That pipeline always persists a
 * `platform.notifications` row for every `push: true` recipient — durable
 * by design, and exactly wrong for a fact that stops being true the moment
 * the call is answered or ends. This consumer writes nothing to
 * `platform.notifications`; it only sends. `call.missed` (already shipped)
 * remains the durable record for a call nobody answered.
 *
 * ## Consumer name, and why one more costs nothing
 *
 * `claimPending`'s consumer argument is a free-form string (`platform.
 * outbox_dispatch`'s own shape, migration 0015) — adding `'rtc-call-wake'`
 * here needs no migration, no new role, no new grant beyond what
 * `taskflow_audit` already holds on `platform.expo_push_tokens` (migration
 * 0082's own `expo_push_tokens_audit_send` policy). It drains the identical
 * `rtc_session.started` events `apps/realtime`'s socket fan-out already
 * reads, under its own consumer name, so a slow or erroring wake send can
 * never starve the live ring and vice versa.
 *
 * ## Best-effort, on purpose, and NOT at-least-once the way its siblings are
 *
 * Every other outbox consumer in this codebase treats a transient send
 * failure as "leave it and retry next tick" (`notification-push.ts`'s own
 * header). That is wrong here: a call ring is not a fact that stays true
 * later the way a missed-call record does, and this batch already marks the
 * event dispatched regardless of send outcome — a push that fails is a ring
 * this pass could not deliver, not a ring to attempt again after the call
 * has likely already ended one way or another.
 *
 * ## Every attempt is now a row an operator can actually see
 *
 * This drain had NO observability at all before this — not even the
 * aggregate, tick-level `debug` log `notification-push.ts` had before ITS
 * own gap was closed the same way. A ring push that never reached anyone
 * looked identical to one that was never attempted; nothing distinguished
 * "no token registered for this person" from "Expo rejected it" from "it
 * was never even tried because the batch filtered the event out." Every
 * terminal outcome below now writes one `platform.operational_events` row
 * (`kind: 'push'`, matching `notification-push.ts`'s own kind — this is
 * still fundamentally an Expo push send, just from a second writer), so
 * the Operations tab is the answer to "did that call actually ring
 * anyone", not a guess.
 */

/** The consumer name this drain claims under. */
export const CALL_WAKE_CONSUMER = 'rtc-call-wake';

interface CallWakeEvent {
  readonly sessionId: string;
  readonly channelId: string;
  readonly callerId: string | null;
  readonly invitedUserIds: readonly string[];
}

/** Reads `rtc_session.started`'s own shape (`session.service.ts`'s `startSession`) — `null` for anything else, or a row missing what this needs. `callerId` is `row.actorId` — every domain event carries one — not a payload field. Exported for `call-wake.test.ts`; the rest of this file needs a real Postgres connection to test, which this sandbox does not have — the same split `expo-push.test.ts`'s own header explains. */
export function callWakeEvent(row: OutboxRow): CallWakeEvent | null {
  if (row.name !== 'rtc_session.started') return null;
  if (typeof row.payload !== 'object' || row.payload === null) return null;

  const fields = row.payload as {
    readonly sessionId?: unknown;
    readonly channelId?: unknown;
    readonly invitedUserIds?: unknown;
  };
  const sessionId = typeof fields.sessionId === 'string' ? fields.sessionId : null;
  const channelId = typeof fields.channelId === 'string' ? fields.channelId : null;
  if (sessionId === null || channelId === null) return null;

  const invitedUserIds = Array.isArray(fields.invitedUserIds)
    ? fields.invitedUserIds.filter((id): id is string => typeof id === 'string')
    : [];

  return { sessionId, channelId, callerId: row.actorId, invitedUserIds };
}

export interface CallWakeDrainResult {
  readonly processed: number;
  readonly attempted: number;
  readonly sent: number;
}

/**
 * One `platform.operational_events` row per terminal outcome — see this
 * file's own header. `target` is the RTC session id: this drain writes no
 * delivery-row equivalent of its own (its header already explains why —
 * "this consumer writes nothing to platform.notifications"), so the
 * session id is the one real, already-internal identifier that ties a row
 * here back to an actual call. Never the raw Expo token.
 */
function recordCallWakeOutcome(input: {
  readonly sessionId: string;
  readonly outcome: 'success' | 'failure';
  readonly reason: string;
  readonly error?: unknown;
}): void {
  void recordOperationalEvent({
    kind: 'push',
    outcome: input.outcome,
    target: input.sessionId,
    detail: {
      pathway: 'call-wake',
      reason: input.reason,
      ...(input.error === undefined ? {} : { error: errorMessageOf(input.error) }),
    },
  });
}

/**
 * One claim-and-send batch. `title` names the caller when 0087 can resolve
 * one ("Incoming call from Alice"), falling back to the older, generic
 * "Incoming call" otherwise — a corrected reasoning, not a stale one: the
 * name is not new information to anyone this rings (they are already a
 * member of the same channel the call is in, same as `planMissedCall`'s own
 * 0087 correction), Expo/APNs/FCM already see the far more sensitive
 * excerpt of every DM push this codebase sends, and every mainstream calling
 * app shows the caller's name on exactly this kind of banner. `path` reuses
 * `notification-paths.ts`'s own `'call'` case (`/chat?channel=…`) verbatim,
 * so it rides the SAME `mobilePathFor` translation every other call
 * notification already exercises, with no new mapping to maintain.
 */
export async function drainCallWake(
  expoPushProvider: ExpoPushProvider,
  logger: Logger,
  limit = 100,
): Promise<CallWakeDrainResult> {
  return withAuditScope(async (tx) => {
    const pending = await claimPending(tx, CALL_WAKE_CONSUMER, limit);
    if (pending.length === 0) return { processed: 0, attempted: 0, sent: 0 };

    const calls = pending
      .map((row) => callWakeEvent(row))
      .filter((event): event is CallWakeEvent => event !== null && event.invitedUserIds.length > 0);

    let attempted = 0;
    let sent = 0;

    if (calls.length > 0) {
      const userIds = [...new Set(calls.flatMap((call) => call.invitedUserIds))];
      const tokens = await tx
        .select({
          userId: schema.expoPushTokens.userId,
          expoPushToken: schema.expoPushTokens.expoPushToken,
        })
        .from(schema.expoPushTokens)
        .where(inArray(schema.expoPushTokens.userId, userIds));

      const tokensByUser = new Map<string, string[]>();
      for (const token of tokens) {
        const list = tokensByUser.get(token.userId) ?? [];
        list.push(token.expoPushToken);
        tokensByUser.set(token.userId, list);
      }

      /* One batched lookup for the whole tick — see `resolveActorLabels`'s
         own header on why `people.profiles` is the source and 0087 is the
         grant that makes it readable here at all. */
      const callerLabels = await resolveActorLabels(
        tx,
        calls.map((call) => call.callerId).filter((id): id is string => id !== null),
        logger,
      );

      for (const call of calls) {
        const path = `/chat?channel=${call.channelId}`;
        const callerLabel =
          call.callerId === null ? null : (callerLabels.get(call.callerId) ?? null);
        const title = callerLabel === null ? 'Incoming call' : `Incoming call from ${callerLabel}`;
        for (const userId of call.invitedUserIds) {
          const deviceTokens = tokensByUser.get(userId) ?? [];
          if (deviceTokens.length === 0) {
            /* No expo_push_tokens row for this invitee at all — the exact
               "why didn't my phone ring" answer that used to be silent. */
            recordCallWakeOutcome({
              sessionId: call.sessionId,
              outcome: 'failure',
              reason: 'no_device',
            });
            continue;
          }

          for (const expoPushToken of deviceTokens) {
            attempted += 1;
            try {
              const outcome = await expoPushProvider.send({
                expoPushToken,
                title,
                body: null,
                path,
              });
              if (outcome === 'sent') {
                sent += 1;
                recordCallWakeOutcome({
                  sessionId: call.sessionId,
                  outcome: 'success',
                  reason: 'sent',
                });
              } else {
                /* 'gone'/'failed' — a dead or refused token. Not pruned here:
                   `notification-push.ts`'s own drain already deletes a token
                   the moment Expo reports it gone on any OTHER notification,
                   and duplicating that DELETE here for a row that may already
                   not exist buys nothing a real notification wouldn't already
                   have caught within the hour. `reason` uses the SAME
                   vocabulary notification-push.ts's Operations rows do
                   ('rejected', not the raw 'failed' outcome name) so the two
                   pathways read as one system on that tab. */
                recordCallWakeOutcome({
                  sessionId: call.sessionId,
                  outcome: 'failure',
                  reason: outcome === 'gone' ? 'gone' : 'rejected',
                });
              }
            } catch (error) {
              /* See this file's own header on why a wake push does not get
                 the rest of this codebase's "leave it, retry next tick"
                 treatment — logged and left at that. */
              logger.warn({ err: error, channelId: call.channelId }, 'call-wake push failed');
              recordCallWakeOutcome({
                sessionId: call.sessionId,
                outcome: 'failure',
                reason: 'transient',
                error,
              });
            }
          }
        }
      }
    }

    await markDispatched(
      tx,
      CALL_WAKE_CONSUMER,
      pending.map((row) => row.id),
    );

    return { processed: pending.length, attempted, sent };
  });
}

/** Drains until the backlog is empty, bounded so a tick always returns — mirrors `drainNotificationsFully`'s own shape. */
export async function drainCallWakeFully(
  expoPushProvider: ExpoPushProvider,
  logger: Logger,
  batchSize = 100,
  maxBatches = 50,
): Promise<CallWakeDrainResult> {
  let processed = 0;
  let attempted = 0;
  let sent = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await drainCallWake(expoPushProvider, logger, batchSize);
    processed += result.processed;
    attempted += result.attempted;
    sent += result.sent;
    if (result.processed < batchSize) break;
  }

  return { processed, attempted, sent };
}
