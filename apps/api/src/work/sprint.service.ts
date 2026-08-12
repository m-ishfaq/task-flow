import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  outboxWriter,
  schema,
  withOrgScope,
} from '@taskflow/db';
import { errors, type CardId, type ProjectId, type SprintId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { loadCard } from './card.service.js';
import {
  cardSprintChanged,
  sprintCancelled,
  sprintCompleted,
  sprintCreated,
  sprintStarted,
  sprintUpdated,
} from './events.js';
import { requireProject } from './project.service.js';
import {
  ancestorsOfCard,
  envelopeOf,
  enforceOn,
  orgOf,
  translatingConstraints,
  userOf,
  type WorkActor,
} from './shared.js';

/**
 * Sprints (`ai/phase-10.5-sprints.md`).
 *
 * The lifecycle: `planned → active → completed`, plus `cancelled` from either.
 * The column is a `status` with a CHECK on the four values; THIS file guards
 * the transitions (you cannot complete a planned sprint without starting it,
 * cannot reactivate a completed one) and the partial unique index in 0054 is
 * the backstop for one-active-per-project.
 *
 * Same authorization split Phase 3 established for the project's other
 * vocabulary: managing the project's planning structure (create/start/complete/
 * cancel) is `project:update`; moving ONE card into or out of a sprint is
 * `card:update`.
 */

export type SprintStatus = 'planned' | 'active' | 'completed' | 'cancelled';

export interface SprintSummary {
  readonly sprintId: string;
  readonly projectId: string;
  readonly name: string;
  readonly goal: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: SprintStatus;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly cardCount: number;
}

/**
 * The picker's list, per project (decision — the sprint is a dimension on the
 * existing board, and this is the query behind the picker's options).
 *
 * Order is deliberate: the active sprint first, then planned ones in date
 * order, then closed ones newest-first — the order a sprint switcher wants to
 * see them, and a stable one for tests.
 */
export async function listSprints(
  actor: WorkActor,
  input: { readonly projectId: ProjectId },
): Promise<readonly SprintSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    await requireProject(tx, actor, input.projectId, 'project:read');

    const rows = await tx
      .select({
        sprintId: schema.sprints.id,
        projectId: schema.sprints.projectId,
        name: schema.sprints.name,
        goal: schema.sprints.goal,
        startsOn: schema.sprints.startsOn,
        endsOn: schema.sprints.endsOn,
        status: schema.sprints.status,
        startedAt: schema.sprints.startedAt,
        completedAt: schema.sprints.completedAt,
      })
      .from(schema.sprints)
      .where(eq(schema.sprints.projectId, input.projectId));

    const attached = await tx
      .select({ sprintId: schema.cards.sprintId })
      .from(schema.cards)
      .where(
        and(
          eq(schema.cards.projectId, input.projectId),
          isNull(schema.cards.deletedAt),
          isNotNull(schema.cards.sprintId),
        ),
      );

    const counts = new Map<string, number>();
    for (const row of attached) {
      if (row.sprintId === null) continue;
      counts.set(row.sprintId, (counts.get(row.sprintId) ?? 0) + 1);
    }

    const statusRank: Readonly<Record<SprintStatus, number>> = {
      active: 0,
      planned: 1,
      completed: 2,
      cancelled: 3,
    };

    return rows
      .map((row) => ({
        ...row,
        status: row.status as SprintStatus,
        cardCount: counts.get(row.sprintId) ?? 0,
      }))
      .sort((a, b) => {
        const byStatus = statusRank[a.status] - statusRank[b.status];
        if (byStatus !== 0) return byStatus;
        if (a.status === 'completed' || a.status === 'cancelled') {
          return (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0);
        }
        return a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0;
      });
  });
}

