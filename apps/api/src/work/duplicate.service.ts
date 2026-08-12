import { and, eq, inArray, isNull, outboxWriter, schema, withOrgScope } from '@taskflow/db';
import { errors, type ProjectId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { requireProject } from './project.service.js';
import { projectCreated } from './events.js';
import { envelopeOf, orgOf, translatingConstraints, type WorkActor } from './shared.js';

/**
 * Duplicating a project (the answer to "export it and import it with a new
 * name" that CSV cannot be).
 *
 * ## Why this is not import/export
 *
 * A CSV round trip carries what fits in a cell. It cannot carry rank ordering,
 * checklists, custom field VALUES, or the identity of a status beyond its name
 * — so "export a project and import it as a new one" through files silently
 * loses most of the structure and quietly renames the rest. This copies rows,
 * so the new project is the old one's shape exactly.
 *
 * ## What is copied, and what is deliberately not
 *
 * Structure always: statuses, labels, custom field DEFINITIONS, boards, lists.
 * That is the reusable part — the vocabulary and the columns — and it is what
 * makes a duplicated project a template.
 *
 * Cards only when asked (`includeCards`), and with them their labels, custom
 * field values, and checklists. A project duplicated for its shape and one
 * duplicated to fork its work are different intentions, and guessing wrong in
 * either direction is worse than asking.
 *
 * NOT copied, each for its own reason:
 *
 * - **Comments.** A discussion is a record of a conversation that happened.
 *   Copying it would attribute words to people in a project they have never
 *   seen, and back-date them.
 * - **Attachments.** The rows are cheap; the objects behind them are not.
 *   Duplicating blobs in storage is a different feature with its own quota and
 *   virus-scan story (§8.4), and a copied ROW pointing at the original's object
 *   would let deleting one project break another's downloads.
 * - **Sprints.** Their dates are the old project's calendar. A fork starts
 *   planning fresh; carrying `2026-08-10 -> 2026-08-21` into a project created
 *   in December is worse than carrying nothing.
 * - **Saved views.** A view stores a filter AST that can name label and status
 *   IDS. Remapping ids inside a stored tree is real work with a silent failure
 *   mode — a view that still parses but points at the wrong label — and it
 *   belongs in its own slice rather than smuggled into this one.
 * - **Card numbers.** The new project owns its own gapless namespace, so cards
 *   are renumbered from 1. `WEB-142` naming a card in two projects would make
 *   the reference ambiguous, which is the one thing a card number must not be.
 *
 * ## One operation, one event
 *
 * The copy writes many rows and emits a single `project.created` — the
 * `rebalance.ts` precedent for guardrail 11: the event belongs to the operation
 * the PERSON performed, not to each row a bulk write touched. Emitting a
 * `card.created` per card would flood the outbox, fire automation rules for
 * work that is a copy rather than new, and index a whole project one row at a
 * time.
 *
 * It is also why this is not `createCard` in a loop. That path takes a row lock
 * on the source project's counter per card, emits per-card events, and would
 * turn a 500-card duplicate into 500 transactions.
 */

export interface DuplicateResult {
  readonly projectId: ProjectId;
  readonly key: string;
  readonly boards: number;
  readonly lists: number;
  readonly cards: number;
}

export async function duplicateProject(
  actor: WorkActor,
  input: {
    readonly sourceProjectId: ProjectId;
    readonly name: string;
    readonly key: string;
    /** Copy the cards too, or just the project's shape. */
    readonly includeCards: boolean;
  },
): Promise<DuplicateResult> {
  const orgId = orgOf(actor);
  const projectId = newId<'ProjectId'>();

  return translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        /* Reading the source is `project:read`; the route floors the CREATE
           half on `project:create`. Both are needed and neither implies the
           other — a member who may read a project is not thereby allowed to
           mint a new one, and vice versa. */
        await requireProject(tx, actor, input.sourceProjectId, 'project:read');

        /* `requireProject` answers the authorization question and returns only
           what it needs for it. The description is a field of the copy, so it
           is read here rather than by widening that helper's contract for one
           caller. */
        const sourceRows = await tx
          .select({ description: schema.projects.description })
          .from(schema.projects)
          .where(eq(schema.projects.id, input.sourceProjectId))
          .limit(1);

        await tx.insert(schema.projects).values({
          id: projectId,
          orgId,
          name: input.name,
          key: input.key,
          description: sourceRows[0]?.description ?? null,
          createdBy: actor.subject.userId,
        });

        /* ---- vocabulary ------------------------------------------------- *
           Copied first, because boards, lists and cards all reference it.
           Every map below is old id -> new id; a child that cannot find its
           parent in one of these is a bug, not a case to tolerate, so the
           lookups below throw rather than defaulting. */
        const statusRows = await tx
          .select()
          .from(schema.statuses)
          .where(eq(schema.statuses.projectId, input.sourceProjectId));

        const statusMap = new Map<string, string>();
        for (const row of statusRows) {
          const id = newId<'StatusId'>();
          statusMap.set(row.id, id);
          await tx.insert(schema.statuses).values({ ...row, id, projectId, createdAt: undefined });
        }

        const labelRows = await tx
          .select()
          .from(schema.labels)
          .where(eq(schema.labels.projectId, input.sourceProjectId));

        const labelMap = new Map<string, string>();
        for (const row of labelRows) {
          const id = newId<'LabelId'>();
          labelMap.set(row.id, id);
          await tx.insert(schema.labels).values({ ...row, id, projectId, createdAt: undefined });
        }

        const fieldRows = await tx
          .select()
          .from(schema.customFieldDefs)
          .where(eq(schema.customFieldDefs.projectId, input.sourceProjectId));

        const fieldMap = new Map<string, string>();
        for (const row of fieldRows) {
          const id = newId<'CustomFieldDefId'>();
          fieldMap.set(row.id, id);
          await tx
            .insert(schema.customFieldDefs)
            .values({ ...row, id, projectId, createdAt: undefined });
        }

        /* ---- boards and lists ------------------------------------------- */
        const boardRows = await tx
          .select()
          .from(schema.boards)
          .where(
            and(
              eq(schema.boards.projectId, input.sourceProjectId),
              isNull(schema.boards.deletedAt),
            ),
          );

        const boardMap = new Map<string, string>();
        for (const row of boardRows) {
          const id = newId<'BoardId'>();
          boardMap.set(row.id, id);
          await tx.insert(schema.boards).values({
            ...row,
            id,
            projectId,
            createdAt: undefined,
            updatedAt: undefined,
          });
        }

        const listRows = await tx
          .select()
          .from(schema.lists)
          .where(
            and(eq(schema.lists.projectId, input.sourceProjectId), isNull(schema.lists.deletedAt)),
          );

        const listMap = new Map<string, string>();
        for (const row of listRows) {
          const id = newId<'ListId'>();
          const boardId = boardMap.get(row.boardId);
          /* A list whose board was not copied cannot be placed. Both queries
             filter `deletedAt IS NULL`, so this is unreachable — and it stays
             a throw rather than a skip, because silently dropping a column is
             exactly the kind of loss this whole service exists to avoid. */
          if (boardId === undefined) throw errors.conflict('A list outlived its board.');
          listMap.set(row.id, id);
          await tx.insert(schema.lists).values({
            ...row,
            id,
            projectId,
            boardId,
            createdAt: undefined,
            updatedAt: undefined,
          });
        }

        let cardCount = 0;

        if (input.includeCards) {
          const cardRows = await tx
            .select()
            .from(schema.cards)
            .where(
              and(
                eq(schema.cards.projectId, input.sourceProjectId),
                isNull(schema.cards.deletedAt),
                /* Archived work is not part of a fork's shape, matching what
                   the export writes and what the board shows. */
                isNull(schema.cards.archivedAt),
              ),
            )
            .orderBy(schema.cards.rank, schema.cards.id);

          const cardMap = new Map<string, string>();
          let number = 0;

          for (const row of cardRows) {
            const listId = listMap.get(row.listId);
            const boardId = boardMap.get(row.boardId);
            if (listId === undefined || boardId === undefined) {
              throw errors.conflict('A card outlived its list.');
            }

            const id = newId<'CardId'>();
            cardMap.set(row.id, id);
            number += 1;

            await tx.insert(schema.cards).values({
              ...row,
              id,
              projectId,
              boardId,
              listId,
              /* Renumbered from 1 in the new namespace — see the header. */
              number,
              /* A sprint belongs to the source project and is not copied, so
                 every card starts in the new project's backlog. */
              sprintId: null,
              statusId: row.statusId === null ? null : (statusMap.get(row.statusId) ?? null),
              createdBy: actor.subject.userId,
              createdAt: undefined,
              updatedAt: undefined,
            });
          }

          cardCount = cardRows.length;

          /* The counter must continue the namespace, or the next card created
             by hand collides with a copied one. `createCard` reads this with
             `UPDATE ... RETURNING` and treats the returned value as one PAST
             the number it assigns, so it holds "next + 1" — see its own note
             on the off-by-one. */
          await tx
            .update(schema.projects)
            .set({ nextCardNumber: number + 1 })
            .where(eq(schema.projects.id, projectId));

          if (cardMap.size > 0) {
            const sourceCardIds = [...cardMap.keys()];

            const cardLabelRows = await tx
              .select()
              .from(schema.cardLabels)
              .where(inArray(schema.cardLabels.cardId, sourceCardIds));

            for (const row of cardLabelRows) {
              const cardId = cardMap.get(row.cardId);
              const labelId = labelMap.get(row.labelId);
              if (cardId === undefined || labelId === undefined) continue;
              await tx
                .insert(schema.cardLabels)
                .values({ ...row, cardId, labelId, projectId, addedAt: undefined });
            }

            const valueRows = await tx
              .select()
              .from(schema.customFieldValues)
              .where(inArray(schema.customFieldValues.cardId, sourceCardIds));

            for (const row of valueRows) {
              const cardId = cardMap.get(row.cardId);
              const fieldId = fieldMap.get(row.fieldId);
              if (cardId === undefined || fieldId === undefined) continue;
              await tx
                .insert(schema.customFieldValues)
                .values({ ...row, cardId, fieldId, projectId, updatedAt: undefined });
            }

            const checklistRows = await tx
              .select()
              .from(schema.checklists)
              .where(inArray(schema.checklists.cardId, sourceCardIds));

            const checklistMap = new Map<string, string>();
            for (const row of checklistRows) {
              const cardId = cardMap.get(row.cardId);
              if (cardId === undefined) continue;
              const id = newId<'ChecklistId'>();
              checklistMap.set(row.id, id);
              await tx
                .insert(schema.checklists)
                .values({ ...row, id, cardId, createdAt: undefined });
            }

            if (checklistMap.size > 0) {
              const itemRows = await tx
                .select()
                .from(schema.checklistItems)
                .where(inArray(schema.checklistItems.checklistId, [...checklistMap.keys()]));

              for (const row of itemRows) {
                const checklistId = checklistMap.get(row.checklistId);
                if (checklistId === undefined) continue;
                await tx.insert(schema.checklistItems).values({
                  ...row,
                  id: newId<'ChecklistItemId'>(),
                  checklistId,
                  createdAt: undefined,
                  updatedAt: undefined,
                });
              }
            }
          }
        }

        /* ONE event for the operation the person performed — see the header. */
        await outboxWriter.append(tx, [
          createEvent(
            projectCreated,
            { projectId, name: input.name, key: input.key },
            envelopeOf(actor),
          ),
        ]);

        return {
          projectId,
          key: input.key,
          boards: boardMap.size,
          lists: listMap.size,
          cards: cardCount,
        };
      }),
    () => errors.conflict('That project key is already taken.'),
  );
}
