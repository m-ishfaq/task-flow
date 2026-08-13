import { createEvent } from '@taskflow/events';
import { sprintCompleted, sprintCreated, sprintStarted } from '@taskflow/api/events/work';
import { defineSeedModule } from '../registry.js';
import { daysAfter, daysBefore, envelopeFor, latest } from '../support.js';
import { projectsModule } from './work.projects.js';
import { cardsModule } from './work.cards.js';

/**
 * Sprints (Phase 10.5) — a project's one-active-window plan.
 *
 * ## A HISTORY, not one sprint per state
 *
 * Every project gets a run of back-to-back fortnightly sprints:
 *
 *   - several COMPLETED (in the past, `completed_at` set), each with cards
 *     still attached — the close transaction's "done cards stay attached"
 *     half, so the board shows what shipped;
 *   - exactly one ACTIVE (now), with live cards assigned — the sprint board a
 *     demo opens already has work in it;
 *   - one or two PLANNED (ahead) — the windows lined up next, mostly empty
 *     because that is the normal state.
 *
 * The original version seeded exactly one of each, which is the minimum that
 * proves the three states render and the least that looks like a team. A
 * velocity chart needs a run of closed sprints to plot; a sprint picker with
 * three entries never wraps; and "what did we ship last quarter" has no
 * answer at all. The counts come from `ProjectPlan.sprints` so the shape is
 * declared per project, like boards and lists, rather than rolled.
 *
 * The active sprint is a real sprint by the migration's lights: `starts_on` is
 * in the past and `ends_on` in the future, `started_at` is set, and the
 * project has exactly ONE active sprint (the unique index would refuse a
 * second — which is also the property the seed is exercising). The generator
 * below emits exactly one by construction rather than by hoping.
 *
 * ## Card membership is written by UPDATE, and the ids come from events
 *
 * The cards module emits a `card.created` event per card (buffered on `ctx`,
 * drained by `platform.audit`), and the payload carries `cardId` and
 * `projectId` — so this module reads the buffer to know which cards belong to
 * which project, the same way `platform.audit` reads it to know which org an
 * event belongs to. There is no other path from `CardsOutput` back to
 * individual rows: it deliberately exposes only `SeededCardRef` (what an
 * attachment needs), and re-reading ids from the buffer beats re-deriving the
 * cards module's internal draft logic, which is exactly the kind of
 * duplication that drifts.
 *
 * Assigning a card to a sprint is an UPDATE on `work.cards.sprint_id`, scoped
 * by the same `orgScope` every insert runs under — the module's own rows, the
 * cards' rows too. Completed sprints get NO new assignments, matching the
 * service: a closed sprint is part of the shipped record.
 */

export interface SprintsOutput {
  readonly sprintCount: number;
  readonly assignedCards: number;
}

