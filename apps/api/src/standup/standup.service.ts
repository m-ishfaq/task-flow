import { and, eq, inArray, isNull, schema, withOrgScope } from '@taskflow/db';
import type { ProjectId } from '@taskflow/contracts';
import { isGuestRole } from '@taskflow/policy';
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
 *
 * ## The buckets are Yesterday / Today / Overdue / Urgent, not "done vs. open"
 *
 * The first version bucketed every non-done card into one `stillOpen` pile —
 * which meant a card nobody had opened yet (status category `not_started`)
 * and a card someone was actively working on (`active`) were
 * indistinguishable, and a narration or UI built on top of that pile had no
 * way to say "here's what I'm doing today" versus "here's my whole backlog".
 * That is a real standup's actual shape (yesterday / today / blockers), and
 * a member's real answer to "what are you doing today" is the cards in an
 * `active`-category status, not everything they haven't finished. `today`
 * is exactly that — `not_started` cards are excluded from every bucket here
 * on purpose, not merely unbucketed: a standup is not the place to dump an
 * entire backlog, and a member who wants that already has the board.
 *
 * `overdue` and `urgent` are kept DISJOINT rather than allowing a card into
 * both: an overdue card is already the more severe fact, so a card past its
 * due date is reported there and excluded from `urgent` even if it also
 * carries a high/urgent priority — reporting the same card twice under two
 * headings would read as double-counting on a screen whose whole point is a
 * fast scan. `today` is independent of both — an active card can be
 * overdue, urgent, both, or neither, and still shows in `today` regardless.
 *
 * ## A guest sees only their own row — a real, reported gap, not a design change
 *
 * The "every project member should reach it" reasoning above is deliberately
 * unchanged for `member`/`admin`/`owner` — this is still not `analytics:read`,
 * and a Member still sees the whole roster. A GUEST is a different actor: per
 * this codebase's own guest-access design, a guest's entire access is a
 * relationship tuple on the one project they were invited to (Phase 15's
 * "Guest access into Work"), and this query was the one place that tuple's
 * narrow scope did not actually narrow anything — a viewer-relation guest who
 * can read the project's cards could also read every OTHER member's personal
 * Yesterday/Today/Overdue/Urgent breakdown, which is colleague-identifying
 * data an external party has no reason to see. `members` is filtered to the
 * guest's own row (via `isGuestRole`, `@taskflow/policy`'s sanctioned way to
 * ask this — guardrail 7 bans `role === 'guest'` inline) after the roster is
 * built, mirroring `standup-mail.ts`'s own team/personal split for the
 * EMAILED digest, extended here to the live page for the one actor that
 * split never covered. `urgentSprintCards`/`sprint` are untouched: neither
 * names a member, and a viewer-relation guest already sees every card's
 * title/priority/due date on the board itself, so there is nothing new to
 * disclose there.
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
  /** Done within `sinceHours` — "what did you do yesterday". */
  readonly yesterday: readonly StandupCard[];
  /** Status category `active` and not done — "what are you doing today". Deliberately
      NOT every open card: see this file's own header on why `not_started` backlog is
      excluded rather than folded in here. */
  readonly today: readonly StandupCard[];
  /** Not done, past its due date — regardless of status category, so an overdue
      `not_started` card still surfaces even though it never made `today`. */
  readonly overdue: readonly StandupCard[];
  /** Not done, `urgent`/`high` priority, and NOT already in `overdue` — see this
      file's own header on why the two buckets are kept disjoint. */
  readonly urgent: readonly StandupCard[];
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
  /** A plain count over the data above — see `headlineFor`'s own comment for why this
      is computed here rather than asked of a model. */
  readonly headline: string;
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
      {
        yesterday: StandupCard[];
        today: StandupCard[];
        overdue: StandupCard[];
        urgent: StandupCard[];
      }
    >();
    const bucketFor = (userId: string) => {
      const existing = byMember.get(userId);
      if (existing !== undefined) return existing;
      const created = { yesterday: [], today: [], overdue: [], urgent: [] };
      byMember.set(userId, created);
      return created;
    };

    for (const row of cardRows) {
      if (row.assigneeIds.length === 0) continue;
      const summary = cardOf(row);
      const isDone = row.statusCategory === 'done';
      const isActive = row.statusCategory === 'active';
      const isOverdue = !isDone && row.dueDate !== null && row.dueDate.getTime() < now.getTime();
      const isRecentlyDone = isDone && row.updatedAt.getTime() >= cutoff.getTime();
      const isUrgent =
        !isDone && !isOverdue && row.priority !== null && URGENT_PRIORITIES.has(row.priority);

      for (const userId of row.assigneeIds) {
        const bucket = bucketFor(userId);
        if (isRecentlyDone) bucket.yesterday.push(summary);
        if (isActive && !isDone) bucket.today.push(summary);
        if (isOverdue) bucket.overdue.push(summary);
        if (isUrgent) bucket.urgent.push(summary);
      }
    }

    const memberIds = [...byMember.keys()];
    const names =
      memberIds.length === 0 ? new Map<string, string | null>() : await nameLookup(tx, memberIds);

    const allMembers: StandupMember[] = memberIds
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

    /* A guest's own row only — see this file's own header. Every other role
       keeps the full roster, unchanged. */
    const members = isGuestRole(actor.subject.role)
      ? allMembers.filter((member) => member.userId === actor.subject.userId)
      : allMembers;

    return {
      sprint:
        sprint === undefined
          ? null
          : { sprintId: sprint.id, name: sprint.name, endsOn: sprint.endsOn },
      urgentSprintCards,
      members,
      headline: isGuestRole(actor.subject.role)
        ? 'Showing only your own tasks — other members are not shown to guests.'
        : headlineFor(members, urgentSprintCards),
    };
  });
}

/**
 * The aggregate line — a plain count over data this query already
 * assembled, computed here rather than asked of a model (this file's own
 * header — "classification stays deterministic"). Moved out of `narrate.ts`
 * when that route stopped producing per-member content at all: a headline
 * needs no AI call, so `query` returns it directly and the page can render
 * a real agenda before anyone clicks "Narrate". Never empty-string: a
 * project with genuinely nothing to report still gets an honest "Nobody has
 * open, done, or overdue work in this window" rather than a blank header
 * where a sentence was expected.
 */
export function headlineFor(
  members: readonly StandupMember[],
  urgentSprintCards: readonly StandupCard[],
): string {
  const total = members.length;
  if (total === 0) return 'Nobody has open, done, or overdue work in this window.';

  const overdueCount = members.filter((member) => member.overdue.length > 0).length;
  const doneCount = members.reduce((sum, member) => sum + member.yesterday.length, 0);
  const urgentCount = urgentSprintCards.length;

  const parts = [`${String(total)} ${total === 1 ? 'person' : 'people'}`];
  parts.push(
    overdueCount === 0
      ? 'nobody overdue'
      : `${String(overdueCount)} ${overdueCount === 1 ? 'person' : 'people'} with overdue work`,
  );
  parts.push(`${String(doneCount)} ${doneCount === 1 ? 'card' : 'cards'} done recently`);
  if (urgentCount > 0) {
    parts.push(`${String(urgentCount)} urgent sprint ${urgentCount === 1 ? 'card' : 'cards'} open`);
  }

  return parts.join(' · ');
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