export async function createSprint(
  actor: WorkActor,
  input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly goal: string | null;
    readonly startsOn: string;
    readonly endsOn: string;
  },
): Promise<{ readonly sprintId: SprintId }> {
  const sprintId = newId<'SprintId'>();

  await withOrgScope(orgOf(actor), async (tx) => {
    await requireProject(tx, actor, input.projectId, 'project:update');
    assertDatesOrdered(input.startsOn, input.endsOn);

    await tx.insert(schema.sprints).values({
      id: sprintId,
      orgId: orgOf(actor),
      projectId: input.projectId,
      name: input.name,
      goal: input.goal,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      status: 'planned',
      createdBy: userOf(actor),
    });

    await outboxWriter.append(tx, [
      createEvent(
        sprintCreated,
        {
          sprintId,
          projectId: input.projectId,
          name: input.name,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { sprintId };
}

/**
 * Edits a sprint's plan.
 *
 * The editability rules are the lifecycle's commitment, stated where they are
 * enforced: a `planned` sprint is fully editable; an `active` one may change
 * only its goal — the dates are the contract the burndown reads against and
 * renaming mid-flight is how a team loses its own history; a `completed` or
 * `cancelled` sprint is a record and is not editable at all.
 */
export async function updateSprint(
  actor: WorkActor,
  input: {
    readonly sprintId: SprintId;
    readonly name: string;
    readonly goal: string | null;
    readonly startsOn: string;
    readonly endsOn: string;
  },
): Promise<{ readonly name: string }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const sprint = await loadSprint(tx, input.sprintId);
    await requireProject(tx, actor, sprint.projectId as ProjectId, 'project:update');

    assertDatesOrdered(input.startsOn, input.endsOn);

    const before = {
      name: sprint.name,
      goal: sprint.goal,
      startsOn: sprint.startsOn,
      endsOn: sprint.endsOn,
    };
    const after = {
      name: input.name,
      goal: input.goal,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
    };

    /* No-op save FIRST, before the editability guards: a manager panel that
       fires on blur must stay out of the audit log for a click that changed
       nothing — even on a sprint that is now a record, where "edit this" is
       refused. Nothing changed, so refusing would be a lie. The `setCardStatus`
       precedent returns its no-op the same way, ahead of any guard. */
    if (
      before.name === after.name &&
      before.goal === after.goal &&
      before.startsOn === after.startsOn &&
      before.endsOn === after.endsOn
    ) {
      return { name: input.name };
    }

    if (sprint.status === 'completed' || sprint.status === 'cancelled') {
      throw errors.validation({ sprintId: 'A completed or cancelled sprint cannot be edited.' });
    }
    if (sprint.status === 'active') {
      const locked =
        input.name !== sprint.name ||
        input.startsOn !== sprint.startsOn ||
        input.endsOn !== sprint.endsOn;
      if (locked) {
        throw errors.validation({ sprintId: 'Only the goal of an active sprint can be edited.' });
      }
    }

    await tx
      .update(schema.sprints)
      .set({
        name: input.name,
        goal: input.goal,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
      })
      .where(eq(schema.sprints.id, input.sprintId));

    await outboxWriter.append(tx, [
      createEvent(
        sprintUpdated,
        { sprintId: input.sprintId, projectId: sprint.projectId, before, after },
        envelopeOf(actor),
      ),
    ]);

    return { name: input.name };
  });
}

/**
 * Opens the project's one-at-a-time window: `planned → active`.
 *
 * The service check exists to give the human a message; the partial unique
 * index in 0054 is what actually refuses a second active sprint — a second
 * writer racing this one hits the index, and the unique violation is
 * translated here to the same conflict.
 */
export async function startSprint(
  actor: WorkActor,
  input: { readonly sprintId: SprintId },
): Promise<{ readonly status: 'active' }> {
  return translatingConstraints(
    async () =>
      withOrgScope(orgOf(actor), async (tx) => {
        const sprint = await loadSprint(tx, input.sprintId);
        await requireProject(tx, actor, sprint.projectId as ProjectId, 'project:update');

        if (sprint.status !== 'planned') {
          throw errors.conflict(
            `Only a planned sprint can be started — this one is ${sprint.status}.`,
          );
        }

        const startedAt = new Date();
        await tx
          .update(schema.sprints)
          .set({ status: 'active', startedAt })
          .where(eq(schema.sprints.id, input.sprintId));

        await outboxWriter.append(tx, [
          createEvent(
            sprintStarted,
            {
              sprintId: input.sprintId,
              projectId: sprint.projectId,
              startedAt: startedAt.toISOString(),
            },
            envelopeOf(actor),
          ),
        ]);

        return { status: 'active' as const };
      }),
    () => errors.conflict('Another sprint in this project is already active.'),
  );
}

/**
 * Closes the sprint (decision 5), as one atomic transaction.
 *
 * Done cards KEEP `sprint_id` — the completed sprint is a stable record of
 * what shipped, which is exactly what Phase 11's velocity and burndown read —
 * and every card whose status category is not `done` returns to the backlog
 * (`sprint_id = NULL`). The event carries the counts (`shippedCount`,
 * `releasedCount`) so the UI can say what the close did without a follow-up
 * query, and a `card.sprint_changed` is emitted per released card — the close
 * is a batch of membership changes plus the sprint transition, and the events
 * say so.
 */
export async function completeSprint(
  actor: WorkActor,
  input: { readonly sprintId: SprintId },
): Promise<{
  readonly status: 'completed';
  readonly shippedCount: number;
  readonly releasedCount: number;
}> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const sprint = await loadSprint(tx, input.sprintId);
    await requireProject(tx, actor, sprint.projectId as ProjectId, 'project:update');

    if (sprint.status !== 'active') {
      throw errors.conflict(
        `Only the active sprint can be completed — this one is ${sprint.status}.`,
      );
    }

    const attached = await tx
      .select({
        cardId: schema.cards.id,
        boardId: schema.cards.boardId,
        category: schema.statuses.category,
      })
      .from(schema.cards)
      .leftJoin(schema.statuses, eq(schema.statuses.id, schema.cards.statusId))
      .where(and(eq(schema.cards.sprintId, input.sprintId), isNull(schema.cards.deletedAt)));

    const released = attached.filter((card) => card.category !== 'done');
    const shippedCount = attached.length - released.length;

    if (released.length > 0) {
      await tx
        .update(schema.cards)
        .set({ sprintId: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.cards.sprintId, input.sprintId),
            inArray(
              schema.cards.id,
              released.map((card) => card.cardId),
            ),
          ),
        );
    }

    const completedAt = new Date();
    await tx
      .update(schema.sprints)
      .set({ status: 'completed', completedAt })
      .where(eq(schema.sprints.id, input.sprintId));

    await outboxWriter.append(tx, [
      ...released.map((card) =>
        createEvent(
          cardSprintChanged,
          { cardId: card.cardId, boardId: card.boardId, before: input.sprintId, after: null },
          envelopeOf(actor),
        ),
      ),
      createEvent(
        sprintCompleted,
        {
          sprintId: input.sprintId,
          projectId: sprint.projectId,
          completedAt: completedAt.toISOString(),
          shippedCount,
          releasedCount: released.length,
        },
        envelopeOf(actor),
      ),
    ]);

    return { status: 'completed' as const, shippedCount, releasedCount: released.length };
  });
}

