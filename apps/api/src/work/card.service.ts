import {
  and,
  asc,
  compiledPredicate,
  eq,
  increment,
  isNull,
  ne,
  schema,
  withOrgScope,
  outboxWriter,
  type SQL,
} from '@taskflow/db';
import {
  InvalidRankError,
  between,
  errors,
  type CardId,
  type ListId,
  type Priority,
  type StatusId,
  type UserId,
} from '@taskflow/contracts';
import { createEvent, type DomainEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import {
  cardArchived,
  cardAssigned,
  cardCreated,
  cardMoved,
  cardStatusChanged,
  cardUpdated,
  listRebalanced,
} from './events.js';
import { compile, type FilterNode } from '@taskflow/filter';
import { loadList } from './list.service.js';
import { rebalanceList } from './rebalance.js';
import { flattenToText, type RichTextNode } from './richtext.js';
import {
  ancestorsOfCard,
  enforceOn,
  envelopeOf,
  orgOf,
  translatingConstraints,
  type WorkActor,
} from './shared.js';

/**
 * Cards (PLAN.md §3.1, §7.2, §10.1).
 *
 * Three mechanisms in this file are worth understanding before changing it.
 *
 * ## 1. `move` takes neighbours, never a rank
 *
 * §10.1 is explicit: `cards.move({ cardId, targetListId, beforeCardId?,
 * afterCardId? })`, and the SERVER derives the rank. A client that computed one
 * would be computing it from a board it read some time ago, so two people
 * dragging at once would each place a card according to a different past. Taking
 * neighbours means both writes are interpreted against the same present, and the
 * two converge.
 *
 * ## 2. Rebalance is triggered by the move that discovers the problem
 *
 * Ranks lengthen under repeated insertion at one point, and equal ranks are a
 * legal outcome of concurrency. Either can make `between` unable to produce a
 * value. Rather than a scheduled job racing the user, the move that hits the
 * degenerate case repairs the list inside its own transaction and then proceeds
 * — so the pathology is bounded by the operation that caused it.
 *
 * ## 3. Every update is optimistic-concurrency checked
 *
 * `version` is read by the client and returned with the write. A mismatch is a
 * CONFLICT the second editor is told about, not a silent overwrite of the first
 * editor's sentence.
 */

export interface CardSummary {
  readonly cardId: string;
  readonly listId: string;
  readonly boardId: string;
  readonly reference: string;
  readonly title: string;
  readonly rank: string;
  readonly assigneeIds: readonly string[];
  readonly statusId: string | null;
  readonly priority: Priority | null;
  readonly dueDate: Date | null;
  readonly commentCount: number;
  readonly checklistDone: number;
  readonly checklistTotal: number;
  readonly version: number;
  readonly archivedAt: Date | null;
}

/** `WEB-142` — the human-facing identity of a card. */
function referenceOf(key: string, number: number): string {
  return `${key}-${String(number)}`;
}

/**
 * Every live card on a board, in render order.
 *
 * One query for the whole board rather than one per list: a board with twelve
 * columns would otherwise be twelve round-trips, and the client groups by
 * `listId` anyway.
 */
export async function listCards(
  actor: WorkActor,
  input: {
    readonly boardId: string;
    readonly filter?: FilterNode | null;
    readonly includeArchived?: boolean;
  },
): Promise<readonly CardSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const boards = await tx
      .select({
        orgId: schema.boards.orgId,
        projectId: schema.boards.projectId,
      })
      .from(schema.boards)
      .where(and(eq(schema.boards.id, input.boardId), isNull(schema.boards.deletedAt)))
      .limit(1);

    const board = boards[0];
    if (!board) throw errors.notFound();

    enforceOn(actor, 'card:read', { type: 'board', id: input.boardId }, board, [
      { type: 'project', id: board.projectId },
    ]);

    const rows = await tx
      .select({
        cardId: schema.cards.id,
        listId: schema.cards.listId,
        boardId: schema.cards.boardId,
        number: schema.cards.number,
        projectKey: schema.projects.key,
        title: schema.cards.title,
        rank: schema.cards.rank,
        assigneeIds: schema.cards.assigneeIds,
        statusId: schema.cards.statusId,
        priority: schema.cards.priority,
        dueDate: schema.cards.dueDate,
        commentCount: schema.cards.commentCount,
        checklistDone: schema.cards.checklistDone,
        checklistTotal: schema.cards.checklistTotal,
        version: schema.cards.version,
        archivedAt: schema.cards.archivedAt,
      })
      .from(schema.cards)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.cards.projectId))
      .where(
        and(
          eq(schema.cards.boardId, input.boardId),
          isNull(schema.cards.deletedAt),
          /* Hardcoded rather than left to the `archived` filter field: the
             board render must never depend on the caller having remembered to
             ADD `archived = false` to its filter tree. `includeArchived` is a
             separate, explicit switch for the one caller (the restore view)
             that wants the opposite — it REPLACES this condition rather than
             composing with it, so a stray `archived = true` in a saved filter
             still cannot smuggle archived cards onto the board. */
          input.includeArchived === true ? undefined : isNull(schema.cards.archivedAt),
          /* The filter AST (§10.2), compiled to a parameterized predicate.
             `compile` re-validates against the field whitelist and throws
             rather than emitting anything it does not recognize, so an
             unknown field is an error here and never SQL. */
          filterPredicate(input.filter ?? null, actor),
        ),
      )
      // The (rank, id) total order from §10.1, served by cards_list_rank_idx.
      .orderBy(asc(schema.cards.listId), asc(schema.cards.rank), asc(schema.cards.id));

    return rows.map(({ number, projectKey, ...row }) => ({
      ...row,
      // The column is text; the CHECK constraint is what actually limits it
      // to the four values `Priority` names. Same narrowing as
      // `StatusCategory` in status.service.ts.
      priority: row.priority as Priority | null,
      reference: referenceOf(projectKey, number),
    }));
  });
}

