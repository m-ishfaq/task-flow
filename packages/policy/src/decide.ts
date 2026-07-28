import type { OrgId, UserId } from '@taskflow/contracts';
import { isPermission, type Permission } from './permissions.js';
import { bypassesRestrictions, isRole, roleGrants, type Role } from './roles.js';
import {
  formatTuple,
  isRestrictive,
  relationGrants,
  type RelationshipTuple,
  type ResourceRef,
} from './tuples.js';

/**
 * The policy engine (PLAN.md §8.2).
 *
 * `can()` is pure: no I/O, no async, no clock. Everything it needs — the
 * subject's role and their already-resolved tuples — is passed in. That is what
 * lets the API, workers, the socket gateway, Hocuspocus, and the UI all ask the
 * SAME engine instead of each re-deriving the rules, which is how UI affordances
 * and server enforcement drift apart.
 *
 * It returns a decision with a trace, never a boolean. One mechanism, three
 * uses (§8.2): the permission debug page, the failure output of the
 * authorization matrix test, and a structured field on every audit denial.
 * "Why can't this user see this?" is otherwise the most miserable question to
 * answer in a relationship-based model.
 */

export type PolicyLayer = 1 | 2 | 3 | 4;

export interface TraceStep {
  readonly layer: PolicyLayer;
  readonly outcome: 'grant' | 'deny' | 'skip' | 'note';
  readonly rule: string;
  readonly detail?: string;
}

export interface Subject {
  readonly orgId: OrgId;
  readonly userId: UserId;
  readonly role: Role;
  /** Resolved tuples for THIS user. See tuples.ts on why they arrive pre-expanded. */
  readonly tuples: readonly RelationshipTuple[];
}

export interface Target {
  /** The org owning the resource, from the row itself — not from the request. */
  readonly orgId: OrgId;
  readonly resource: ResourceRef;
  /**
   * Ancestors nearest-first: a card's `[board, project]`.
   *
   * This is how a grant on a container reaches its contents without the engine
   * knowing the shape of the domain. The caller supplies the chain because only
   * the caller has already loaded the row.
   */
  readonly ancestors?: readonly ResourceRef[];
}

export interface Decision {
  readonly allowed: boolean;
  readonly permission: Permission;
  readonly userId: UserId;
  readonly role: Role;
  readonly resource?: ResourceRef;
  readonly reason: string;
  readonly trace: readonly TraceStep[];
}

/**
 * Decides whether `subject` may perform `permission`, optionally on `target`.
 *
 * Omit `target` for org-level capabilities (`org:delete`, `audit:read`) where
 * there is no per-resource grant to consider.
 */
