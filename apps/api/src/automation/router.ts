import { z } from 'zod';
import { FilterTree } from '@taskflow/filter';
import { PhoneNumberTextSchema, type KeyProvider } from '@taskflow/contracts';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import * as automations from './automation.service.js';
import * as webhooks from './webhook.service.js';
import type { AutomationActor } from './automation.service.js';

/**
 * Automation rule routes (ai/phase-10-automation.md §1, §2).
 *
 * Every route floors on `automation:manage`, which §9 decision 4 made
 * org-level — so a relationship tuple cannot satisfy it, and the floor really
 * is the whole authorization decision at THIS layer. That is safe only because
 * the resource-aware question is asked somewhere else entirely: at execution,
 * by the worker, against the rule owner's live permissions, per action (§2).
 *
 * ## The action schema is the write boundary
 *
 * `AutomationActionSchema` below is what decides which actions can exist in the
 * database at all. It is a discriminated union of literal types with typed
 * arguments — there is no variant carrying a script, a template, or a free-form
 * object, and adding one is a deliberate edit here plus a branch in the
 * worker's exhaustive switch. A rule is data.
 */

const AutomationName = z.string().trim().min(1).max(120);

/**
 * The write boundary's action union for one deployment.
 *
 * Every variant is a Zod object with `.strict()`, so an unrecognized field is
 * refused rather than silently stored and then ignored by the executor — a
 * stored field nothing reads is a promise the UI can make and the engine will
 * not keep.
 *
 * Built as a FUNCTION of the deployment flag rather than a constant because
 * that flag decides which actions EXIST here at all (§9 decision 3): with
 * AUTOMATION_TELEPHONY_ACTIONS_ENABLED off (the default), the cost-bearing
 * variants below are not part of the union, so the write boundary refuses a
 * rule containing one with the same error a mistyped action type gets. The
 * flag gates the product surface, never a security control — every gate a
 * telephony action passes runs unconditionally at execution, and the worker
 * re-refuses the actions when the flag is off there too.
 *
 * Exported so the boundary itself is testable without a router — the property
 * "a rule containing a telephony action cannot be SAVED while the flag is
 * off" is exactly the kind of claim a schema-only test can pin.
 *
 * The variants are INLINE rather than hoisted into named arrays because
 * `z.discriminatedUnion` needs its options as a literal tuple to keep each
 * variant's type — an intermediate array widens to `ZodObject[]` and the
 * union's inferred output collapses, which is how a rule would validate at
 * the boundary and then fail the service's own type check.
 */