export interface CardDetail extends CardSummary {
  readonly description: unknown;
  readonly startDate: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export async function getCard(
  actor: WorkActor,
  input: { readonly cardId: CardId },
): Promise<CardDetail> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        cardId: schema.cards.id,
        orgId: schema.cards.orgId,
        listId: schema.cards.listId,
        boardId: schema.cards.boardId,
        projectId: schema.cards.projectId,
        number: schema.cards.number,
        projectKey: schema.projects.key,
        title: schema.cards.title,
        description: schema.cards.description,
        rank: schema.cards.rank,
        assigneeIds: schema.cards.assigneeIds,
        statusId: schema.cards.statusId,
        priority: schema.cards.priority,
        dueDate: schema.cards.dueDate,
        startDate: schema.cards.startDate,
        commentCount: schema.cards.commentCount,
        checklistDone: schema.cards.checklistDone,
        checklistTotal: schema.cards.checklistTotal,
        version: schema.cards.version,
        archivedAt: schema.cards.archivedAt,
        createdAt: schema.cards.createdAt,
        updatedAt: schema.cards.updatedAt,
      })
      .from(schema.cards)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.cards.projectId))
      .where(and(eq(schema.cards.id, input.cardId), isNull(schema.cards.deletedAt)))
      .limit(1);

    const card = rows[0];
    if (!card) throw errors.notFound();

    enforceOn(actor, 'card:read', { type: 'card', id: input.cardId }, card, ancestorsOfCard(card));

    const { number, projectKey, orgId: _orgId, projectId: _projectId, ...rest } = card;
    return {
      ...rest,
      priority: rest.priority as Priority | null,
      reference: referenceOf(projectKey, number),
    };
  });
}