/**
 * Cancels a sprint — the team decided it was not going to happen.
 *
 * Releases EVERY card, done ones included: unlike a completion, nothing
 * shipped. `planned` and `active` can be cancelled; a completed one is a
 * record and a cancelled one is already over.
 */
export async function cancelSprint(
  actor: WorkActor,
  input: { readonly sprintId: SprintId },
): Promise<{ readonly status: 'cancelled'; readonly releasedCount: number }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const sprint = await loadSprint(tx, input.sprintId);
    await requireProject(tx, actor, sprint.projectId as ProjectId, 'project:update');

    if (sprint.status !== 'planned' && sprint.status !== 'active') {
      throw errors.conflict(
        `Only a planned or active sprint can be cancelled — this one is ${sprint.status}.`,
      );
    }

    const attached = await tx
      .select({ cardId: schema.cards.id, boardId: schema.cards.boardId })
      .from(schema.cards)
      .where(and(eq(schema.cards.sprintId, input.sprintId), isNull(schema.cards.deletedAt)));

    if (attached.length > 0) {
      await tx
        .update(schema.cards)
        .set({ sprintId: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.cards.sprintId, input.sprintId),
            inArray(
              schema.cards.id,
              attached.map((card) => card.cardId),
            ),
          ),
        );
    }

    await tx
      .update(schema.sprints)
      .set({ status: 'cancelled' })
      .where(eq(schema.sprints.id, input.sprintId));

    await outboxWriter.append(tx, [
      ...attached.map((card) =>
        createEvent(
          cardSprintChanged,
          { cardId: card.cardId, boardId: card.boardId, before: input.sprintId, after: null },
          envelopeOf(actor),
        ),
      ),
      createEvent(
        sprintCancelled,
        { sprintId: input.sprintId, projectId: sprint.projectId, releasedCount: attached.length },
        envelopeOf(actor),
      ),
    ]);

    return { status: 'cancelled' as const, releasedCount: attached.length };
  });
}

