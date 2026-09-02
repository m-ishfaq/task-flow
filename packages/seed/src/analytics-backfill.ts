import { isNull, schema, withOrgScope } from '@taskflow/db';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { refreshOrg } from '@taskflow/api/analytics/refresh';
import { createRng } from './rng.js';
import { daysBefore } from './support.js';

/**
 * Analytics backfill for a seeded database (Phase 11, ai/phase-11-analytics.md
 * §2.2, §6).
 *
 * The going-forward projection relay only sees `card.status_changed` events that
 * happen after it exists, and the seed emits none of those (it writes cards
 * directly). So a freshly seeded database has an EMPTY `analytics.card_transitions`
 * table and empty rollups — every Insights dashboard shows "no data". This
 * synthesizes a plausible transition history from the cards already there, then
 * runs the REAL `refreshOrg` to build the rollups the dashboards read.
 *
 * It is the analytics analogue of `search-backfill.cli.ts`: an app-pool routine
 * that reads the source rows and populates a projection, reusing the production
 * code (`refreshOrg`) for the rollups rather than reimplementing five
 * aggregations that would then drift from `apps/api`'s own.
 *
 * ## Why history is synthesized, not read from real transitions
 *
 * A card row records only its PRESENT status. To draw a velocity chart, a
 * burndown, a cumulative-flow diagram or a cycle time, analytics needs to know
 * WHEN a card reached each category — which the transactional schema never
 * stored. So for each card this mints:
 *
 *   - a synthetic CREATION transition (from nothing into not_started) — the one
 *     shape migration 0091's CHECK allows for a `synthetic` row (source_event_id
 *     NULL, from_category NULL);
 *   - for a card whose current category is active or done, a not_started ->
 *     active transition, and for a done card an active -> done one. These carry
 *     from_category, so the same CHECK requires them to be `synthetic = false`
 *     with a source_event_id — a deterministic one derived from the card's own
 *     RNG stream, so re-running is idempotent against the (org, source_event_id)
 *     partial-unique rather than duplicating.
 *
 * The timing of all three is spread across the last ~50 days (see
 * `buildTransitions`), NOT anchored to the card's real `created_at` — that is
 * what keeps the flow inside the 30-day window the Flow and Burndown dashboards
 * read.
 *
 * The result is fixture data, honest about being fixture data: the numbers are
 * plausible and internally consistent, not a replay of events that happened.
 */

type Category = 'not_started' | 'active' | 'done';

/**
 * A fixed instant for the time bytes of every generated id. The RANDOM bytes
 * come from the card's seeded RNG stream, so an id is fully deterministic and a
 * second run mints the same ones — which is what makes ON CONFLICT DO NOTHING a
 * true no-op rather than an append. (The transition's own `occurred_at` is
 * relative to now and does vary run to run; it is not a unique key, so that is
 * harmless — a conflicting row keeps its first-run timestamp.)
 */
const ID_EPOCH = new Date('2020-01-01T00:00:00.000Z');

/** Chunk size for the transition insert — well under Postgres's 65_535-parameter ceiling. */
const INSERT_CHUNK = 500;

function normalizeCategory(value: string | null | undefined): Category {
  return value === 'active' || value === 'done' ? value : 'not_started';
}

interface SeedCard {
  readonly id: string;
  readonly boardId: string;
  readonly projectId: string;
  readonly statusId: string | null;
}

interface TransitionInsert {
  readonly id: string;
  readonly orgId: string;
  readonly cardId: string;
  readonly boardId: string;
  readonly projectId: string;
  readonly fromCategory: Category | null;
  readonly toCategory: Category;
  readonly occurredAt: Date;
  readonly synthetic: boolean;
  readonly sourceEventId: string | null;
}

/**
 * The transition timeline for one card, ending at its current category.
 *
 * The lifecycle is spread across the last ~50 days rather than anchored to
 * `card.createdAt` (which the seed scatters up to 300 days back), and that is
 * deliberate: the FLOW (CFD) and BURNDOWN dashboards read a 30-day window and
 * need the movement to fall INSIDE it — a card "created" 300 days ago and moved
 * to done last week gives velocity a data point but leaves CFD's backlog and
 * burndown's baseline off the left edge of the chart, which is why those two
 * tabs read empty while the org-wide ones did not. Done cards are created
 * before the window (so burndown has a starting backlog to burn down) and flow
 * through active to done inside it. Fixture timing, independent of the card's
 * real `created_at`, which analytics never joins against.
 */
