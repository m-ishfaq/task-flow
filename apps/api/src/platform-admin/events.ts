import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Platform-admin domain events — guardrail 11 (PLAN.md §2.1;
 * ai/phase-12-admin.md §4).
 *
 * Four events, three of them the wave's own catalog and the fourth a
 * deliberate extension of it: `platform.flag_override_set` is not in the spec's
 * list of four, but guardrail 11 is non-negotiable and `flags.set` is a state
 * mutation — a typed event is what the rule requires, and flag governance is
 * exactly the kind of fact this system's audit log exists to answer.
 *
 * ## Delivery: the EventBus, not the outbox
 *
 * These events are published through the in-process `EventBus` dependency,
 * the identical path people's `profile.updated` uses, for the identical
 * structural reason: `platform.outbox`'s RLS policy is `org_id = app.org_id`
 * on WITH CHECK (migration 0006), and the role that performs these mutations
 * is `taskflow_platform_admin` — which holds no grant on the outbox and whose
 * writes happen with no org scope at all. The outbox cannot hold them. The
 * durable, chained records of these actions are the TWO audit writes the
 * services themselves perform (§4, decision 2 option (c)): the target org's
 * own `audit.audit_log` chain for org-scoped actions, and the global
 * `platform.operator_audit_log` for every action. The published event is what
 * a future in-process consumer (Phase 7's org-freeze fast path, §9) subscribes
 * to.
 */

/**
 * An organization was suspended by a platform operator.
 *
 * The target org's own audit chain is written directly by the suspending
 * service (§4, decision 2 option (c)) — an Owner sees \"a platform operator
 * suspended this org\" in their own audit history with no operator access
 * required. The event itself carries the operator id so a subscriber (Phase
 * 7's org-freeze check) never has to correlate.
 */
export const orgSuspended = defineEvent(
  'platform.org_suspended',
  z.object({ orgId: z.string(), operatorUserId: z.string() }).strict(),
);

/** The inverse of `orgSuspended` — an operator restored the org. */
export const orgReactivated = defineEvent(
  'platform.org_reactivated',
  z.object({ orgId: z.string(), operatorUserId: z.string() }).strict(),
);

/**
 * Someone became a platform operator (§4).
 *
 * Wave 1 ships no self-service route for this (§7 decision 7: migration or
 * one-off script only), so in practice this event's only producer is a
 * migration/seed script — still worth a real definition rather than an
 * unaudited manual INSERT, because \"who has platform-operator access and
 * since when\" is exactly the question this system's audit log exists to
 * answer.
 */
export const operatorGranted = defineEvent(
  'platform.operator_granted',
  z.object({ userId: z.string(), grantedBy: z.string() }).strict(),
);

/**
 * A global feature-flag override was set, cleared, or changed (§3.8).
 *
 * Not in the spec's four-event catalog — added because guardrail 11 demands a
 * typed event for every state mutation and `flags.set` is one. Global, like
 * the table it records: the envelope carries SYSTEM_ORG, the same sentinel
 * people's `profile.updated` uses for a fact true of the person in every org.
 */
export const flagOverrideSet = defineEvent(
  'platform.flag_override_set',
  z
    .object({ flagName: z.string(), value: z.boolean().nullable(), operatorUserId: z.string() })
    .strict(),
);
