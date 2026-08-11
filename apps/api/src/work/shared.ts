import { errors, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { enforce, type Permission, type ResourceRef, type Subject } from '@taskflow/policy';

/**
 * Shared plumbing for the Work services (PLAN.md §3.1, §8.2).
 *
 * ## Why these services take a Subject and not just a UserId
 *
 * Tenancy's services take an `Actor` of `{ userId, requestId }`, because every
 * tenancy route is an ORG-level capability: `route({ permission })` decides it
 * before the handler runs, and there is no per-resource question left to ask.
 *
 * Work is the first module where that is not true. A member holds `card:update`
 * from their role, and a `viewer` tuple on one board takes it away again for the
 * cards on that board (§8.2 — restrictive relations). That decision needs the
 * ROW, so it cannot happen in the route builder, which runs before anything is
 * loaded. Layer 1 narrows; layer 2 decides.
 *
 * So a Work service receives the whole `Subject` — role and resolved tuples —
 * and calls `enforce()` once it has the row and its ancestors. Passing a bare
 * userId would make that second check impossible to write, which is the same as
 * making it easy to forget.
 */

export interface WorkActor {
  /** Role and resolved tuples, from `subjectOf(ctx.principal)`. */
  readonly subject: Subject;
  readonly requestId: RequestId;
  /**
   * How many automation hops led to this action (Phase 10, §4).
   *
   * Absent for every human-initiated call, which is what makes a user's action
   * the ROOT of a chain. Set only by the automation executor, to the triggering
   * event's depth plus one, and threaded into `envelopeOf` so the events this
   * action emits carry it forward.
   *
   * Without it a chain restarts its counter on the far side of the outbox and
   * the engine's depth cap protects nothing — so this field is small, optional,
   * and load-bearing.
   */
  readonly causationDepth?: number;
}

/** The org this actor is acting in. Read from the subject so there is one source. */
export function orgOf(actor: WorkActor): OrgId {
  return actor.subject.orgId;
}

export function userOf(actor: WorkActor): UserId {
  return actor.subject.userId;
}

/**
 * Envelope for an event write — the three fields every `createEvent` call needs.
 *
 * A helper rather than three arguments repeated forty times, because the failure
 * it prevents is specific: an event written with a different org than the
 * transaction it is in would project into the wrong tenant's audit log.
 */
export function envelopeOf(actor: WorkActor): {
  readonly orgId: OrgId;
  readonly actorId: UserId;
  readonly requestId: RequestId;
  readonly causationDepth?: number;
} {
  return {
    orgId: actor.subject.orgId,
    actorId: actor.subject.userId,
    requestId: actor.requestId,
    /* Omitted rather than defaulted to 0, so an event carries the field only
       when an automation set it — `exactOptionalPropertyTypes` makes "absent"
       and "present and undefined" different, and absence is how a
       human-initiated event is told apart from an automated one. */
    ...(actor.causationDepth === undefined ? {} : { causationDepth: actor.causationDepth }),
  };
}

/* -------------------------------------------------------------------------- *
 * Resource-scoped authorization
 * -------------------------------------------------------------------------- */

/**
 * The ancestor chain a Work resource sits in, nearest-first.
 *
 * `can()` walks this to find a grant on a container — a tuple naming a board
 * reaches that board's cards without the engine knowing what a card is (§8.2).
 * The order is load-bearing: NEAREST FIRST, because the engine takes the
 * closest matching relation and a project-level grant must not outrank a
 * board-level one.
 */
export function ancestorsOfCard(row: {
  readonly boardId: string;
  readonly projectId: string;
}): readonly ResourceRef[] {
  return [
    { type: 'board', id: row.boardId },
    { type: 'project', id: row.projectId },
  ];
}

/**
 * The ancestors of a BOARD — and of a list, which is deliberately the same thing.
 *
 * There is no `list` in RESOURCE_TYPES, and that is a modelling decision rather
 * than an omission. A list is not independently grantable: nobody shares one
 * column of a board, and inventing a resource type for it would add a level to
 * the tuple hierarchy that no product surface can create a grant on. So
 * authorization for a list-level action names the BOARD as its resource, which
 * is the thing a tuple can actually point at.
 */
export function ancestorsOfBoard(row: { readonly projectId: string }): readonly ResourceRef[] {
  return [{ type: 'project', id: row.projectId }];
}

/**
 * Layer 2 for a loaded row.
 *
 * `orgId` comes from the ROW, not from the request — `Target.orgId` is
 * documented as "the org owning the resource, from the row itself". Under RLS
 * the two cannot differ, which is precisely why passing the request's value
 * here would be untestable: it would look correct forever and stop being a
 * check.
 */
export function enforceOn(
  actor: WorkActor,
  permission: Permission,
  resource: ResourceRef,
  row: { readonly orgId: string },
  ancestors: readonly ResourceRef[],
): void {
  enforce(actor.subject, permission, {
    orgId: row.orgId as OrgId,
    resource,
    ancestors,
  });
}

/* -------------------------------------------------------------------------- *
 * Database error translation
 * -------------------------------------------------------------------------- */

/** SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

/** SQLSTATE for a foreign key violation. */
const FOREIGN_KEY_VIOLATION = '23503';

function hasSqlState(error: unknown, state: string): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current && current.code === state) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isUniqueViolation(error: unknown): boolean {
  return hasSqlState(error, UNIQUE_VIOLATION);
}

/**
 * True when the database refused a row because its parent did not exist.
 *
 * On this schema that is almost always the COMPOSITE key firing: a card naming
 * a list that belongs to a different board, or a board naming a project from
 * another org. Both are 404 rather than 400 — the parent the caller named is,
 * as far as they are permitted to know, not there (§8.7).
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasSqlState(error, FOREIGN_KEY_VIOLATION);
}

/**
 * Runs a write, translating the two constraint failures that are client errors.
 *
 * Without this they surface as INTERNAL_ERROR, which tells the caller to retry
 * something that will never succeed and lights up every 5xx alert for a user
 * typing a duplicate project key.
 */
export async function translatingConstraints<T>(
  operation: () => Promise<T>,
  onUnique: () => Error,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isUniqueViolation(error)) throw onUnique();
    if (isForeignKeyViolation(error)) throw errors.notFound();
    throw error;
  }
}