export const sprintsModule = defineSeedModule({
  name: 'work.sprints',
  /* `work.cards` is a real dependency even though its OUTPUT is never read:
     the card ids below come from the `card.created` events the cards module
     buffered, so this module must run AFTER it. Declared here — and pulled
     through `ctx.use` — so the ordering is compiler-checked rather than an
     accident of wherever this module happens to sit in a root's list. */
  requires: [projectsModule, cardsModule],
  tables: ['work.sprints'],

  async seed(ctx): Promise<SprintsOutput> {
    const { projects } = ctx.use(projectsModule);
    void ctx.use(cardsModule);

    // projectId -> live card ids, captured from the cards module's own events.
    // Only 'live' cards emit card.created here (the archived/deleted kinds are
    // written with their state directly); that is exactly the pool a sprint
    // board should draw from.
    const cardsByProject = new Map<string, string[]>();
    for (const event of ctx.bufferedEvents()) {
      if (event.name !== 'card.created') continue;
      const payload = event.payload as { cardId?: string; projectId?: string };
      if (typeof payload.cardId !== 'string' || typeof payload.projectId !== 'string') continue;
      const list = cardsByProject.get(payload.projectId) ?? [];
      list.push(payload.cardId);
      cardsByProject.set(payload.projectId, list);
    }

    let sprintCount = 0;
    let assignedCards = 0;

    for (const project of projects) {
      const { orgId } = project;
      const members = project.org.members;
      const actorId = members[0]?.id ?? project.org.owner.id;
      const cardIds = cardsByProject.get(project.id) ?? [];
      const shape = project.plan.sprints ?? DEFAULT_SPRINTS;

      const sprints = buildSprintHistory(ctx.now, shape, cardIds);

      for (const sprint of sprints) {
        const sprintId = ctx.rng.uuid(ctx.now);
        const createdBy = actorId;
        const createdAt = latest(project.org.createdAt, daysBefore(ctx.now, 26));
        const beganAt = sprint.startedAt ?? createdAt;
        const closedAt = sprint.completedAt ?? createdAt;

        await ctx.orgScope(orgId, () =>
          ctx.db.insert(
            'work.sprints',
            [
              'id',
              'org_id',
              'project_id',
              'name',
              'goal',
              'starts_on',
              'ends_on',
              'status',
              'started_at',
              'completed_at',
              'created_by',
              'created_at',
            ],
            [
              [
                sprintId,
                orgId,
                project.id,
                sprint.name,
                sprint.goal,
                sprint.startsOn.toISOString().slice(0, 10),
                sprint.endsOn.toISOString().slice(0, 10),
                sprint.status,
                sprint.startedAt?.toISOString() ?? null,
                sprint.completedAt?.toISOString() ?? null,
                createdBy,
                createdAt.toISOString(),
              ],
            ],
          ),
        );

        // Lifecycle events, mirroring what the service would have emitted.
        ctx.emit(
          createEvent(
            sprintCreated,
            {
              sprintId,
              projectId: project.id,
              name: sprint.name,
              startsOn: sprint.startsOn.toISOString().slice(0, 10),
              endsOn: sprint.endsOn.toISOString().slice(0, 10),
            },
            envelopeFor(orgId, createdBy, createdAt),
          ),
        );
        if (sprint.status === 'active') {
          ctx.emit(
            createEvent(
              sprintStarted,
              { sprintId, projectId: project.id, startedAt: beganAt.toISOString() },
              envelopeFor(orgId, createdBy, beganAt),
            ),
          );
        } else if (sprint.status === 'completed') {
          ctx.emit(
            createEvent(
              sprintCompleted,
              {
                sprintId,
                projectId: project.id,
                completedAt: closedAt.toISOString(),
                shippedCount: sprint.attached.length,
                releasedCount: 0,
              },
              envelopeFor(orgId, createdBy, closedAt),
            ),
          );
        }

        // Attach the cards this sprint claims, one scoped UPDATE. The service
        // keeps a card in a COMPLETED sprint when it closed as `done`; the
        // seeded approximation attaches a couple of cards and leaves the rest
        // to the backlog, which is the observable half.
        if (sprint.attached.length > 0) {
          await ctx.orgScope(orgId, () =>
            ctx.db.query(
              `UPDATE work.cards SET sprint_id = $1, updated_at = $2
                WHERE org_id = $3 AND id = ANY($4::uuid[])`,
              [sprintId, closedAt.toISOString(), orgId, sprint.attached],
            ),
          );
          assignedCards += sprint.attached.length;
        }

        sprintCount += 1;
      }
    }

    ctx.log(
      `work.sprints: ${String(sprintCount)} sprint(s), ${String(assignedCards)} card(s) assigned`,
    );
    return { sprintCount, assignedCards };
  },
});

/** A fortnight. Long enough that a completed run spans a readable quarter. */
const SPRINT_DAYS = 14;

/** How much of the active window has already elapsed, so "now" sits inside it. */
const ACTIVE_ELAPSED_DAYS = 4;

/** Used by any project that does not declare its own shape. */
export const DEFAULT_SPRINTS: SprintShape = { completed: 3, planned: 2 };

export interface SprintShape {
  readonly completed: number;
  readonly planned: number;
}

/**
 * Goals for the closed sprints, cycled in order.
 *
 * A literal list rather than generated text, for `profiles.ts`'s stated
 * reason: a velocity chart with six sprints called "Sprint N" and no goals
 * reads as placeholder data in a screenshot, and that is the one place this
 * dataset is meant to hold up.
 */
