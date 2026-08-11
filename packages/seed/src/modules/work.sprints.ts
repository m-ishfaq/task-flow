import { createEvent } from '@taskflow/events';
import { sprintCompleted, sprintCreated, sprintStarted } from '@taskflow/api/events/work';
import { defineSeedModule } from '../registry.js';
import { daysAfter, daysBefore, envelopeFor, latest } from '../support.js';
import { projectsModule } from './work.projects.js';
import { cardsModule } from './work.cards.js';

/**
 * Sprints (Phase 10.5) — a project's one-active-window plan.
 *
 * ## The seeded shape is the UI's happy path
 *
 * Every project gets exactly three sprints, one per lifecycle state:
 *
 *   - one COMPLETED (in the past, `completed_at` set), with a couple of cards
 *     still attached — the close transaction's "done cards stay attached"
 *     half, so the board shows what shipped;
 *   - one ACTIVE (now), with live cards assigned — the sprint board a demo
 *     opens already has work in it;
 *   - one PLANNED (ahead) — the window lined up next, empty until the team
 *     pulls cards into it, which is the normal state.
 *
 * The active sprint is a real sprint by the migration's lights: `starts_on` is
 * in the past and `ends_on` in the future, `started_at` is set, and the
 * project has exactly ONE active sprint (the unique index would refuse a
 * second — which is also the property the seed is exercising).
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
      const completed = cardIds.length >= 4 ? cardIds.slice(0, 2) : [];
      const active = cardIds.length >= 8 ? cardIds.slice(2, 7) : cardIds.slice(2);

      // One sprint per lifecycle state. The completed and active windows also
      // carry their lifecycle timestamps, and the active one must be the
      // project's ONLY active sprint — the unique index enforces it, and a
      // seeded second one would make the first demo `pnpm seed` fail.
      const sprints = [
        {
          name: 'Sprint 1',
          status: 'completed' as const,
          goal: 'Finish the first pass of the web app — the board, the card detail and the filters.',
          startsOn: daysBefore(ctx.now, 19),
          endsOn: daysBefore(ctx.now, 12),
          startedAt: daysBefore(ctx.now, 19),
          completedAt: daysBefore(ctx.now, 12),
          attached: completed,
        },
        {
          name: 'Sprint 2',
          status: 'active' as const,
          goal: 'Close the remaining design-review items and ship the export polish.',
          startsOn: daysBefore(ctx.now, 4),
          endsOn: daysAfter(ctx.now, 3),
          startedAt: daysBefore(ctx.now, 4),
          completedAt: null,
          attached: active,
        },
        {
          name: 'Sprint 3',
          status: 'planned' as const,
          goal: null,
          startsOn: daysAfter(ctx.now, 4),
          endsOn: daysAfter(ctx.now, 17),
          startedAt: null,
          completedAt: null,
          attached: [],
        },
      ];

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
