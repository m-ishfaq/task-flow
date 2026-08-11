import { z } from 'zod';
import { FilterTree } from '@taskflow/filter';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import * as automations from './automation.service.js';
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
 * One action, as a rule may store it.
 *
 * `.strict()` on every variant, so an unrecognized field is refused rather than
 * silently stored and then ignored by the executor — a stored field nothing
 * reads is a promise the UI can make and the engine will not keep.
 */
const AutomationActionSchema = z.discriminatedUnion('type', [
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
]);

/** 1..10, mirroring migration 0047's CHECK — a rule nobody can reason about helps nobody. */
const AutomationActions = z.array(AutomationActionSchema).min(1).max(10);

const AutomationBody = z.object({
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
  actions: AutomationActions,
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

export const automationRouter = router({
  list: route({ permission: 'automation:manage' })
    .input(z.object({}).strict())
    .output(z.array(AutomationSummaryOutput).readonly())
    .query(({ ctx }) => automations.listAutomations(actorOf(ctx))),

  create: route({ permission: 'automation:manage' })
    .input(AutomationBody.strict())
    .output(z.object({ automationId: z.string() }))
    .mutation(({ input, ctx }) => automations.createAutomation(actorOf(ctx), input)),

  update: route({ permission: 'automation:manage' })
    .input(AutomationBody.extend({ automationId: z.string().uuid() }).strict())
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
});