function buildTransitions(
  orgId: string,
  card: SeedCard,
  category: Category,
  now: Date,
): TransitionInsert[] {
  const rng = createRng(`analytics:${card.id}`);
  const base = {
    orgId,
    cardId: card.id,
    boardId: card.boardId,
    projectId: card.projectId,
  };

  const rows: TransitionInsert[] = [];
  const push = (
    fromCategory: Category | null,
    toCategory: Category,
    daysAgo: number,
    synthetic: boolean,
  ): void => {
    rows.push({
      ...base,
      id: rng.uuid(ID_EPOCH),
      fromCategory,
      toCategory,
      occurredAt: daysBefore(now, daysAgo),
      synthetic,
      sourceEventId: synthetic ? null : rng.uuid(ID_EPOCH),
    });
  };

  if (category === 'done') {
    const created = rng.int(28, 50); // before the 30-day window: burndown's baseline
    const active = rng.int(10, created - 2); // inside the window
    const done = rng.int(0, Math.min(9, active - 1)); // recent, after active
    push(null, 'not_started', created, true);
    push('not_started', 'active', active, false);
    push('active', 'done', done, false);
  } else if (category === 'active') {
    const created = rng.int(18, 50);
    const active = rng.int(0, created - 2);
    push(null, 'not_started', created, true);
    push('not_started', 'active', active, false);
  } else {
    // A still-open card: some created inside the window, some before it, so the
    // CFD backlog is visible and burndown's remaining line does not start flat.
    push(null, 'not_started', rng.int(1, 40), true);
  }

  return rows;
}

/**
 * Backfills one org: synthesize transitions from its cards, then refresh its
 * rollups. Runs under `withOrgScope`, so RLS scopes both the reads and the
 * transition writes; `refreshOrg` opens its own scope afterward and reads the
 * committed rows.
 */
export async function backfillAnalyticsOrg(orgId: OrgId, now: Date): Promise<number> {
  const inserted = await withOrgScope(orgId, async (tx) => {
    const statuses = await tx
      .select({ id: schema.statuses.id, category: schema.statuses.category })
      .from(schema.statuses);
    const categoryById = new Map(statuses.map((s) => [s.id, s.category]));

    const cards = await tx
      .select({
        id: schema.cards.id,
        boardId: schema.cards.boardId,
        projectId: schema.cards.projectId,
        statusId: schema.cards.statusId,
      })
      .from(schema.cards)
      .where(isNull(schema.cards.deletedAt));

    const rows: TransitionInsert[] = [];
    for (const card of cards) {
      const category = card.statusId
        ? normalizeCategory(categoryById.get(card.statusId))
        : 'not_started';
      rows.push(...buildTransitions(orgId, card, category, now));
    }

    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx
        .insert(schema.cardTransitions)
        .values(rows.slice(i, i + INSERT_CHUNK))
        // A re-run mints the same ids and source-event-ids, so every row
        // conflicts on the migration's partial-uniques and inserts nothing.
        .onConflictDoNothing();
    }

    return rows.length;
  });

  // Reuse the production refresh so seeded rollups are byte-for-byte what the
  // worker would compute — no second implementation to drift.
  await refreshOrg(orgId);

  return inserted;
}

export interface AnalyticsBackfillResult {
  readonly orgs: number;
  readonly transitions: number;
}

/**
 * Backfills analytics for the given orgs. Assumes the app pool is already
 * initialized (`initializeDatabase`) — the caller owns its lifecycle, exactly
 * as `search-backfill.cli.ts` does.
 *
 * The caller passes the org ids rather than this discovering them, and that is
 * deliberate: `listOrgIds()` runs under `withGlobalScope` as `taskflow_app`,
 * and `identity.orgs` has NO policy admitting the app role with `app.org_id`
 * cleared — so it returns ZERO rows (migration 0004; the app role can only see
 * an org it is scoped INTO or a MEMBER of). The seed already holds the ids it
 * just wrote; the standalone CLI enumerates them through the audit role, which
 * 0037 grants an explicit `USING (true)` read of `identity.orgs`.
 */
export async function backfillAnalytics(
  orgIds: readonly string[],
  log: (message: string) => void,
): Promise<AnalyticsBackfillResult> {
  const now = new Date();

  let transitions = 0;
  for (const id of orgIds) {
    const orgId = unsafeAsId<'OrgId'>(id);
    const count = await backfillAnalyticsOrg(orgId, now);
    transitions += count;
    log(`  ${id}: ${String(count)} transition(s), rollups refreshed`);
  }

  return { orgs: orgIds.length, transitions };
}
