import { z } from 'zod';
import { CardIdSchema, PhoneNumberSchema, errors } from '@taskflow/contracts';
import { InboundRoute } from '@taskflow/telephony';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import type { TelephonyActor } from './shared.js';
import type { TelephonyDeps } from './deps.js';
import * as numbers from './number.service.js';
import * as calls from './call.service.js';
import * as recordings from './recording.service.js';
import * as transcripts from './transcript.service.js';
import * as messages from './message.service.js';
import * as recordingCards from './recording-card.service.js';
import { readSpendState } from './spend-gate.js';
import { spendReport } from './spend-report.service.js';

/**
 * Telephony routes (ai/phase-7-voice.md Wave 2).
 *
 * ## `route({ permission })` genuinely IS the check here
 *
 * `chat/router.ts` and `docs/router.ts` both warn that their route-level gate
 * "barely narrows anything", because MEMBER holds the relevant permission for
 * every channel or page and the real decision happens once the row is loaded.
 * Telephony is the opposite case, and §6.3 says why: every telephony permission
 * is a FLAT role grant with no relationship-tuple or ancestor component. There
 * is no second layer because there is nothing for one to resolve — the role
 * decides, and `can()`'s existing role-only path produces a correct decision
 * trace with no telephony-specific resolver.
 *
 * The tiering is real and was chosen before this phase existed
 * (`packages/policy/src/roles.ts`):
 *
 *   MEMBER  phoneNumber:read, call:place, call:read, sms:send, sms:read
 *   ADMIN   + recording:read
 *   OWNER   + phoneNumber:purchase, phoneNumber:release, recording:export
 *
 * ## The routes always EXIST, even with no carrier configured
 *
 * Tempting to register them only when `buildTelephonyDeps` returns something —
 * and wrong, because `AppRouter`'s TYPE is what the browser client generates
 * from (guardrail 5). A router whose shape depends on a deployment's env would
 * make the generated client differ between environments, which is exactly the
 * drift that guarantee exists to prevent.
 *
 * So the routes are always present and answer SERVICE_UNAVAILABLE when there is
 * no carrier. That is also the more honest failure: 'telephony is not
 * configured on this instance' rather than a procedure the client's own types
 * say exists and the server 404s.
 */

function actorOf(ctx: {
  principal: Parameters<typeof subjectOf>[0];
  requestId: TelephonyActor['requestId'];
}): TelephonyActor {
  return { subject: subjectOf(ctx.principal), requestId: ctx.requestId };
}

