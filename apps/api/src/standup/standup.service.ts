import { and, eq, inArray, isNull, schema, withOrgScope } from '@taskflow/db';
import type { ProjectId } from '@taskflow/contracts';
import { requireProject } from '../work/project.service.js';
import { orgOf, type WorkActor } from '../work/shared.js';

/**
 * The standup view's data (ai/phase-15-ai-copilot-and-permissions.md §5) — "a
 * new screen, not a new subsystem: assembles data that already exists."
 * Every field here is read straight from `work.cards`/`work.sprints`, the
 * same tables the board and the analytics workload query already read;
 * nothing is written here and nothing new is stored.
 *
 * Authorization is `requireProject(..., 'project:read')` — the same floor
 * `board.service.ts`'s `createBoard` uses to establish a project is
 * reachable at all — deliberately NOT `analytics:read`. A standup is a daily
 * team ritual, not an admin report: every member of the project should be
 * able to open it, which is the opposite of `viewAnalytics`'s
 * Admin-and-Owner-only floor (CLAUDE.md's own reasoning for why that one is
 * role-only). Moving or reassigning a card FROM this view (a later UI
 * concern, not this query) needs no new authorization either — it is the
 * same `card.move`/`card.assign` the board already gates.
 */

export interface StandupCard {
  readonly cardId: string;
  readonly reference: string;
  readonly title: string;
  readonly priority: string | null;
  readonly dueDate: string | null;
}

export interface StandupMember {
  readonly userId: string;
  readonly name: string | null;
  readonly recentlyDone: readonly StandupCard[];
  readonly stillOpen: readonly StandupCard[];
  readonly overdue: readonly StandupCard[];
}

export interface StandupSprint {
  readonly sprintId: string;
  readonly name: string;
  readonly endsOn: string;
}

export interface StandupResult {
  readonly sprint: StandupSprint | null;
  /** The active sprint's urgent/high cards, "shown by default" per §5 — never-done ones only. */
  readonly urgentSprintCards: readonly StandupCard[];
  readonly members: readonly StandupMember[];
}

const URGENT_PRIORITIES = new Set(['urgent', 'high']);

function referenceOf(key: string, number: number): string {
  return `${key}-${String(number)}`;
}

/**
 * `sinceHours` bounds "recently done" — a card is not marked done AT a
 * moment this schema records (`work.cards` has no `done_at`, only
 * `updated_at`; see `card.service.ts`'s own header on why a rank-and-status
 * table like this one tracks the present, not a history of it), so
 * "recently" is approximated as "its status changed to done and the row was
 * touched within the window" — the same present-state approximation
 * `dashboard.service.ts`'s `queryWorkload` already accepts for an identical
 * reason (§3.5's own header: "a question about the PRESENT").
 */
