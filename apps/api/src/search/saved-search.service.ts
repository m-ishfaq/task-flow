import { asc, eq, or, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { can, type Subject } from '@taskflow/policy';
import { parse, validate } from '@taskflow/filter';
import { savedSearchCreated, savedSearchDeleted, savedSearchUpdated } from './events.js';
import { translatingConstraints } from '../work/shared.js';

/**
 * Saved searches (ai/phase-8-search.md §3.2, migration 0046).
 *
 * `work/view.service.ts` is the pattern this follows, and the three things
 * worth understanding before changing it are the same three, one level up —
 * a saved search is org-scoped where a view is board-scoped.
 *
 * ## 1. Two audiences, two permissions, one route
 *
 * A PRIVATE saved search is a personal bookmark: nobody else sees it, so
 * `search:query` — the permission to run a search at all — is enough to keep
 * one. A SHARED one is furniture for every member, so it is `search:manage`
 * (Admin and Owner).
 *
 * The route declares the floor and `enforceSharing` below adds the second
 * question when, and only when, `isShared` is true. That second call passes NO
 * TARGET, which means it is answered from ROLE ALONE — deliberately, and it is
 * also what makes it safe against a `couldGrant` false positive at the floor:
 * `search:query` is not in `ORG_LEVEL_PERMISSIONS`, so an unrelated
 * relationship tuple can satisfy the route's pre-check, and this role-only
 * call is the layer that would deny it anyway. Exactly the shape
 * `channel:create` uses (packages/policy/src/permissions.ts).
 *
 * ## 2. The query is stored as TEXT, unresolved, and re-parsed on READ
 *
 * `@me` and `-7d` stay literally what the author typed, so a SHARED "assigned
 * to me" search means "assigned to whoever is running it" rather than "to
 * whoever saved it" (§1.5 — the trap 0014's header documents for views).
 *
 * The stored string is re-parsed and re-validated every time it is listed,
 * with the same `parse` + `validate('search', …)` the route applies to a
 * freshly typed query. A column is not a parser: a string written by an older
 * build, or edited by hand in psql, would otherwise reach `compile()` — which
 * refuses unknown fields, so it could not become SQL, but it would surface as
 * a 500 from the search page rather than as one broken entry. `broken: true`
 * is what a caller gets instead, with every other saved search still listed.
 *
 * ## 3. Editing a private search is author-only, with no permission override
 *
 * An Owner cannot rewrite someone's personal bookmark, for the reason
 * CLAUDE.md gives about comments: a private thing an administrator can
 * silently edit is not private. A SHARED one is `search:manage`, because it
 * belongs to the organization rather than to its author.
 */

export interface SavedSearchActor {
  readonly subject: Subject;
  readonly requestId: RequestId;
}

export interface SavedSearchSummary {
  readonly searchId: string;
  readonly name: string;
  readonly query: string;
  readonly isShared: boolean;
  readonly createdBy: string;
  /** True when the stored TQL no longer parses or validates — see §2 above. */
  readonly broken: boolean;
}

interface SavedSearchInput {
  readonly name: string;
  readonly query: string;
  readonly isShared: boolean;
}

const orgOf = (actor: SavedSearchActor): OrgId => actor.subject.orgId;
const userOf = (actor: SavedSearchActor): UserId => actor.subject.userId;

const envelopeOf = (actor: SavedSearchActor) => ({
  orgId: actor.subject.orgId,
  actorId: actor.subject.userId,
  requestId: actor.requestId,
});

/**
 * Every saved search the caller may see: all shared ones, plus their own.
 *
 * The `created_by` half of the OR is what makes private mean private. RLS
 * answers the TENANT question and has nothing to say here — two members of one
 * org are on the same side of that boundary (view.service.ts, verbatim).
 */
export async function listSavedSearches(
  actor: SavedSearchActor,
): Promise<readonly SavedSearchSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        searchId: schema.searches.id,
        name: schema.searches.name,
        query: schema.searches.query,
        isShared: schema.searches.isShared,
        createdBy: schema.searches.createdBy,
      })
      .from(schema.searches)
      .where(or(eq(schema.searches.isShared, true), eq(schema.searches.createdBy, userOf(actor))))
      .orderBy(asc(schema.searches.name), asc(schema.searches.id));

    return rows.map((row) => ({ ...row, broken: !queryUsable(row.query) }));
  });
}

export async function createSavedSearch(
  actor: SavedSearchActor,
  input: SavedSearchInput,
): Promise<{ readonly searchId: string }> {
  const searchId = newId();
  const orgId = orgOf(actor);

  enforceSharing(actor, input.isShared);
  assertQueryUsable(input.query);

  await translatingDuplicateName(async () =>
    withOrgScope(orgId, async (tx) => {
      await tx.insert(schema.searches).values({
        id: searchId,
        orgId,
        name: input.name,
        query: input.query,
        isShared: input.isShared,
        createdBy: userOf(actor),
      });

      await outboxWriter.append(tx, [
        createEvent(
          savedSearchCreated,
          { searchId, name: input.name, shared: input.isShared },
          envelopeOf(actor),
        ),
      ]);
    }),
  );

  return { searchId };
}