export async function createCard(
  actor: WorkActor,
  input: {
    readonly listId: ListId;
    readonly title: string;
    readonly description: RichTextNode | null;
  },
): Promise<{ readonly cardId: CardId; readonly reference: string }> {
  const cardId = newId<'CardId'>();
  const orgId = orgOf(actor);

  return translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        const list = await loadList(tx, input.listId);

        /* The BOARD is the resource, not the list. A list is not independently
           grantable — see `ancestorsOfBoard` — so naming one here would ask the
           engine about a resource type no tuple can ever point at, and the
           answer would silently come from the role alone. */
        enforceOn(actor, 'card:create', { type: 'board', id: list.boardId }, list, [
          { type: 'project', id: list.projectId },
        ]);

        /* The card number, taken under a row lock on the project. `WEB-142` has
           to be gapless and per-project, which a sequence gives up on rollback,
           so this is an UPDATE ... RETURNING inside the card's own transaction.
           It serializes card creation within one project — see migration 0008
           note 3 on why that is accepted. */
        const counters = await tx
          .update(schema.projects)
          .set({ nextCardNumber: increment(schema.projects.nextCardNumber) })
          .where(eq(schema.projects.id, list.projectId))
          .returning({ number: schema.projects.nextCardNumber, key: schema.projects.key });

        const counter = counters[0];
        if (!counter) throw errors.notFound();

        // RETURNING gives the value AFTER the increment, so this card's number
        // is one less. Reading it as the new value would skip 1 and hand out
        // every number one higher than the one the user was shown.
        const number = counter.number - 1;

        const siblings = await tx
          .select({ rank: schema.cards.rank })
          .from(schema.cards)
          .where(and(eq(schema.cards.listId, input.listId), isNull(schema.cards.deletedAt)))
          .orderBy(asc(schema.cards.rank), asc(schema.cards.id));

        /* The project's default status, if it has one. Best-effort: a project
           with no statuses yet (nothing has backfilled it, and nobody has
           created one) leaves the card unclassified rather than failing the
           whole creation over a vocabulary that has not been set up. */
        const defaultStatus = await tx
          .select({ statusId: schema.statuses.id })
          .from(schema.statuses)
          .where(
            and(eq(schema.statuses.projectId, list.projectId), eq(schema.statuses.isDefault, true)),
          )
          .limit(1);

        await tx.insert(schema.cards).values({
          id: cardId,
          orgId,
          // Every ancestor from the LIST row, so the composite foreign key has
          // nothing to reject and the caller cannot name a board that does not
          // contain the list they chose.
          projectId: list.projectId,
          boardId: list.boardId,
          listId: input.listId,
          number,
          title: input.title,
          description: input.description,
          descriptionText: input.description === null ? null : flattenToText(input.description),
          rank: between(siblings.at(-1)?.rank ?? null, null),
          statusId: defaultStatus[0]?.statusId ?? null,
          createdBy: actor.subject.userId,
        });

        const reference = referenceOf(counter.key, number);

        await outboxWriter.append(tx, [
          createEvent(
            cardCreated,
            {
              cardId,
              boardId: list.boardId,
              listId: input.listId,
              projectId: list.projectId,
              reference,
              title: input.title,
            },
            envelopeOf(actor),
          ),
        ]);

        return { cardId, reference };
      }),
    () => errors.conflict('That card already exists.'),
  );
}

export async function updateCard(
  actor: WorkActor,
  input: {
    readonly cardId: CardId;
    readonly version: number;
    readonly title: string;
    readonly description: RichTextNode | null;
    readonly dueDate: Date | null;
    readonly startDate: Date | null;
    /** Rides this route rather than getting its own, per `card.updated` — see
        `setCardStatus` for why status did not join it. */
    readonly priority: Priority | null;
  },
): Promise<{ readonly version: number }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);

    enforceOn(
      actor,
      'card:update',
      { type: 'card', id: input.cardId },
      card,
      ancestorsOfCard(card),
    );

    const changed: string[] = [];
    if (card.title !== input.title) changed.push('title');
    if (!sameInstant(card.dueDate, input.dueDate)) changed.push('dueDate');
    if (!sameInstant(card.startDate, input.startDate)) changed.push('startDate');
    if (card.priority !== input.priority) changed.push('priority');
    if (JSON.stringify(card.description) !== JSON.stringify(input.description)) {
      changed.push('description');
    }

    const nextVersion = card.version + 1;

    /* Optimistic concurrency (§7.1). The version is part of the WHERE, so the
       check and the write are one statement — a SELECT-then-UPDATE would leave
       a window where both editors read version 4 and both wrote version 5. */
    const updated = await tx
      .update(schema.cards)
      .set({
        title: input.title,
        description: input.description,
        descriptionText: input.description === null ? null : flattenToText(input.description),
        dueDate: input.dueDate,
        startDate: input.startDate,
        priority: input.priority,
        version: nextVersion,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.cards.id, input.cardId), eq(schema.cards.version, input.version)))
      .returning({ id: schema.cards.id });

    if (!updated[0]) {
      throw errors.conflict('This card was changed by someone else. Reload and try again.');
    }

    await outboxWriter.append(tx, [
      createEvent(
        cardUpdated,
        {
          cardId: input.cardId,
          boardId: card.boardId,
          changed,
          before: {
            title: card.title,
            dueDate: card.dueDate?.toISOString() ?? null,
            startDate: card.startDate?.toISOString() ?? null,
            priority: card.priority,
          },
          after: {
            title: input.title,
            dueDate: input.dueDate?.toISOString() ?? null,
            startDate: input.startDate?.toISOString() ?? null,
            priority: input.priority,
          },
        },
        envelopeOf(actor),
      ),
    ]);

    return { version: nextVersion };
  });
}