export async function queryStandup(
  actor: WorkActor,
  input: { readonly projectId: ProjectId; readonly sinceHours?: number },
): Promise<StandupResult> {
  const sinceHours = input.sinceHours ?? 24;

  return withOrgScope(orgOf(actor), async (tx) => {
    const project = await requireProject(tx, actor, input.projectId, 'project:read');

    const sprintRows = await tx
      .select({ id: schema.sprints.id, name: schema.sprints.name, endsOn: schema.sprints.endsOn })
      .from(schema.sprints)
      .where(
        and(eq(schema.sprints.projectId, input.projectId), eq(schema.sprints.status, 'active')),
      )
      .limit(1);
    const sprint = sprintRows[0];

    const cardRows = await tx
      .select({
        id: schema.cards.id,
        number: schema.cards.number,
        title: schema.cards.title,
        priority: schema.cards.priority,
        dueDate: schema.cards.dueDate,
        assigneeIds: schema.cards.assigneeIds,
        sprintId: schema.cards.sprintId,
        updatedAt: schema.cards.updatedAt,
        statusCategory: schema.statuses.category,
      })
      .from(schema.cards)
      .leftJoin(schema.statuses, eq(schema.statuses.id, schema.cards.statusId))
      .where(
        and(
          eq(schema.cards.projectId, input.projectId),
          isNull(schema.cards.archivedAt),
          isNull(schema.cards.deletedAt),
        ),
      );

    const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    const now = new Date();

    const cardOf = (row: (typeof cardRows)[number]): StandupCard => ({
      cardId: row.id,
      reference: referenceOf(project.key, row.number),
      title: row.title,
      priority: row.priority,
      dueDate: row.dueDate === null ? null : row.dueDate.toISOString(),
    });

    const urgentSprintCards =
      sprint === undefined
        ? []
        : cardRows
            .filter(
              (row) =>
                row.sprintId === sprint.id &&
                row.statusCategory !== 'done' &&
                row.priority !== null &&
                URGENT_PRIORITIES.has(row.priority),
            )
            .map(cardOf);

    const byMember = new Map<
      string,
      { recentlyDone: StandupCard[]; stillOpen: StandupCard[]; overdue: StandupCard[] }
    >();
    const bucketFor = (userId: string) => {
      const existing = byMember.get(userId);
      if (existing !== undefined) return existing;
      const created = { recentlyDone: [], stillOpen: [], overdue: [] };
      byMember.set(userId, created);
      return created;
    };

    for (const row of cardRows) {
      if (row.assigneeIds.length === 0) continue;
      const summary = cardOf(row);
      const isDone = row.statusCategory === 'done';
      const isOverdue = !isDone && row.dueDate !== null && row.dueDate.getTime() < now.getTime();
      const isRecentlyDone = isDone && row.updatedAt.getTime() >= cutoff.getTime();

      for (const userId of row.assigneeIds) {
        const bucket = bucketFor(userId);
        if (isRecentlyDone) bucket.recentlyDone.push(summary);
        else if (!isDone) bucket.stillOpen.push(summary);
        if (isOverdue) bucket.overdue.push(summary);
      }
    }

    const memberIds = [...byMember.keys()];
    const names =
      memberIds.length === 0 ? new Map<string, string | null>() : await nameLookup(tx, memberIds);

    const members: StandupMember[] = memberIds
      .map((userId) => {
        const bucket = byMember.get(userId);
        if (bucket === undefined) throw new Error('unreachable: bucket built from its own keys');
        return {
          userId,
          name: names.get(userId) ?? null,
          ...bucket,
        };
      })
      .sort((a, b) => (a.name ?? a.userId).localeCompare(b.name ?? b.userId));

    return {
      sprint:
        sprint === undefined
          ? null
          : { sprintId: sprint.id, name: sprint.name, endsOn: sprint.endsOn },
      urgentSprintCards,
      members,
    };
  });
}

/**
 * Display names for a batch of members, `people.profiles` first and the
 * account email as the fallback — `notification.projection.ts`'s own
 * `resolveActorLabels` precedent, restated here rather than imported because
 * that function is `platform/`'s own and runs as a different database role
 * (`taskflow_audit`) than this one (`taskflow_app`).
 */
async function nameLookup(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  userIds: readonly string[],
): Promise<Map<string, string | null>> {
  const [profileRows, userRows] = await Promise.all([
    tx
      .select({ userId: schema.profiles.userId, displayName: schema.profiles.displayName })
      .from(schema.profiles)
      .where(inArray(schema.profiles.userId, [...userIds])),
    tx
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(inArray(schema.users.id, [...userIds])),
  ]);

  const displayNameById = new Map(profileRows.map((row) => [row.userId, row.displayName]));
  const emailById = new Map(userRows.map((row) => [row.id, row.email]));

  const names = new Map<string, string | null>();
  for (const userId of userIds) {
    names.set(userId, displayNameById.get(userId) ?? emailById.get(userId) ?? null);
  }
  return names;
}