export function createTelephonyRouter(maybeDeps: TelephonyDeps | undefined) {
  /* Resolved per call, not once: an unconfigured instance must fail at the
     REQUEST, not at boot — a missing carrier is a valid deployment. */
  const deps = (): TelephonyDeps => {
    if (maybeDeps === undefined) {
      throw errors.serviceUnavailable('Telephony is not configured on this instance.');
    }
    return maybeDeps;
  };
  return router({
    numbers: router({
      list: route({
        permission: 'phoneNumber:read',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({}).strict())
        .query(async ({ ctx }) => numbers.listNumbers(actorOf(ctx).subject.orgId)),

      search: route({
        permission: 'phoneNumber:purchase',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(
          z
            .object({
              isoCountry: z.string().length(2).toUpperCase(),
              areaCode: z
                .string()
                .regex(/^[0-9]{3}$/)
                .optional(),
              limit: z.number().int().min(1).max(20).default(10),
            })
            .strict(),
        )
        .query(async ({ ctx, input }) =>
          numbers.searchNumbers(actorOf(ctx), deps(), {
            isoCountry: input.isoCountry,
            areaCode: input.areaCode,
            limit: input.limit,
          }),
        ),

      /* Owner-only AND step-up. Buying a number spends real money on a
         recurring basis, which is the same bar `recording:export` clears — and
         a stolen session that can silently buy numbers is a slow, quiet way to
         drain a balance without ever placing a call. */
      purchase: route({
        permission: 'phoneNumber:purchase',
        stepUp: true,
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ phoneNumber: PhoneNumberSchema }).strict())
        .mutation(async ({ ctx, input }) =>
          numbers.purchaseNumber(actorOf(ctx), deps(), { phoneNumber: input.phoneNumber }),
        ),

      release: route({
        permission: 'phoneNumber:release',
        stepUp: true,
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ phoneNumberId: z.string().uuid() }).strict())
        .mutation(async ({ ctx, input }) => {
          await numbers.releaseNumber(actorOf(ctx), deps(), {
            phoneNumberId: input.phoneNumberId,
          });
        }),

      /* Routing config changes what happens to a live caller, and can direct
         them at a member's phone — an admin capability, not a member one. It
         reuses `phoneNumber:purchase` rather than inventing a permission the
         matrix test has never seen; §6.3's point is that this phase consumes
         the catalog rather than extending it. */
      setRoute: route({
        permission: 'phoneNumber:purchase',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ phoneNumberId: z.string().uuid(), route: InboundRoute }).strict())
        .mutation(async ({ ctx, input }) => {
          await numbers.setInboundRoute(actorOf(ctx), {
            phoneNumberId: input.phoneNumberId,
            route: input.route,
          });
        }),
    }),

    calls: router({
      list: route({
        permission: 'call:read',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }).strict())
        .query(async ({ ctx, input }) =>
          calls.listCalls(actorOf(ctx).subject.orgId, deps(), { limit: input.limit }),
        ),

      place: route({
        permission: 'call:place',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(
          z
            .object({
              to: PhoneNumberSchema,
              fromPhoneNumberId: z.string().uuid(),
              /* Defaults to FALSE. Recording by default with an opt-out means
                 the failure mode of forgetting a flag is an unlawfully recorded
                 call. */
              record: z.boolean().default(false),
            })
            .strict(),
        )
        .mutation(async ({ ctx, input }) =>
          calls.placeCall(actorOf(ctx), deps(), {
            to: input.to,
            fromPhoneNumberId: input.fromPhoneNumberId,
            record: input.record,
          }),
        ),
    }),

    recordings: router({
      list: route({
        permission: 'recording:read',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ callId: z.string().uuid() }).strict())
        .query(async ({ ctx, input }) =>
          recordings.listRecordings(actorOf(ctx), { callId: input.callId }),
        ),

      /**
       * Every stored recording, org-wide — the browse view `recording-
       * section.tsx`'s own header names as missing (only per-call and
       * per-card lists existed). `before` is a `createdAt` cursor, mirroring
       * `tenancy.audit.list`'s own cursor shape one column over.
       */
      browse: route({
        permission: 'recording:read',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(
          z
            .object({
              limit: z.number().int().min(1).max(100).default(50),
              before: z.string().datetime().nullable().default(null),
            })
            .strict(),
        )
        .query(async ({ ctx, input }) =>
          recordings.listOrgRecordings(actorOf(ctx), deps(), {
            limit: input.limit,
            before: input.before === null ? null : new Date(input.before),
          }),
        ),

      /**
       * Owner-only, step-up, and audited.
       *
       * PLAN.md §8.5: "Access requires explicit permission plus step-up auth.
       * Every download audited." `stepUp: true` is the second of those — a
       * credential proven more than five minutes ago is refused, so a stolen
       * session cannot quietly export recordings hours later.
       */
      download: route({
        permission: 'recording:export',
        stepUp: true,
        quotaClass: 'expensive',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ recordingId: z.string().uuid() }).strict())
        .mutation(async ({ ctx, input }) =>
          recordings.presignRecording(actorOf(ctx), deps(), { recordingId: input.recordingId }),
        ),

      transcript: route({
        permission: 'recording:read',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ recordingId: z.string().uuid() }).strict())
        .query(async ({ ctx, input }) =>
          transcripts.getTranscript(actorOf(ctx), { recordingId: input.recordingId }),
        ),
    }),

    /**
     * SMS (Wave 3, §3.8).
     *
     * `sms:read`/`sms:send` — Member-level, and NOT `chat:read`. An SMS thread
     * is a parallel resource the Chat inbox merges in on the read side; it is
     * not a `chat.channels` row and does not borrow its permissions.
     */
    messages: router({
      threads: route({
        permission: 'sms:read',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }).strict())
        .query(async ({ ctx, input }) =>
          messages.listThreads(actorOf(ctx).subject.orgId, deps(), { limit: input.limit }),
        ),

      list: route({
        permission: 'sms:read',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(
          z
            .object({
              threadId: z.string().uuid(),
              limit: z.number().int().min(1).max(200).default(100),
            })
            .strict(),
        )
        .query(async ({ ctx, input }) =>
          messages.listMessages(actorOf(ctx).subject.orgId, {
            threadId: input.threadId,
            limit: input.limit,
          }),
        ),

      send: route({
        permission: 'sms:send',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(
          z
            .object({
              to: PhoneNumberSchema,
              fromPhoneNumberId: z.string().uuid(),
              /* Bounded here as well as by the CHECK on the column. A body
                 longer than this is more segments than anyone intends to buy —
                 and segments are what the ledger is charged per. */
              body: z.string().trim().min(1).max(1600),
            })
            .strict(),
        )
        .mutation(async ({ ctx, input }) =>
          messages.sendSms(actorOf(ctx), deps(), {
            to: input.to,
            fromPhoneNumberId: input.fromPhoneNumberId,
            body: input.body,
          }),
        ),
    }),

    /**
     * Recordings attached to Work cards (Wave 3, §3.9).
     *
     * The route-level permission is `recording:read`; the service ALSO enforces
     * `card:read`/`card:update`. Two checks, deliberately not merged — a member
     * holds `card:read` and not `recording:read`, so collapsing them would
     * either stop admins attaching or disclose recordings to everyone who can
     * open the card.
     */
    cards: router({
      recordings: route({
        permission: 'recording:read',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ cardId: CardIdSchema }).strict())
        .query(async ({ ctx, input }) =>
          recordingCards.listCardRecordings(actorOf(ctx), { cardId: input.cardId }),
        ),

      attach: route({
        permission: 'recording:read',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ recordingId: z.string().uuid(), cardId: CardIdSchema }).strict())
        .mutation(async ({ ctx, input }) => {
          await recordingCards.attachRecordingToCard(actorOf(ctx), {
            recordingId: input.recordingId,
            cardId: input.cardId,
          });
        }),

      detach: route({
        permission: 'recording:read',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ recordingId: z.string().uuid(), cardId: CardIdSchema }).strict())
        .mutation(async ({ ctx, input }) => {
          await recordingCards.detachRecordingFromCard(actorOf(ctx), {
            recordingId: input.recordingId,
            cardId: input.cardId,
          });
        }),
    }),

    spend: router({
      /**
       * What this org has spent, and against what cap.
       *
       * `phoneNumber:read` (Member) rather than an admin permission: a member
       * who is about to be refused for a spend cap should be able to see that
       * is why, and the figures are the org's own aggregate, not anyone's
       * personal data.
       */
      current: route({
        permission: 'phoneNumber:read',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({}).strict())
        .query(async ({ ctx }) => {
          /* `readSpendState`, NOT `checkOutboundAllowed`. The full gate runs the
             velocity limiter, which MUTATES — so a spend page built on it would
             consume the viewer's own burst allowance every time it rendered, and
             looking at a dashboard would throttle your ability to place calls.
             Both paths share the same read, so the number shown and the number
             enforced cannot drift. */
          const state = await readSpendState(actorOf(ctx).subject.orgId, {
            defaultCapCents: deps().defaultSpendCapCents,
          });
          return {
            spentCents: state.spentCents,
            capCents: state.capCents,
            /* The sub-budget figures (§5.5) ride the same read the gate
               enforces from, so what a page shows and what the gate refuses
               cannot drift. `automationCapCents` is null when the org has not
               configured a separate ceiling. */
            automationSpentCents: state.automationSpentCents,
            automationCapCents: state.automationCapCents,
          };
        }),

      /**
       * Cost attribution by kind (Wave 4, §5 — "admin-facing spend
       * visibility"). `recording:read` rather than `phoneNumber:read`: this
       * is the org's full itemized spend, not "am I about to be refused",
       * and the tier that clears is the same one `router.ts`'s own comment
       * names as ADMIN. There is no dedicated report permission in the
       * catalog for the identical reason `setRoute` above reuses
       * `phoneNumber:purchase` instead of inventing one — §6.3 has this
       * phase consume the permission catalog rather than extend it.
       */
      report: route({
        permission: 'recording:read',
        quotaClass: 'expensive',
        feature: { flag: 'telephony', display: 'Voice & Messaging' },
      })
        .input(z.object({ sinceDays: z.number().int().min(1).max(365).default(30) }).strict())
        .query(async ({ ctx, input }) =>
          spendReport(actorOf(ctx).subject.orgId, { sinceDays: input.sinceDays }),
        ),
    }),
  });
}
