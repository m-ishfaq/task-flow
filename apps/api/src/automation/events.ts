import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Automation-rule events — guardrail 6 (ai/phase-10-automation.md).
 *
 * These describe changes to the RULES themselves, never to what the rules did:
 * a rule's executions are recorded in `platform.automation_runs`, which is
 * operational telemetry with its own retention, while these are governance
 * facts that belong in the org's hash-chained audit log.
 *
 * ## What the payloads carry, and what they refuse to
 *
 * Not the CONDITION tree, and not the ACTIONS. Both are the interesting part of
 * a rule and both would be projected into the audit log, which is far more
 * widely readable than the rule row — the same call `work/events.ts` makes for
 * `view.created`'s filter and `chat/events.ts` makes for message bodies.
 *
 * `enabled` IS carried on every one of them, because it is the fact an
 * incident review actually asks about: who turned this rule on, and when. A
 * rule that quietly starts acting is the thing worth being able to reconstruct.
 */

export const automationCreated = defineEvent(
  'automation.created',
  z
    .object({
      automationId: z.string(),
      name: z.string(),
      triggerEvent: z.string(),
      enabled: z.boolean(),
      actionCount: z.number().int().positive(),
    })
    .strict(),
);

export const automationUpdated = defineEvent(
  'automation.updated',
  z
    .object({
      automationId: z.string(),
      name: z.string(),
      triggerEvent: z.string(),
      /* The BEFORE value, per this codebase's standing rule: an event saying
         only what `enabled` became cannot answer whether it changed, and
         "somebody enabled a rule" is exactly the transition worth finding. */
      wasEnabled: z.boolean(),
      enabled: z.boolean(),
      actionCount: z.number().int().positive(),
    })
    .strict(),
);

export const automationDeleted = defineEvent(
  'automation.deleted',
  z.object({ automationId: z.string(), name: z.string() }).strict(),
);