export function can(subject: Subject, permission: Permission, target?: Target): Decision {
  const trace: TraceStep[] = [];

  const finish = (allowed: boolean, reason: string): Decision => ({
    allowed,
    permission,
    userId: subject.userId,
    role: subject.role,
    ...(target ? { resource: target.resource } : {}),
    reason,
    trace,
  });

  /* ---------------------------------------------------------------------- *
   * Layer 1 — is this even a real permission?
   *
   * A route declaring a permission that does not exist must DENY, not pass
   * through. Guardrail 4 makes that unreachable from TypeScript, but the engine
   * is also called with values crossing a trust boundary (an API token's scope,
   * a stored automation), and those are strings.
   * ---------------------------------------------------------------------- */
  if (!isPermission(permission)) {
    trace.push({
      layer: 1,
      outcome: 'deny',
      rule: 'permission is not in the catalog',
      detail: String(permission),
    });
    return finish(false, 'Unknown permission.');
  }
  trace.push({ layer: 1, outcome: 'note', rule: `route declares ${permission}` });

  /* ---------------------------------------------------------------------- *
   * Layer 2 preamble — is this a role we know?
   *
   * Same reasoning as the permission check above: the value comes from a row or
   * a token, so a role this build has never heard of is reachable during a
   * rolling deploy. Denying with a named reason beats throwing, which would turn
   * one stale membership row into a 500 on every request that user makes.
   * ---------------------------------------------------------------------- */
  if (!isRole(subject.role)) {
    trace.push({
      layer: 2,
      outcome: 'deny',
      rule: 'subject role is not in the catalog',
      detail: String(subject.role),
    });
    return finish(false, 'Unrecognized role.');
  }

  /* ---------------------------------------------------------------------- *
   * Layer 2a — tenancy.
   *
   * RLS (layer 4) already makes a cross-tenant read return zero rows, so
   * reaching this check means something upstream loaded a row it should not
   * have. Denying here turns that into a clean, audited refusal instead of
   * relying on the database being the only thing standing between two tenants.
   * ---------------------------------------------------------------------- */
  if (target && target.orgId !== subject.orgId) {
    trace.push({
      layer: 2,
      outcome: 'deny',
      rule: 'resource belongs to another organization',
      detail: `subject org ${subject.orgId} != resource org ${target.orgId}`,
    });
    return finish(false, 'Resource belongs to another organization.');
  }

  /* ---------------------------------------------------------------------- *
   * Layer 2b — role.
   * ---------------------------------------------------------------------- */
  const byRole = roleGrants(subject.role, permission);
  trace.push({
    layer: 2,
    outcome: byRole ? 'grant' : 'deny',
    rule: `role=${subject.role} ${byRole ? 'grants' : 'does not grant'} ${permission}`,
  });

  if (!target) {
    return byRole
      ? finish(true, `Role ${subject.role} grants ${permission}.`)
      : finish(false, `Role ${subject.role} does not grant ${permission}.`);
  }

  /* ---------------------------------------------------------------------- *
   * Layer 2c — relationship tuples.
   * ---------------------------------------------------------------------- */
  const nearest = nearestApplicable(subject.tuples, target);

  if (nearest.length === 0) {
    trace.push({ layer: 2, outcome: 'skip', rule: 'no relationship tuple on this resource' });
    return byRole
      ? finish(true, `Role ${subject.role} grants ${permission}.`)
      : finish(false, `Role ${subject.role} does not grant ${permission}.`);
  }

  const byTuple = nearest.filter((tuple) => relationGrants(tuple.relation, permission));
  for (const tuple of byTuple) {
    trace.push({
      layer: 2,
      outcome: 'grant',
      rule: `tuple ${formatTuple(tuple)} grants ${permission}`,
    });
  }

  /* A capping relation applies only when EVERY tuple at the nearest distance is
     restrictive. Being both viewer and editor on the same board means editor —
     the narrower grant was not intended to revoke the wider one. */
  const capped = nearest.every((tuple) => isRestrictive(tuple.relation));

  if (capped && byTuple.length === 0) {
    if (bypassesRestrictions(subject.role)) {
      trace.push({
        layer: 2,
        outcome: 'note',
        rule: `role=${subject.role} bypasses restrictive grants`,
        detail: 'an org administrator can remove the tuple anyway; recorded for audit',
      });
      return byRole
        ? finish(true, `Role ${subject.role} overrides a read-only grant.`)
        : finish(false, `Role ${subject.role} does not grant ${permission}.`);
    }

    const nearestTuple = nearest[0];
    trace.push({
      layer: 2,
      outcome: 'deny',
      rule: nearestTuple
        ? `tuple ${formatTuple(nearestTuple)} is read-only and overrides the role grant`
        : 'a read-only grant overrides the role grant',
    });
    return finish(false, `A read-only grant on this resource overrides ${permission}.`);
  }

  if (byTuple.length > 0) {
    return finish(true, 'Granted by a relationship on this resource.');
  }

  return byRole
    ? finish(true, `Role ${subject.role} grants ${permission}.`)
    : finish(false, `Role ${subject.role} does not grant ${permission}.`);
}

/** Convenience for call sites that genuinely only need the answer. */
export function allowed(subject: Subject, permission: Permission, target?: Target): boolean {
  return can(subject, permission, target).allowed;
}

/**
 * The tuples closest to the resource.
 *
 * Distance 0 is the resource itself, 1 its parent, and so on. Only the nearest
 * set is considered: a `viewer` tuple on a specific page must beat an `editor`
 * tuple on the whole space, or narrowing an inherited grant would be impossible
 * to express.
 */
function nearestApplicable(
  tuples: readonly RelationshipTuple[],
  target: Target,
): readonly RelationshipTuple[] {
  const chain = [target.resource, ...(target.ancestors ?? [])];

  for (const ref of chain) {
    const matches = tuples.filter(
      (tuple) => tuple.object.type === ref.type && tuple.object.id === ref.id,
    );
    if (matches.length > 0) return matches;
  }
  return [];
}

/**
 * Renders a decision in the form §8.2 specifies.
 *
 * Kept next to the engine rather than in the admin UI so that the audit log, the
 * matrix test's failure output, and the debug page cannot disagree about what a
 * decision meant.
 */
export function formatTrace(decision: Decision): string {
  const header = [
    decision.allowed ? 'allow' : 'deny',
    decision.permission,
    decision.resource ? `${decision.resource.type}:${decision.resource.id}` : '(no resource)',
    decision.userId,
  ].join('  ');

  const marks: Readonly<Record<TraceStep['outcome'], string>> = {
    grant: '✓',
    deny: '✗',
    skip: '–',
    note: '·',
  };

  const lines = decision.trace.map((step) => {
    const detail = step.detail === undefined ? '' : `  (${step.detail})`;
    return `  ${marks[step.outcome]} layer ${String(step.layer)}  ${step.rule}${detail}`;
  });

  return [header, ...lines].join('\n');
}
