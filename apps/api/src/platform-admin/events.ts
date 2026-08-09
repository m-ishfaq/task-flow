import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Platform-operator domain events (Phase 12 §4). Guardrail 11 applies with
 * no exception — every one emitted inside the mutation's own transaction.
 *
 * Routing is decided (§7 decision 2, option (c), "both"): `orgSuspended`
 * and `orgReactivated` write into the TARGET ORG's own `audit.audit_log`
 * chain (via the existing `withAuditScope`/outbox mechanism every other
 * org-scoped mutation uses — an Owner sees "a platform operator suspended
 * this org" in their own audit history with no operator access required),
 * and every `platformAdmin.*` call additionally writes into the separate,
 * globally-chained `platform.operator_audit_log` (migration 0032) — see
 * `apps/api/src/platform-admin/router.ts` for how "every call is audited"
 * is made structural.
 */

export const orgSuspended = defineEvent(
  'platform.org_suspended',
  z.object({ orgId: z.string(), operatorUserId: z.string() }).strict(),
);

export const orgReactivated = defineEvent(
  'platform.org_reactivated',
  z.object({ orgId: z.string(), operatorUserId: z.string() }).strict(),
);

/**
 * A flag override was set or cleared (§3.8). Published through the SAME
 * system `EventBus` identity's own pre-tenant events use (`SYSTEM_ORG`,
 * `apps/api/src/identity/identity.service.ts`) rather than the tenant
 * outbox — `platform.flag_overrides` is global, has no target org, and
 * `people/router.ts` already reuses this exact bus for the identical
 * "no tenant, still a real domain event" reason. NOT routed to
 * `audit.audit_log` for the same reason SYSTEM_ORG events never are —
 * see that constant's own comment; `platform.operator_audit_log` (written
 * by the router wrapper, §4) is this action's actual accountability record.
 */
export const flagOverrideSet = defineEvent(
  'platform.flag_override_set',
  z.object({ flagName: z.string(), value: z.boolean(), setBy: z.string() }).strict(),
);

export const flagOverrideCleared = defineEvent(
  'platform.flag_override_cleared',
  z.object({ flagName: z.string(), clearedBy: z.string() }).strict(),
);

/**
 * A single account was frozen or reactivated (Phase 12 Wave 2 §3.1,
 * ai/phase-12-wave2.md). Published through the same system `EventBus`
 * `flagOverrideSet`/`.Cleared` already use above — a suspended user may
 * belong to several orgs or none, so there is no single target org's
 * `audit.audit_log` to also write into the way `orgSuspended` above does;
 * `platform.operator_audit_log` (written by the router wrapper, §4) is this
 * action's whole accountability record.
 */
export const userSuspended = defineEvent(
  'platform.user_suspended',
  z.object({ userId: z.string(), operatorUserId: z.string() }).strict(),
);

export const userReactivated = defineEvent(
  'platform.user_reactivated',
  z.object({ userId: z.string(), operatorUserId: z.string() }).strict(),
);

/**
 * NOT HERE: a `platform.operatorGranted` domain event.
 *
 * §4 of the spec calls for one, and the reasoning is real — "who has
 * platform-operator access and since when" is exactly the kind of question
 * this system's audit log exists to answer. It is deliberately not defined
 * via `defineEvent` here, because nothing in this wave can actually EMIT it
 * through the audited path: `platform.operators` has no org, has no
 * application-reachable write path at all (§3.1 — only `taskflow_migrator`,
 * via the bootstrap script), and `platform.outbox` requires a real
 * `org_id` (`NOT NULL REFERENCES identity.orgs`) — there is no "system"
 * outbox row for an org-less fact the way `people/profile.service.ts`'s
 * `SYSTEM_ORG` envelope exists for an in-process `EventBus`, which is a
 * live-broadcast mechanism, not a persisted, hash-chained one. Registering
 * an event nothing ever produces would either sit unaccounted-for in
 * `audit.projection.test.ts`'s "every registered event" check or need an
 * invented RESOURCE_OF mapping for a path that has never run — bookkeeping
 * for a feature that does not exist yet, not one that does (CLAUDE.md's
 * stance against half-finished implementations). The bootstrap script logs
 * what it did to its own output instead; wiring a real audited grant event
 * is real, valuable, out-of-scope follow-up work for whenever a self-service
 * operator-grant route (§7 decision 7) is built.
 */