/**
 * Sets a card's status — the field a "group by status" board drags between
 * columns, per §3.2 of the plan.
 *
 * A dedicated mutation rather than folding into `updateCard`, unlike
 * priority. Two reasons: it emits `card.status_changed`, a FIRST-CLASS event
 * Phase 10 automation fires on specifically (see `events.ts`) — folding it
 * into `card.updated` would make every consumer diff `before`/`after` to
 * notice a status transition, which is exactly the mistake `card.moved`
 * already avoided for list moves. And unlike `updateCard`, this is not a full
 * replace: a board dragging a card between status columns has never read the
 * card's description or dates, and should not need to before it can move it.
 *
 * No explicit membership check on `statusId` beyond what the database already
 * enforces: `cards_status_fk` is a COMPOSITE foreign key on (org_id,
 * project_id, status_id), so a status from another project is refused by the
 * database exactly as a label from another project is (`setCardLabels`) —
 * translated to a 404 by `translatingConstraints` rather than a lookup this
 * code would otherwise have to remember to do.
 */
export async function setCardStatus(
  actor: WorkActor,
  input: { readonly cardId: CardId; readonly statusId: StatusId | null },
): Promise<{ readonly statusId: string | null }> {
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

        if (card.statusId === input.statusId) {
          // No-op save: keeps a card detail panel that fires on blur out of
          // the audit log for a click that changed nothing.
          return { statusId: card.statusId };
        }

        await tx
          .update(schema.cards)
          .set({ statusId: input.statusId, updatedAt: new Date() })
          .where(eq(schema.cards.id, input.cardId));

        await outboxWriter.append(tx, [
          createEvent(
            cardStatusChanged,
            {
              cardId: input.cardId,
              boardId: card.boardId,
              before: card.statusId,
              after: input.statusId,
            },
            envelopeOf(actor),
          ),
        ]);

        return { statusId: input.statusId };
      }),
    () => errors.notFound(),
  );
}

/** Two nullable timestamps denote the same instant. */
function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

export interface MoveResult {
  readonly rank: string;
  readonly listId: string;
  /** True when the destination is now over its WIP limit. Advisory — see below. */
  readonly wipExceeded: boolean;
  readonly rebalanced: boolean;
}

/**
 * Moves a card to a position in a list, identified by its NEIGHBOURS (§10.1).
 *
 * Works for a reorder within one list and a move between two: they are the same
 * user gesture and the same write, and the event carries both endpoints so a
 * consumer that cares about the difference can see it.
 */
