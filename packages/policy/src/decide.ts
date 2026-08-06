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
  /**
   * When true, an org ROLE alone never reaches this resource. Only a relation
   * on it or on one of its ancestors does.
   *
   * ## Why the engine needed a third answer
   *
   * Until Phase 5 every resource in this system was open to the org: a member
   * holding `card:read` could read every card, and a tuple's job was only to
   * ADD access (an `editor` on one board) or CAP it (a `viewer` who may not
   * write). Absence of a tuple therefore meant "no opinion", and the engine
   * correctly fell through to the role.
   *
   * A private channel and a DM are the first resources where absence of a tuple
   * must mean DENY. Without this flag, `member` holding `channel:read` from the
   * role matrix reads every private channel and every direct message in the
   * organization — and does so silently, because nothing in the trace looks
   * wrong: the role genuinely grants the permission, and there is genuinely no
   * tuple to consider.
   *
   * ## Why it is a property of the TARGET and not of the resource type
   *
   * `channel` is not uniformly closed. A public channel is open to the org by
   * design and a private one is not, and they are rows in the same table with
   * the same resource type. Only the caller — which has loaded the row — knows
   * which it is holding, exactly as only the caller knows the ancestor chain.
   * Keying this off `resource.type` would force the engine to learn what a
   * channel is, and would make "public" unexpressible.
   *
   * ## Owners and admins do NOT bypass this
   *
   * `bypassesRestrictions` lets an administrator through a restrictive CAP, on
   * the reasoning that they could delete the tuple anyway so enforcing it would
   * be confusing rather than safer. That reasoning does not extend here, and the
   * difference is visibility. An admin adding themselves to a private channel is
   * an act its members can see and the audit log records; an admin reading a
   * closed resource they were never given is indistinguishable from a member
   * doing it, and for a DM there is no membership they could grant themselves at
   * all. The audited path to someone else's private conversation is compliance
   * export, not an ambient capability every administrator carries.
   */
  readonly closed?: boolean;
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
    /* A closed resource is not reachable by role. Checked BEFORE the role
       fallback rather than after, so the trace reads as the denial it is
       instead of showing a role grant that was then discarded. */
    if (target.closed) {
      trace.push({
        layer: 2,
        outcome: 'deny',
        rule: 'resource is closed and the subject holds no relation on it',
        detail: 'membership of a private channel or DM is a tuple, not a role',
      });
      return finish(false, 'You are not a member of this resource.');
    }

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
 * Whether `subject` could ever be granted `permission` — by role, or by
 * holding ANY tuple whose relation covers it, on any object at all.
 *
 * ## What this answers, and what it deliberately does not
 *
 * `apps/api/src/trpc/builder.ts`'s `route()` runs a permission check BEFORE
 * the handler loads a specific resource — "may a member of this role do this
 * kind of thing at all", the route's own comment calls it. That question is
 * `roleGrants(role, permission)` for every role except one: `guest` grants
 * NOTHING from the role alone by design (`roles.ts`) — a guest's entire
 * access is a tuple on the one channel they were invited to. `can()` called
 * with no target answers strictly from the role (see the no-target branch
 * above), so that pre-check refused every guest on every chat route before
 * the handler ever loaded the channel that would have granted them the
 * permission through their tuple. Layer 2 — `enforce()`, called once a
 * specific resource is loaded — never got a chance to say otherwise.
 *
 * This function is the fix, and it is intentionally coarse: it does not know
 * or care WHICH object a tuple points at, only that relations grant actions
 * by suffix regardless of resource type (`relationGrants`) — the same
 * looseness `nearestApplicable`'s per-resource matching already relies on to
 * stay resource-agnostic. A guest holding a tuple on channel A passes this
 * check when asking about channel B too; that is safe because this is ONLY
 * the coarse pre-check ("could this principal EVER hold this permission"),
 * and the specific answer for channel B is still `enforce()`'s alone to give
 * once it loads that row. Widening layer 1 costs nothing here — the
 * boundary this system actually depends on is layer 2, always has been.
 */
export function couldGrant(subject: Subject, permission: Permission): boolean {
  if (!isRole(subject.role)) return false;
  if (roleGrants(subject.role, permission)) return true;
  return subject.tuples.some((tuple) => relationGrants(tuple.relation, permission));
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