/**
 * Puts one card into a sprint — `card:update`, the established split.
 *
 * Refusing `completed`/`cancelled` sprints is what keeps the shipped record
 * stable: a card assigned to a closed sprint after the fact would change what
 * Phase 11 reads as that sprint's output retroactively. The composite FK in
 * 0054 is what keeps the sprint inside the card's OWN project, and a violation
 * is translated to a 404 — the parent the caller named is, as far as they are
 * permitted to know, not there.
 */
export async function assignSprint(
  actor: WorkActor,
  input: { readonly cardId: CardId; readonly sprintId: SprintId },
): Promise<{ readonly sprintId: string }> {
  return translatingConstraints(
    async () =>
      withOrgScope(orgOf(actor), async (tx) => {
        const card = await loadCard(tx, input.cardId);

        enforceOn(
          actor,
          'card:update',
          { type: 'card', id: input.cardId },
          card,
          ancestorsOfCard(card),
        );

        const sprint = await loadSprint(tx, input.sprintId);

        if (sprint.status === 'completed' || sprint.status === 'cancelled') {
          throw errors.conflict(`A ${sprint.status} sprint cannot take new cards.`);
        }

        if (card.sprintId === input.sprintId) return { sprintId: card.sprintId };

        await tx
          .update(schema.cards)
          .set({ sprintId: input.sprintId, updatedAt: new Date() })
          .where(eq(schema.cards.id, input.cardId));

        await outboxWriter.append(tx, [
          createEvent(
            cardSprintChanged,
            {
              cardId: input.cardId,
              boardId: card.boardId,
              before: card.sprintId,
              after: input.sprintId,
            },
            envelopeOf(actor),
          ),
        ]);

        return { sprintId: input.sprintId };
      }),
    () => errors.notFound(),
  );
}

/** Takes one card back to the backlog — the inverse of `assignSprint`. */
export async function releaseSprint(
  actor: WorkActor,
  input: { readonly cardId: CardId },
): Promise<{ readonly sprintId: null }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);

    enforceOn(
      actor,
      'card:update',
      { type: 'card', id: input.cardId },
      card,
      ancestorsOfCard(card),
    );

    if (card.sprintId === null) return { sprintId: null };

    await tx
      .update(schema.cards)
      .set({ sprintId: null, updatedAt: new Date() })
      .where(eq(schema.cards.id, input.cardId));

    await outboxWriter.append(tx, [
      createEvent(
        cardSprintChanged,
        { cardId: input.cardId, boardId: card.boardId, before: card.sprintId, after: null },
        envelopeOf(actor),
      ),
    ]);

    return { sprintId: null };
  });
}

interface SprintRow {
  readonly orgId: string;
  readonly projectId: string;
  readonly name: string;
  readonly goal: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: SprintStatus;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

async function loadSprint(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  sprintId: SprintId,
): Promise<SprintRow> {
  const rows = await tx
    .select({
      orgId: schema.sprints.orgId,
      projectId: schema.sprints.projectId,
      name: schema.sprints.name,
      goal: schema.sprints.goal,
      startsOn: schema.sprints.startsOn,
      endsOn: schema.sprints.endsOn,
      status: schema.sprints.status,
      startedAt: schema.sprints.startedAt,
      completedAt: schema.sprints.completedAt,
    })
    .from(schema.sprints)
    .where(eq(schema.sprints.id, sprintId))
    .limit(1);

  const sprint = rows[0];
  if (!sprint) throw errors.notFound();
  return { ...sprint, status: sprint.status as SprintStatus };
}

/**
 * Day-granular dates, compared as `YYYY-MM-DD` strings — lexicographic order
 * IS chronological order for this format. The migration's CHECK is the second
 * copy and the enforcement; this check exists so a wrong order is a 400 with
 * a message instead of a 500.
 */
function assertDatesOrdered(startsOn: string, endsOn: string): void {
  if (endsOn < startsOn) {
    throw errors.validation({ endsOn: 'The end date must not be before the start date.' });
  }
}