export async function moveCard(
  actor: WorkActor,
  input: {
    readonly cardId: CardId;
    readonly targetListId: ListId;
    readonly beforeCardId: CardId | null;
    readonly afterCardId: CardId | null;
  },
): Promise<MoveResult> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);

    enforceOn(actor, 'card:move', { type: 'card', id: input.cardId }, card, ancestorsOfCard(card));

    const target = await loadList(tx, input.targetListId);

    /* The DESTINATION is authorized separately. Without this, holding
       `card:move` on a board you can reach would let you move its cards onto a
       board you cannot — the composite foreign key stops a cross-BOARD write
       only when the ancestry disagrees, and moving between two boards of the
       same project is a legitimate shape. */
    enforceOn(actor, 'card:move', { type: 'board', id: target.boardId }, target, [
      { type: 'project', id: target.projectId },
    ]);

    /* Cross-PROJECT moves are refused here rather than attempted and left to
       fail in the database.

       The UPDATE below writes the destination's `project_id` onto the card, and
       three composite foreign keys are defined against it: `(org_id,
       project_id, status_id)` on cards itself (migration 0011), and
       `(org_id, project_id, card_id)` from both `card_labels` and
       `custom_field_values` (0009). A card carrying a status — which every card
       does since the 0012 backfill — therefore violates its own FK the moment
       its project changes, and the caller sees an unhandled driver error as a
       500 rather than a refusal.

       Refusing is also the honest answer, not merely the safe one: a card
       moved between projects would keep a number minted from the old project's
       counter, and its labels and custom field values are vocabulary the
       destination does not have. Making that work is a migration and a
       remapping decision (what becomes of a label the target project lacks?),
       not a relaxed check. Boards WITHIN a project stay legitimate and are the
       case the destination-authorization above exists for. */
    if (target.projectId !== card.projectId) {
      throw errors.validation(
        { targetListId: 'That list belongs to a different project.' },
        'A card cannot be moved to another project.',
      );
    }

    let rebalancedCount: number | null = null;
    let rank: string;

    const siblings = await loadSiblings(tx, input.targetListId, input.cardId);

    try {
      rank = between(
        rankOfNeighbour(siblings, input.beforeCardId),
        rankOfNeighbour(siblings, input.afterCardId),
      );
    } catch (error) {
      /* Two failures reach here and only one is repairable. `InvalidRankError`
         means the neighbours are equal or degenerate — the legal outcome of two
         clients inserting at the same point (§10.1) — and rebalancing fixes it.
         A NOT_FOUND from `rankOfNeighbour` means the client named a card that is
         not in this list, and rebalancing would not change that: rethrowing
         keeps a stale drag a 404 instead of an unexplained rewrite of the whole
         column. */
      if (!(error instanceof InvalidRankError)) throw error;

      // Repaired inside this transaction rather than left to a job that would
      // race the next drag.
      rebalancedCount = await rebalanceList(tx, input.targetListId);

      const repaired = await loadSiblings(tx, input.targetListId, input.cardId);
      rank = between(
        rankOfNeighbour(repaired, input.beforeCardId),
        rankOfNeighbour(repaired, input.afterCardId),
      );
    }

    await tx
      .update(schema.cards)
      .set({
        listId: input.targetListId,
        boardId: target.boardId,
        projectId: target.projectId,
        rank,
        updatedAt: new Date(),
      })
      .where(eq(schema.cards.id, input.cardId));

    /* WIP limits are ADVISORY. Refusing the move would block someone recording
       what has already happened — the work is in progress whether or not the
       board agrees — and the reliable result of that is people stopping using
       the board rather than stopping the work. The breach is reported so the UI
       can show it. */
    const occupants = siblings.length + 1;
    const wipExceeded = target.wipLimit !== null && occupants > target.wipLimit;

    /* Typed as the general envelope rather than inferred from the first
       element, so the conditional push below is not a type error. Both are
       already validated against their own schemas by `createEvent`. */
    const events: DomainEvent[] = [
      createEvent(
        cardMoved,
        {
          cardId: input.cardId,
          boardId: target.boardId,
          fromListId: card.listId,
          toListId: input.targetListId,
          fromRank: card.rank,
          toRank: rank,
        },
        envelopeOf(actor),
      ),
    ];

    if (rebalancedCount !== null) {
      /* Everyone holding this board has stale ranks for the whole column, so
         they must refetch rather than patch. Without this event the repair
         would silently desynchronize every open board. */
      events.push(
        createEvent(
          listRebalanced,
          {
            listId: input.targetListId,
            boardId: target.boardId,
            cardCount: rebalancedCount,
          },
          envelopeOf(actor),
        ),
      );
    }

    await outboxWriter.append(tx, events);

    return {
      rank,
      listId: input.targetListId,
      wipExceeded,
      rebalanced: rebalancedCount !== null,
    };
  });
}

interface Sibling {
  readonly cardId: string;
  readonly rank: string;
}

/** Every other live card in a list, in order. */
async function loadSiblings(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  listId: ListId,
  excluding: CardId,
): Promise<readonly Sibling[]> {
  return tx
    .select({ cardId: schema.cards.id, rank: schema.cards.rank })
    .from(schema.cards)
    .where(
      and(
        eq(schema.cards.listId, listId),
        ne(schema.cards.id, excluding),
        isNull(schema.cards.deletedAt),
        isNull(schema.cards.archivedAt),
      ),
    )
    .orderBy(asc(schema.cards.rank), asc(schema.cards.id));
}

/**
 * The rank of a named neighbour.
 *
 * A neighbour that is not in the target list is a stale client — the card was
 * moved or archived between the board being rendered and the drag finishing.
 * 404 rather than a guess: placing the card "somewhere near where they meant"
 * is how a drag silently lands in the wrong column.
 */
function rankOfNeighbour(siblings: readonly Sibling[], cardId: CardId | null): string | null {
  if (cardId === null) return null;

  const sibling = siblings.find((row) => row.cardId === cardId);
  if (!sibling) throw errors.notFound();
  return sibling.rank;
}

/**
 * Replaces a card's assignees.
 *
 * Takes the whole set rather than add/remove operations. Two people editing
 * assignees concurrently with deltas produce a set neither of them chose;
 * taking the set means the last write is at least a set someone selected.
 */
