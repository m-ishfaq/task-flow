import { and, eq, schema, withOrgScope } from '@taskflow/db';
import { errors, type OrgId, type UserId } from '@taskflow/contracts';
import {
  can,
  formatTrace,
  isPermission,
  isRole,
  type Decision,
  type ResourceType,
} from '@taskflow/policy';
import { loadTuples } from './resolve.js';

/**
 * The permission debug surface (PLAN.md §8.2, §10.7).
 *
 * A relationship-based permission model is opaque at exactly the moment you
 * need it — a user reporting they cannot see something. This answers that
 * question with the same decision trace the engine produces internally, so
 * three things stay in agreement by construction: the admin debugging view, the
 * authorization matrix test's failure output, and the structured `decision`
 * field on every audited denial.
 *
 * ## Two things this deliberately does not do
 *
 * It does not evaluate as the CALLER. The subject is whoever is being
 * investigated, which is the whole point — an admin asking "why can't Ali see
 * this board" needs Ali's answer, not their own. That makes the route an
 * information disclosure about another user's access, which is why it requires
 * `audit:read` (Owner and Admin only, per §8.2) rather than something weaker.
 *
 * It does not consult the resource. `can()` is pure and takes the ancestor
 * chain from its caller, and nothing in Phase 2 owns boards or pages yet — so
 * an explanation here covers role and direct tuples, and inherited grants
 * become visible when Phase 3 supplies the chain. Saying so is better than
 * quietly returning an answer that omits a layer.
 */

export interface ExplainInput {
  readonly userId: UserId;
  readonly permission: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
}

export interface Explanation {
  readonly allowed: boolean;
  readonly reason: string;
  readonly role: string;
  readonly trace: readonly {
    readonly layer: number;
    readonly outcome: string;
    readonly rule: string;
    readonly detail?: string;
  }[];
  /** The rendering from §8.2, for a log line or a support ticket. */
  readonly formatted: string;
}

export async function explain(orgId: OrgId, input: ExplainInput): Promise<Explanation> {
  if (!isPermission(input.permission)) {
    throw errors.validation({ permission: 'Unknown permission.' });
  }

  const rows = await withOrgScope(orgId, async (tx) =>
    tx
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.userId, input.userId), eq(schema.memberships.status, 'active')),
      )
      .limit(1),
  );

  // The subject is not in this org — or the caller named a user from another
  // tenant. Same answer either way (§8.7).
  const membership = rows[0];
  if (membership === undefined) throw errors.notFound();

  const { role } = membership;
  if (!isRole(role)) throw errors.notFound();

  const tuples = await loadTuples(orgId, input.userId);

  const target =
    input.resourceType === null || input.resourceId === null
      ? undefined
      : {
          orgId,
          resource: { type: input.resourceType as ResourceType, id: input.resourceId },
        };

  const decision: Decision = can(
    { orgId, userId: input.userId, role, tuples },
    input.permission,
    target,
  );

  return {
    allowed: decision.allowed,
    reason: decision.reason,
    role: decision.role,
    trace: decision.trace.map((step) => ({
      layer: step.layer,
      outcome: step.outcome,
      rule: step.rule,
      ...(step.detail === undefined ? {} : { detail: step.detail }),
    })),
    formatted: formatTrace(decision),
  };
}