export function buildAutomationActionSchema(telephonyActionsEnabled: boolean) {
  return z.discriminatedUnion('type', [
    z.object({ type: z.literal('card.move'), listId: z.string().uuid() }).strict(),
    z.object({ type: z.literal('card.set_status'), statusId: z.string().uuid() }).strict(),
    z
      .object({
        type: z.literal('card.set_priority'),
        priority: z.enum(['urgent', 'high', 'normal', 'low']),
      })
      .strict(),
    z.object({ type: z.literal('card.assign'), userId: z.string().uuid() }).strict(),
    z.object({ type: z.literal('card.add_label'), labelId: z.string().uuid() }).strict(),
    z.object({ type: z.literal('card.remove_label'), labelId: z.string().uuid() }).strict(),
    z.object({ type: z.literal('card.unassign'), userId: z.string().uuid() }).strict(),
    /* The same plain-TEXT body rule as `chat.post_message` below: the executor
       wraps it in a paragraph, so a rule can never store a user-supplied
       document to be handed to `createComment`'s validator from storage. */
    z
      .object({ type: z.literal('card.add_comment'), body: z.string().trim().min(1).max(2_000) })
      .strict(),
    z
      .object({
        type: z.literal('chat.post_message'),
        channelId: z.string().uuid(),
        /* Plain TEXT, not a rich-text document. The executor wraps it in a
           paragraph; letting a rule store arbitrary TipTap JSON would put a
           user-supplied document into a column and then hand it to
           `sendMessage`'s validator from storage rather than from a request,
           which is a second path to the same parser for no gain. */
        body: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    /* Wave 2 — the first action that reaches a network the org does not
       control. It names an org-registered webhook, never a URL: the URL lives
       in the registry (floored on `webhook:manage`), the SSRF gate runs per hop
       at DELIVERY time, and a rule can never smuggle an endpoint past either. */
    z.object({ type: z.literal('call_webhook'), webhookId: z.string().uuid() }).strict(),
    /* Wave 4 — the cost-bearing actions (§5.5), present only when the flag is
       on. `to` is validated against the same E.164 pattern the click-to-call
       route uses — a rule stores a real destination or nothing. It is the
       PLAIN-STRING schema (`PhoneNumberTextSchema`) rather than the branded
       `PhoneNumberSchema` because `automations.actions` is a jsonb column: the
       value is stored and read back as text, the worker re-brands it at the
       boundary, and a branded output would make this exported schema
       un-nameable for `tsc --declaration` (the `UuidSchema` precedent).
       `record` is deliberately absent: an unattended rule must never be able
       to start recording a person. */
    ...(telephonyActionsEnabled
      ? [
          z
            .object({
              type: z.literal('call.place'),
              to: PhoneNumberTextSchema,
              fromPhoneNumberId: z.string().uuid(),
            })
            .strict(),
          z
            .object({
              type: z.literal('sms.send'),
              to: PhoneNumberTextSchema,
              fromPhoneNumberId: z.string().uuid(),
              /* Bounded here as well as at the service, mirroring the
                 messages.send route: a body longer than this is more segments
                 than anyone intends to buy — and segments are what the ledger
                 is charged per. */
              body: z.string().trim().min(1).max(1600),
            })
            .strict(),
        ]
      : []),
  ]);
}

/** 1..10, mirroring migration 0047's CHECK — a rule nobody can reason about helps nobody. */
const AutomationActions = (telephonyActionsEnabled: boolean) =>
  z.array(buildAutomationActionSchema(telephonyActionsEnabled)).min(1).max(10);

const AutomationBody = (telephonyActionsEnabled: boolean) =>
  z.object({
    name: AutomationName,
    description: z.string().trim().max(500).nullable().default(null),
    /* A plain string, validated against the LIVE event registry in the service.
       A Zod enum here would be a second copy of the event catalog that goes stale
       the next time a slice adds an event. */
    triggerEvent: z.string().trim().min(1).max(120),
    /* Shape here, MEANING in the service — `FilterTree` does not know the tree is
       filtering cards, so it accepts a field that does not exist as readily as
       one that does. `assertConditionUsable` is what closes that. */
    condition: FilterTree.nullable().default(null),
    actions: AutomationActions(telephonyActionsEnabled),
    enabled: z.boolean().default(true),
  });

const AutomationSummaryOutput = z.object({
  automationId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  triggerEvent: z.string(),
  condition: z.unknown(),
  actions: z.array(z.unknown()).readonly(),
  enabled: z.boolean(),
  createdBy: z.string(),
  conditionBroken: z.boolean(),
});

function actorOf(ctx: {
  principal: Parameters<typeof subjectOf>[0];
  requestId: AutomationActor['requestId'];
}): AutomationActor {
  return { subject: subjectOf(ctx.principal), requestId: ctx.requestId };
}

export function createAutomationRouter(deps: {
  readonly keys: KeyProvider;
  /**
   * §9 decision 3's product-surface gate: whether the cost-bearing telephony
   * actions exist in the rule builder at all. OFF by default (the env default),
   * and a rule containing one cannot even be SAVED while it is off — the
   * schema below refuses it. Every security control runs unconditionally at
   * execution regardless; see `buildAutomationActionSchema`'s comment.
   */
  readonly telephonyActionsEnabled: boolean;
}) {
  const Body = AutomationBody(deps.telephonyActionsEnabled);
  return router({
    /**
     * What the rule builder may offer (§9 decision 3) — the deployment-level
     * half of the product-surface flag, answered through the real router so
     * the UI never hard-codes a copy of the env. A rule containing a
     * telephony action cannot be SAVED while this is false (the schema above
     * is built from the same value), so a builder offering one would be
     * offering a rule that cannot exist. Floored on `automation:manage` like
     * every route here: only someone who can build rules needs to know what
     * the builder offers.
     */
    capabilities: route({ permission: 'automation:manage' })
      .input(z.object({}).strict())
      .output(z.object({ telephonyActionsEnabled: z.boolean() }))
      .query(() => ({ telephonyActionsEnabled: deps.telephonyActionsEnabled })),

    list: route({ permission: 'automation:manage' })
      .input(z.object({}).strict())
      .output(z.array(AutomationSummaryOutput).readonly())
      .query(({ ctx }) => automations.listAutomations(actorOf(ctx))),

    create: route({ permission: 'automation:manage' })
      .input(Body.strict())
      .output(z.object({ automationId: z.string() }))
      .mutation(({ input, ctx }) => automations.createAutomation(actorOf(ctx), input)),

    update: route({ permission: 'automation:manage' })
      .input(Body.extend({ automationId: z.string().uuid() }).strict())
      .output(z.object({ name: z.string() }))
      .mutation(({ input, ctx }) => automations.updateAutomation(actorOf(ctx), input)),

    /**
     * The kill switch. Its own route rather than a field on `update` so stopping
     * a misbehaving rule does not require sending back a complete, valid rule
     * body — which would run the emergency path through the same validation that
     * might refuse the very rule someone is trying to stop.
     */
    setEnabled: route({ permission: 'automation:manage' })
      .input(z.object({ automationId: z.string().uuid(), enabled: z.boolean() }).strict())
      .output(z.object({ enabled: z.boolean() }))
      .mutation(({ input, ctx }) => automations.setAutomationEnabled(actorOf(ctx), input)),

    delete: route({ permission: 'automation:manage' })
      .input(z.object({ automationId: z.string().uuid() }).strict())
      .output(z.object({ deleted: z.literal(true) }))
      .mutation(({ input, ctx }) => automations.deleteAutomation(actorOf(ctx), input)),

    /**
     * Run history, org tier (§9 decision 8).
     *
     * RLS scopes it to this org and the input has no vocabulary for asking about
     * another one — the platform tier is a separate surface reading a separate
     * scope, deliberately not this screen with a filter.
     */
    runs: route({ permission: 'automation:manage' })
      .input(
        z
          .object({
            automationId: z.string().uuid().optional(),
            limit: z.number().int().min(1).max(200).default(50),
          })
          .strict(),
      )
      .output(
        z
          .array(
            z.object({
              runId: z.string(),
              automationId: z.string(),
              triggerEvent: z.string(),
              status: z.string(),
              reason: z.string().nullable(),
              actionResults: z.array(z.unknown()).readonly(),
              depth: z.number(),
              durationMs: z.number().nullable(),
              createdAt: z.date(),
            }),
          )
          .readonly(),
      )
      .query(({ input, ctx }) =>
        automations.listAutomationRuns(actorOf(ctx), {
          limit: input.limit,
          /* Conditional spread rather than passing `input` whole:
           `exactOptionalPropertyTypes` makes "absent" and "present and
           undefined" different types, and Zod's `.optional()` produces the
           latter. The repo's idiom throughout. */
          ...(input.automationId === undefined ? {} : { automationId: input.automationId }),
        }),
      ),

    /**
     * The webhook registry (Wave 2, ai/phase-10-automation.md §5) — nested here
     * rather than top-level because it exists to be named by a rule's action,
     * and the /automations page owns its UI. Floored on `webhook:manage`, the
     * third of §9 decision 4's org-level permissions, so a relationship tuple
     * can never satisfy it.
     *
     * The URL is stored SHAPE-checked and re-checked per redirect hop at
     * delivery; the signing secret is minted here and shown exactly once.
     */
    webhooks: router({
      list: route({ permission: 'webhook:manage' })
        .input(z.object({}).strict())
        .output(z.array(WebhookSummaryOutput).readonly())
        .query(({ ctx }) => webhooks.listWebhooks(actorOf(ctx))),

      create: route({ permission: 'webhook:manage' })
        .input(z.object({ name: WebhookName, url: WebhookUrl }).strict())
        /* The signing secret rides this one response and nowhere else — the
         output schema is the full contract for "shown once". */
        .output(z.object({ webhookId: z.string(), signingSecret: z.string() }))
        .mutation(({ input, ctx }) => webhooks.createWebhook(actorOf(ctx), input, deps.keys)),

      update: route({ permission: 'webhook:manage' })
        .input(
          z.object({ webhookId: z.string().uuid(), name: WebhookName, url: WebhookUrl }).strict(),
        )
        .output(z.object({ name: z.string() }))
        .mutation(({ input, ctx }) => webhooks.updateWebhook(actorOf(ctx), input)),

      /* The kill switch, own route, same reasoning as `automation.setEnabled`. */
      setEnabled: route({ permission: 'webhook:manage' })
        .input(z.object({ webhookId: z.string().uuid(), enabled: z.boolean() }).strict())
        .output(z.object({ enabled: z.boolean() }))
        .mutation(({ input, ctx }) => webhooks.setWebhookEnabled(actorOf(ctx), input)),

      delete: route({ permission: 'webhook:manage' })
        .input(z.object({ webhookId: z.string().uuid() }).strict())
        .output(z.object({ deleted: z.literal(true) }))
        .mutation(({ input, ctx }) => webhooks.deleteWebhook(actorOf(ctx), input)),

      /** Recent delivery history for one endpoint — the "did it go out" read. */
      deliveries: route({ permission: 'webhook:manage' })
        .input(
          z
            .object({
              webhookId: z.string().uuid(),
              limit: z.number().int().min(1).max(100).default(25),
            })
            .strict(),
        )
        .output(z.array(WebhookDeliveryOutput).readonly())
        .query(({ input, ctx }) =>
          webhooks.listWebhookDeliveries(actorOf(ctx), {
            webhookId: input.webhookId,
            limit: input.limit,
          }),
        ),
    }),
  });
}

const WebhookName = z.string().trim().min(1).max(120);
const WebhookUrl = z.string().trim().min(1).max(2048);

const WebhookSummaryOutput = z.object({
  webhookId: z.string(),
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  disabledAt: z.date().nullable(),
  failureCount: z.number().int().nonnegative(),
  createdAt: z.date(),
});

const WebhookDeliveryOutput = z.object({
  deliveryId: z.string(),
  webhookId: z.string(),
  eventId: z.string(),
  eventName: z.string(),
  status: z.string(),
  attempts: z.number().int().nonnegative(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  nextAttemptAt: z.date(),
  createdAt: z.date(),
});
