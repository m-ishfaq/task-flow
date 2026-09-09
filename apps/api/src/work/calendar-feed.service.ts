import { and, eq, isNotNull, schema, withOrgScope } from '@taskflow/db';
import { unsafeAsId, type UserId } from '@taskflow/contracts';
import { can, isRole } from '@taskflow/policy';
import { listMyOrgs } from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import { ancestorsOfCard } from './shared.js';

/**
 * Assembling one person's calendar feed across every org they belong to
 * (migration 0110's `platform.card_calendar_subscriptions`) — the DATA half
 * of the calendar-sync feature; `identity/calendar-feed.service.ts` owns the
 * token, `identity`'s own Fastify route (§4's ⚠ human-review surface) owns
 * turning this into ICS text.
 *
 * ## Re-checks `card:read` per row, even though the caller already opted in
 *
 * Access can have been revoked since the opt-in was created — a board-level
 * tuple edited, a project un-shared, a Guest's grant expired — and RLS alone
 * only proves TENANCY, never per-board grant state. The identical discipline
 * `work.cards.mine`'s `listMyCards` already applies for the same reason: an
 * opt-in row from last month must not outlive the access that made it
 * meaningful.
 *
 * ## No `withGlobalScope` here, on purpose
 *
 * `listMyOrgs(userId)` already resolves "which orgs" through the ordinary
 * `withUserScope` self-read policies — the same mechanism the org switcher
 * itself uses — so by the time this function opens `withOrgScope` per org,
 * it is squarely inside the ordinary tenant path. `apps/api/src/work` is not
 * on `packages/config/eslint/security.js`'s short `withGlobalScope`-exempt
 * list (identity, people, platform-admin) and does not need to be.
 */

export interface FeedCard {
  readonly orgId: string;
  readonly cardId: string;
  /** `WEB-142` — the reference every other surface in this app already uses. */
  readonly reference: string;
  readonly title: string;
  /** Always present — `buildCalendarFeed` already dropped anything with none. */
  readonly dueDate: string;
  readonly url: string;
}

export async function buildCalendarFeed(
  userId: UserId,
  webOrigin: string,
): Promise<readonly FeedCard[]> {
  const orgs = await listMyOrgs(userId);
  const cards: FeedCard[] = [];

  for (const org of orgs) {
    /* `listMyOrgs` already reports status for BOTH the membership and the
       org itself (Phase 3's own "the two places its types lied" fix) —
       skip either kind of non-active row the same way every other reader
       of this function's output already does, rather than surfacing a
       suspended org's cards on a calendar nobody can currently open. */
    if (org.membershipStatus !== 'active' || org.orgStatus !== 'active') continue;
    if (!isRole(org.role)) continue;

    const orgId = unsafeAsId<'OrgId'>(org.orgId);
    const tuples = await loadTuples(orgId, userId);
    const subject = { orgId, userId, role: org.role, tuples };

    const rows = await withOrgScope(orgId, async (tx) =>
      tx
        .select({
          cardId: schema.cards.id,
          orgId: schema.cards.orgId,
          boardId: schema.cards.boardId,
          projectId: schema.cards.projectId,
          projectKey: schema.projects.key,
          number: schema.cards.number,
          title: schema.cards.title,
          dueDate: schema.cards.dueDate,
        })
        .from(schema.cardCalendarSubscriptions)
        .innerJoin(schema.cards, eq(schema.cards.id, schema.cardCalendarSubscriptions.cardId))
        .innerJoin(schema.projects, eq(schema.projects.id, schema.cards.projectId))
        .where(
          and(eq(schema.cardCalendarSubscriptions.userId, userId), isNotNull(schema.cards.dueDate)),
        ),
    );

    for (const row of rows) {
      const allowed = can(subject, 'card:read', {
        orgId,
        resource: { type: 'card', id: row.cardId },
        ancestors: ancestorsOfCard(row),
      }).allowed;
      if (!allowed || row.dueDate === null) continue;

      cards.push({
        orgId,
        cardId: row.cardId,
        reference: `${row.projectKey}-${String(row.number)}`,
        title: row.title,
        dueDate: row.dueDate.toISOString().slice(0, 10),
        url: `${webOrigin}/boards/${row.boardId}?view=board&card=${row.cardId}&project=${row.projectId}`,
      });
    }
  }

  return cards;
}