export async function updateSavedSearch(
  actor: SavedSearchActor,
  input: SavedSearchInput & { readonly searchId: string },
): Promise<{ readonly name: string }> {
  const orgId = orgOf(actor);

  assertQueryUsable(input.query);

  await translatingDuplicateName(async () =>
    withOrgScope(orgId, async (tx) => {
      const existing = await loadSavedSearch(tx, input.searchId);
      enforceEditable(actor, existing);

      /* Sharing a previously private search is a `search:manage` act — it puts
         the entry in front of everyone — so the NEW value is what is checked,
         not the stored one. Un-sharing is the same act in reverse: it removes
         an entry other people are using. (view.service.ts, same argument.) */
      if (existing.isShared !== input.isShared) enforceSharing(actor, true);

      await tx
        .update(schema.searches)
        .set({
          name: input.name,
          query: input.query,
          isShared: input.isShared,
          updatedAt: new Date(),
        })
        .where(eq(schema.searches.id, input.searchId));

      await outboxWriter.append(tx, [
        createEvent(
          savedSearchUpdated,
          {
            searchId: input.searchId,
            name: input.name,
            wasShared: existing.isShared,
            shared: input.isShared,
          },
          envelopeOf(actor),
        ),
      ]);
    }),
  );

  return { name: input.name };
}

export async function deleteSavedSearch(
  actor: SavedSearchActor,
  input: { readonly searchId: string },
): Promise<{ readonly deleted: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const existing = await loadSavedSearch(tx, input.searchId);
    enforceEditable(actor, existing);

    /* A real delete, not an archive: a saved search holds no work — it is a
       saved question about work that exists elsewhere — so there is nothing a
       restore would recover that re-saving would not. Same call view.service.ts
       makes, and for labels and statuses before it. */
    await tx.delete(schema.searches).where(eq(schema.searches.id, input.searchId));

    await outboxWriter.append(tx, [
      createEvent(
        savedSearchDeleted,
        { searchId: input.searchId, name: existing.name, shared: existing.isShared },
        envelopeOf(actor),
      ),
    ]);

    return { deleted: true as const };
  });
}

/* -------------------------------------------------------------------------- */

interface SavedSearchRow {
  readonly name: string;
  readonly isShared: boolean;
  readonly createdBy: string;
}

type SearchTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

async function loadSavedSearch(tx: SearchTx, searchId: string): Promise<SavedSearchRow> {
  const rows = await tx
    .select({
      name: schema.searches.name,
      isShared: schema.searches.isShared,
      createdBy: schema.searches.createdBy,
    })
    .from(schema.searches)
    .where(eq(schema.searches.id, searchId))
    .limit(1);

  const row = rows[0];
  if (!row) throw errors.notFound();
  return row;
}

/**
 * The `search:manage` half — see §1 in the file header.
 *
 * Written as `can()` plus an explicit FORBIDDEN rather than `enforce()`,
 * because `enforce`'s denial helper derives its message from
 * `<resource>:read` — and there is no `search:read` in the catalog, so it
 * falls back to NOT_FOUND. A 404 in answer to "share this search" describes
 * nothing that happened; the caller can see the search, they simply may not
 * share it, and FORBIDDEN is the honest word for that.
 */
function enforceSharing(actor: SavedSearchActor, isShared: boolean): void {
  if (!isShared) return;
  if (can(actor.subject, 'search:manage').allowed) return;

  throw errors.forbidden('Only an administrator can share a saved search with the organization.');
}

/**
 * Who may change an existing saved search.
 *
 * Shared: `search:manage`, because it belongs to the org. Private:
 * AUTHOR-ONLY, with no permission override at all — see §3 in the header.
 */
function enforceEditable(actor: SavedSearchActor, existing: SavedSearchRow): void {
  if (existing.isShared) {
    enforceSharing(actor, true);
    return;
  }

  /* NOT_FOUND rather than FORBIDDEN, and the asymmetry with `enforceSharing`
     above is deliberate: another person's PRIVATE saved search is one the
     caller should not learn the existence of (§8.7), where a shared one they
     can already see is one they may only not change. */
  if (existing.createdBy !== userOf(actor)) throw errors.notFound();
}

/** True when the stored TQL still parses AND validates against the search fields. */
function queryUsable(query: string): boolean {
  const parsed = parse(query);
  if (!parsed.ok) return false;
  /* A query that parses to NO filter is a saved search that can only ever
     return nothing — the route answers an empty tree with zero results. The
     CHECK constraint refuses an empty string; this catches the subtler case of
     a string that is all whitespace-equivalent to the parser. */
  if (parsed.filter === null) return false;
  return validate('search', parsed.filter).ok;
}

/**
 * Refuses a query that would be stored only to read back broken.
 *
 * Failing at the WRITE is the honest moment: the author is still looking at
 * the query they typed. Without this, a caller could save an invalid search,
 * get a 200, and find it permanently marked broken (view.service.ts's
 * `assertFilterUsable`, same reasoning).
 */
function assertQueryUsable(query: string): void {
  const parsed = parse(query);
  if (!parsed.ok) {
    throw errors.validation(
      { query: parsed.errors.map((error) => error.message) },
      'That search query could not be parsed.',
    );
  }
  if (parsed.filter === null) {
    throw errors.validation({ query: ['A saved search needs at least one term.'] });
  }

  const result = validate('search', parsed.filter);
  if (result.ok) return;

  throw errors.validation(
    { query: result.errors.map((error) => error.message) },
    'That search query is not valid.',
  );
}

/**
 * Turns the partial unique indexes' violation into a CONFLICT.
 *
 * Two indexes can fire here — one per sharing tier (migration 0046) — and both
 * mean the same thing to a caller, so both map to one message. Catching the
 * constraint rather than pre-checking with a SELECT is what makes it correct
 * under concurrency: two people saving "Mine" at the same moment both pass a
 * pre-check and one still has to lose.
 *
 * `translatingConstraints` is Work's, reused rather than reimplemented — the
 * search router already loads cards through `work/card.service.js`, so the
 * dependency direction is established, and a second copy of "which SQLSTATE
 * means what" is a second copy that can disagree.
 */
async function translatingDuplicateName(run: () => Promise<void>): Promise<void> {
  await translatingConstraints(run, () =>
    errors.conflict('A saved search with that name already exists.'),
  );
}
