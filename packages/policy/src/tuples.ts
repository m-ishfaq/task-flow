import type { UserId } from '@taskflow/contracts';
import { PERMISSIONS, type Permission, type ResourceType } from './permissions.js';

/**
 * Relationship tuples — the Zanzibar-lite half of the model (PLAN.md §8.2).
 *
 * Flat roles cannot express "this guest is in #incidents", "this contractor may
 * edit one page subtree", or "this team owns that project". Those are relations
 * between a subject and an object, and squeezing them into roles produces either
 * a role explosion or a pile of inline special cases — which is the thing
 * guardrail 7 exists to prevent.
 *
 * Tuples reaching this module are ALREADY RESOLVED to a single user. Team
 * membership and group expansion happen in the loader that reads
 * `authz.relationship_tuples`, so the engine stays pure: no I/O, no async, and
 * identical behaviour in the API, a worker, the socket gateway, and the UI.
 */

export const RELATIONS = ['owner', 'editor', 'commenter', 'viewer', 'member'] as const;
export type Relation = (typeof RELATIONS)[number];

/** Points at one object. `id` is opaque here — the engine never dereferences it. */
export interface ResourceRef {
  readonly type: ResourceType;
  readonly id: string;
}

export interface RelationshipTuple {
  readonly subject: UserId;
  readonly relation: Relation;
  readonly object: ResourceRef;
}

interface RelationGrant {
  /**
   * Actions this relation permits on the object and everything beneath it.
   * Matched against the suffix of a permission, so a `viewer` on a board covers
   * `card:read` without the relation needing to know cards exist.
   */
  readonly actions: readonly string[];
  /** Permissions granted outright, where the action suffix is too blunt. */
  readonly extra: readonly Permission[];
  /**
   * When true, this relation CAPS the subject on this resource rather than
   * adding to their role.
   *
   * This is the case the decision trace in §8.2 illustrates: a member whose role
   * grants `card:update` is still denied on a board where they are only a
   * viewer. Without capping, sharing a board read-only with a colleague would
   * silently give them write access, which is the opposite of what the person
   * doing the sharing believes they did.
   */
  readonly restrictive: boolean;
}

const RELATION_GRANTS: Readonly<Record<Relation, RelationGrant>> = {
  viewer: {
    actions: ['read', 'download'],
    extra: [],
    restrictive: true,
  },
  commenter: {
    actions: ['read', 'download'],
    extra: ['comment:create'],
    restrictive: true,
  },
  /* Channel and team membership. Lets a guest participate in the one place they
     were invited to, and nowhere else. */
  member: {
    actions: ['read', 'download'],
    extra: ['message:create', 'message:update', 'comment:create', 'attachment:upload'],
    restrictive: true,
  },
  editor: {
    actions: ['read', 'download', 'create', 'update', 'move'],
    extra: ['comment:create', 'attachment:upload'],
    restrictive: false,
  },
  /* Resource ownership — the creator of a board, or a team that owns a project.
     Deliberately does NOT include org-level capability: owning a board is not
     owning the organization. */
  owner: {
    actions: ['read', 'download', 'create', 'update', 'move', 'delete', 'manage'],
    extra: ['comment:create', 'attachment:upload'],
    restrictive: false,
  },
};

function actionOf(permission: Permission): string {
  return permission.slice(permission.indexOf(':') + 1);
}

function grantSet(relation: Relation): ReadonlySet<Permission> {
  const grant = RELATION_GRANTS[relation];
  return new Set(
    PERMISSIONS.filter(
      (permission) =>
        grant.actions.includes(actionOf(permission)) || grant.extra.includes(permission),
    ),
  );
}

/* Written out rather than built with Object.fromEntries, whose return type is a
   plain index signature — the cast back to Record<Relation, ...> would let a
   missing relation compile. Here, adding a relation is a type error until it is
   given a grant set. */
const GRANTED_BY_RELATION: Readonly<Record<Relation, ReadonlySet<Permission>>> = {
  owner: grantSet('owner'),
  editor: grantSet('editor'),
  commenter: grantSet('commenter'),
  viewer: grantSet('viewer'),
  member: grantSet('member'),
};

/** True when `relation` grants `permission` on the object it points at. */
export function relationGrants(relation: Relation, permission: Permission): boolean {
  return GRANTED_BY_RELATION[relation].has(permission);
}

/** True when `relation` caps the subject rather than adding to their role. */
export function isRestrictive(relation: Relation): boolean {
  return RELATION_GRANTS[relation].restrictive;
}

/** Every permission a relation confers. Exported for the matrix test and the debug UI. */
export function permissionsForRelation(relation: Relation): readonly Permission[] {
  return [...GRANTED_BY_RELATION[relation]];
}

/** True when a value from outside the system names a real relation. */
export function isRelation(value: string): value is Relation {
  return (RELATIONS as readonly string[]).includes(value);
}

/** Formats a tuple the way the decision trace and the audit log render it. */
export function formatTuple(tuple: RelationshipTuple): string {
  return `(${tuple.subject}, ${tuple.relation}, ${tuple.object.type}:${tuple.object.id})`;
}