const GOALS = [
  'Ship the board, the card detail and the filter bar end to end.',
  'Close the design-review backlog and land the keyboard shortcuts.',
  'Cut first-paint time on the board below a second at 500 cards.',
  'Move search onto the new index and retire the old query path.',
  'Harden the import pipeline against partial failures.',
  'Finish the mobile layout for the three most-used screens.',
  'Pay down the flaky tests blocking the release train.',
  'Instrument the slow endpoints and publish the dashboard.',
];

/**
 * A back-to-back run of sprints ending in one active window.
 *
 * Built BACKWARDS from the active sprint so that "now" always falls inside it
 * regardless of how many closed sprints precede it. Tiling forwards from an
 * arbitrary start instead would make the active window's position depend on
 * the count — and a project with four completed sprints would quietly have no
 * active one, which the UI renders as an empty sprint board rather than as an
 * error.
 *
 * Exactly one `active` is produced by construction. `work.sprints`' unique
 * index would refuse a second, so this is the difference between a seed run
 * that fails loudly and one that cannot express the failure.
 */
export function buildSprintHistory(
  now: Date,
  shape: SprintShape,
  cardIds: readonly string[],
): readonly {
  name: string;
  status: 'completed' | 'active' | 'planned';
  goal: string | null;
  startsOn: Date;
  endsOn: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  attached: readonly string[];
}[] {
  const activeStart = daysBefore(now, ACTIVE_ELAPSED_DAYS);
  const out: {
    name: string;
    status: 'completed' | 'active' | 'planned';
    goal: string | null;
    startsOn: Date;
    endsOn: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    attached: readonly string[];
  }[] = [];

  /* Cards are handed out oldest-sprint-first and never reused: a card belongs
     to at most one sprint (`work.cards.sprint_id` is a single column), so an
     overlapping slice would silently move it to whichever sprint was written
     last. Two per closed sprint, a wider slice for the active one, and
     whatever is left stays in the backlog — which is where most work lives. */
  let taken = 0;
  const take = (count: number): readonly string[] => {
    const slice = cardIds.slice(taken, taken + count);
    taken += slice.length;
    return slice;
  };

  for (let index = 0; index < shape.completed; index += 1) {
    /* Counting back from the active window: the OLDEST closed sprint is
       furthest away, so its offset is the largest. */
    const back = shape.completed - index;
    const startsOn = daysBefore(activeStart, SPRINT_DAYS * back);
    const endsOn = daysBefore(activeStart, SPRINT_DAYS * (back - 1));

    out.push({
      name: `Sprint ${String(index + 1)}`,
      status: 'completed',
      goal: GOALS[index % GOALS.length] ?? null,
      startsOn,
      endsOn,
      startedAt: startsOn,
      /* Closed the day the window ended. A completed sprint whose
         `completed_at` sat outside its own window would be a row the product
         never produces. */
      completedAt: endsOn,
      attached: take(2),
    });
  }

  out.push({
    name: `Sprint ${String(shape.completed + 1)}`,
    status: 'active',
    goal: GOALS[shape.completed % GOALS.length] ?? null,
    startsOn: activeStart,
    endsOn: daysAfter(activeStart, SPRINT_DAYS),
    startedAt: activeStart,
    completedAt: null,
    attached: take(5),
  });

  for (let index = 0; index < shape.planned; index += 1) {
    const startsOn = daysAfter(activeStart, SPRINT_DAYS * (index + 1));

    out.push({
      name: `Sprint ${String(shape.completed + 2 + index)}`,
      status: 'planned',
      /* The nearest future sprint usually has a goal written already; the ones
         after it usually do not, which is what a real backlog looks like. */
      goal: index === 0 ? (GOALS[(shape.completed + 1) % GOALS.length] ?? null) : null,
      startsOn,
      endsOn: daysAfter(startsOn, SPRINT_DAYS),
      startedAt: null,
      completedAt: null,
      /* Only the next one gets pulled-in work, and only a little. */
      attached: index === 0 ? take(2) : [],
    });
  }

  return out;
}
