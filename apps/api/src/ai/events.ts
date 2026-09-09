import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * AI Copilot domain events — the §2/§3 subset (ai/phase-15-ai-copilot-and-
 * permissions.md).
 *
 * Mirrors `apps/api/src/telephony/events.ts`'s own reasoning for why the
 * spend events exist at all: a budget that only prevents the next
 * completion is "the assistant quietly stopped answering." An event lets
 * Phase 9's notification machinery route it to someone who can raise the
 * budget or explain the spike.
 *
 * No event payload here carries a prompt, a completion, or tool-call input
 * — the identical reasoning telephony's own header gives for never carrying
 * a phone number: an outbox payload is persisted and projected into the
 * audit log, where `REDACTION_PATHS` never runs. `packages/ai` moving
 * org-authored CONTENT is exactly why CLAUDE.md names it a human-review
 * surface; an event catalog that copied that content into a second,
 * longer-lived store would undo the whole argument for encrypting the
 * provider credential in the first place.
 */

export const aiUsageRecorded = defineEvent(
  'ai_usage.recorded',
  z
    .object({
      feature: z.string(),
      provider: z.string(),
      model: z.string(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costCents: z.number().int().nonnegative(),
    })
    .strict(),
);

/**
 * The org's monthly AI budget was reached WHILE STILL BEING ALLOWED —
 * `spend.cap_reached`'s exact shape and reasoning: by the time a request is
 * refused the assistant is already unusable, so this is the one notification
 * that gives someone time to act before that happens.
 */
export const aiBudgetReached = defineEvent(
  'ai_budget.reached',
  z
    .object({
      spentCents: z.number().int().nonnegative(),
      budgetCents: z.number().int().nonnegative(),
      thresholdPercent: z.number().int().positive(),
    })
    .strict(),
);

/** A completion request was REFUSED by the budget gate, never reaching the provider. */
export const aiBudgetExceeded = defineEvent(
  'ai_budget.exceeded',
  z
    .object({
      reason: z.enum(['org_suspended', 'budget_exceeded']),
      spentCents: z.number().int().nonnegative(),
      budgetCents: z.number().int().nonnegative(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Provider catalog & org overrides (§2.3) — operator actions
 *
 * `taskflow_platform_admin` holds no grant on `platform.outbox` (migration
 * 0083's own header), so these publish directly through the injected
 * `EventBus` rather than `outboxWriter.append`, the identical shape
 * `flags.service.ts`'s `setFlag` already uses for the same reason. No event
 * payload carries a key, a ciphertext, or a wrapped data key — the same
 * redaction argument telephony's own events.ts gives for a phone number: an
 * outbox payload is projected into the audit log, where `REDACTION_PATHS`
 * never runs.
 * -------------------------------------------------------------------------- */

export const aiProviderConfigCreated = defineEvent(
  'ai_provider_config.created',
  z.object({ id: z.string(), provider: z.string(), model: z.string() }).strict(),
);

export const aiProviderConfigKeyRotated = defineEvent(
  'ai_provider_config.key_rotated',
  z.object({ id: z.string() }).strict(),
);

export const aiProviderConfigDefaultChanged = defineEvent(
  'ai_provider_config.default_changed',
  z.object({ id: z.string() }).strict(),
);

export const aiOrgOverrideSet = defineEvent(
  'ai_org_override.set',
  z.object({ providerConfigId: z.string() }).strict(),
);

export const aiOrgOverrideCleared = defineEvent('ai_org_override.cleared', z.object({}).strict());