export async function assignCard(
  actor: WorkActor,
  input: { readonly cardId: CardId; readonly assigneeIds: readonly UserId[] },
): Promise<{ readonly assigneeIds: readonly string[] }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);

    enforceOn(
      actor,
      'card:update',
      { type: 'card', id: input.cardId },
      card,
      ancestorsOfCard(card),
    );

    /* Every assignee must be a member of THIS org. Without the check, a card
       could name a user id from another tenant — which leaks nothing by itself,
       but puts a foreign id into notification fanout and into every "my cards"
       query that follows. RLS makes the read return only this org's members, so
       a foreign id simply fails to appear. */
    const members = await tx
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(eq(schema.memberships.status, 'active'));

    const memberIds = new Set(members.map((row) => row.userId));
    const unknown = input.assigneeIds.filter((id) => !memberIds.has(id));
    if (unknown.length > 0) {
      throw errors.validation({ assigneeIds: 'Not a member of this organization.' });
    }

    const assigneeIds = [...new Set(input.assigneeIds)];

    await tx
      .update(schema.cards)
      .set({ assigneeIds, updatedAt: new Date() })
      .where(eq(schema.cards.id, input.cardId));

    await outboxWriter.append(tx, [
      createEvent(
        cardAssigned,
        {
          cardId: input.cardId,
          boardId: card.boardId,
          before: card.assigneeIds,
          after: assigneeIds,
        },
        envelopeOf(actor),
      ),
    ]);

    return { assigneeIds };
  });
}

export async function archiveCard(
  actor: WorkActor,
  input: { readonly cardId: CardId; readonly archived: boolean },
): Promise<{ readonly archived: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);

    enforceOn(
      actor,
      'card:delete',
      { type: 'card', id: input.cardId },
      card,
      ancestorsOfCard(card),
    );

    const projects = await tx
      .select({ key: schema.projects.key })
      .from(schema.projects)
      .where(eq(schema.projects.id, card.projectId))
      .limit(1);

    const project = projects[0];
    if (!project) throw errors.notFound();

    await tx
      .update(schema.cards)
      .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.cards.id, input.cardId));

    await outboxWriter.append(tx, [
      createEvent(
        cardArchived,
        {
          cardId: input.cardId,
          boardId: card.boardId,
          listId: card.listId,
          reference: referenceOf(project.key, card.number),
          restored: !input.archived,
        },
        envelopeOf(actor),
      ),
    ]);

    return { archived: input.archived };
  });
}

/**
 * Compiles a filter tree into a predicate, or undefined when there is none.
 *
 * The viewer is supplied HERE rather than by the client, which is the whole
 * point of `@me` staying symbolic until this moment: a saved filter shared
 * between two people means "assigned to me" for each of them, not "assigned to
 * whoever saved it".
 *
 * `compile` re-validates against the field whitelist and throws rather than
 * emitting anything it does not recognize — so an unknown field is an exception
 * here and never reaches the database as SQL.
 */
function filterPredicate(filter: FilterNode | null, actor: WorkActor): SQL | undefined {
  if (filter === null) return undefined;

  const compiled = compile('card', filter, { viewerId: actor.subject.userId });
  return compiledPredicate(compiled.sql, compiled.params);
}

export interface CardRow {
  readonly orgId: string;
  readonly projectId: string;
  readonly boardId: string;
  readonly listId: string;
  readonly number: number;
  readonly title: string;
  readonly description: unknown;
  readonly rank: string;
  readonly assigneeIds: readonly string[];
  readonly statusId: string | null;
  readonly priority: Priority | null;
  readonly dueDate: Date | null;
  readonly startDate: Date | null;
  readonly version: number;
}

/** Loads a card by id, or 404s. Every caller enforces immediately afterwards. */
export async function loadCard(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  cardId: CardId,
): Promise<CardRow> {
  const rows = await tx
    .select({
      orgId: schema.cards.orgId,
      projectId: schema.cards.projectId,
      boardId: schema.cards.boardId,
      listId: schema.cards.listId,
      number: schema.cards.number,
      title: schema.cards.title,
      description: schema.cards.description,
      rank: schema.cards.rank,
      assigneeIds: schema.cards.assigneeIds,
      statusId: schema.cards.statusId,
      priority: schema.cards.priority,
      dueDate: schema.cards.dueDate,
      startDate: schema.cards.startDate,
      version: schema.cards.version,
    })
    .from(schema.cards)
    .where(and(eq(schema.cards.id, cardId), isNull(schema.cards.deletedAt)))
    .limit(1);

  const card = rows[0];
  if (!card) throw errors.notFound();
  return { ...card, priority: card.priority as Priority | null };
}
