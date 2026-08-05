import { rankSequence, type Priority } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { cardAssigned, cardCreated, cardLabeled, commentCreated } from '@taskflow/api/events/work';
import {
  cardTitle,
  checklistItemText,
  checklistName,
  commentDocument,
  descriptionDocument,
  flatten,
} from '../corpus.js';
import type { Rng } from '../rng.js';
import type { CardMix } from '../profiles.js';
import type { SeedContext } from '../context.js';
import { defineSeedModule } from '../registry.js';
import { daysAfter, daysBefore, envelopeFor, latest, minutesAfter } from '../support.js';
import { boardsModule, type SeededBoard, type SeededList } from './work.boards.js';
import type { SeededCustomFieldDef, SeededProject } from './work.projects.js';
import type { SeededOrg } from './tenancy.orgs.js';

/**
 * Cards, and everything that hangs off one — labels, checklists, custom field
 * values, comments.
 *
 * ## Numbering
 *
 * `WEB-142` has to be gapless and per PROJECT, not per board, so the counter
 * here is scoped to a project and walked across every one of its boards before
 * `work.projects.next_card_number` is advanced past it. Leaving that column at
 * its default 1 is CLAUDE.md's "single most likely bug" — invisible until a
 * real user's first `New card` collides with a seeded number.
 *
 * ## Counters are computed, never guessed
 *
 * `checklist_done`, `checklist_total` and `comment_count` are read back off
 * the very rows this module is about to insert, in the same pass that builds
 * them — never a separate estimate. Same rule `counters.ts` enforces at
 * request time (recompute, don't increment), applied at generation time
 * instead of via a second SELECT, because here the "SELECT" is the array
 * already sitting in memory.
 */

/** A card an attachment could be hung off — everything `platform.attachments`
 * needs and nothing it would have to look up again. Excludes soft-deleted
 * cards; nothing seeds a file onto a card that no longer exists. */
export interface SeededCardRef {
  readonly id: string;
  readonly orgId: string;
  readonly boardId: string;
  readonly createdAt: Date;
  readonly createdBy: string;
}

export interface CardsOutput {
  readonly cardCount: number;
  readonly cardRefs: readonly SeededCardRef[];
}

type CardKind = 'live' | 'archived' | 'deleted';

interface CardDraft {
  readonly kind: CardKind;
  readonly list: SeededList;
  readonly forcedTitle?: string;
  readonly forcedPriority?: Priority;
}

const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

/**
 * A title long enough to hit the 500-character limit `Title` enforces
 * (`router.ts`), so the card tile, the table view and the detail header all
 * have something genuinely oversized to wrap or truncate — CLAUDE.md's
 * "500-char title" edge case, seeded on purpose rather than left to chance.
 */
const LONG_TITLE = (
  'A card title long enough to hit the five-hundred-character limit the API enforces, ' +
  'so the table view, the card detail header and the board tile all have something ' +
  'genuinely oversized to wrap, truncate or overflow, rather than every seeded title ' +
  'comfortably fitting on one line. '
)
  .repeat(4)
  .slice(0, 500);

export const cardsModule = defineSeedModule({
  name: 'work.cards',
  requires: [boardsModule],
  tables: [
    'work.cards',
    'work.card_labels',
    'work.checklists',
    'work.checklist_items',
    'work.custom_field_values',
    'work.card_comments',
  ],

  async seed(ctx): Promise<CardsOutput> {
    const rng = ctx.rng.fork('work.cards');
    const mix = ctx.profile.card;
    const { boards } = ctx.use(boardsModule);

    const byProject = new Map<string, { project: SeededProject; boards: SeededBoard[] }>();
    for (const board of boards) {
      const entry = byProject.get(board.projectId) ?? { project: board.project, boards: [] };
      entry.boards.push(board);
      byProject.set(board.projectId, entry);
    }

    // The one list `--chaos` targets, chosen the first time a board offers one
    // with room for two cards — module-local so it fires at most once per run.
    let chaosApplied = false;

    let cardCount = 0;
    const cardRefs: SeededCardRef[] = [];

    for (const { project, boards: projectBoards } of byProject.values()) {
      let nextNumber = 1;

      const cardRows: unknown[][] = [];
      const cardLabelRows: unknown[][] = [];
      const checklistRows: unknown[][] = [];
      const checklistItemRows: unknown[][] = [];
      const fieldValueRows: unknown[][] = [];
      const commentRows: unknown[][] = [];

      for (const board of projectBoards) {
        if (board.plan.cards === 0 || board.lists.length === 0) continue;

        // One list on the demo profile's "Design Review" board stays empty —
        // CLAUDE.md's edge-case list names it, and every other board is large
        // enough that leaving one to chance would almost never produce it.
        const reservedId =
          project.key === 'WEB' && board.name === 'Design Review'
            ? board.lists[board.lists.length - 1]?.id
            : undefined;
        const assignableLists = board.lists.filter((list) => list.id !== reservedId);
        if (assignableLists.length === 0) continue;

        const liveCount = board.plan.cards;
        const archivedCount = Math.round(liveCount * mix.archivedRate);
        const deletedCount = Math.round(liveCount * mix.deletedRate);

        const drafts: CardDraft[] = [];
        for (let i = 0; i < liveCount; i += 1) {
          drafts.push({ list: rng.pick(assignableLists), kind: 'live' });
        }
        for (let i = 0; i < archivedCount; i += 1) {
          drafts.push({ list: rng.pick(assignableLists), kind: 'archived' });
        }
        for (let i = 0; i < deletedCount; i += 1) {
          drafts.push({ list: rng.pick(assignableLists), kind: 'deleted' });
        }

        // Guaranteed priority coverage and a deliberately long title, both
        // pinned to this board's first few LIVE drafts so every demo run
        // produces them regardless of what the dice say elsewhere.
        if (project.key === 'WEB' && board.name === 'Delivery') {
          let forced = 0;
          for (let i = 0; i < drafts.length && forced < PRIORITIES.length; i += 1) {
            const draft = drafts[i];
            if (draft?.kind !== 'live') continue;
            const priority = PRIORITIES[forced];
            if (priority === undefined) break;
            drafts[i] = {
              ...draft,
              forcedPriority: priority,
              ...(forced === 0 ? { forcedTitle: LONG_TITLE } : {}),
            };
            forced += 1;
          }
        }

        // Grouped by list so ranks are generated once per list, in the order
        // cards were drafted into it — `rankSequence` used as intended, rather
        // than an on-demand `between()` cursor per card.
        const byList = new Map<string, CardDraft[]>();
        for (const draft of drafts) {
          const existing = byList.get(draft.list.id) ?? [];
          existing.push(draft);
          byList.set(draft.list.id, existing);
        }

        for (const listDrafts of byList.values()) {
          const list = listDrafts[0]?.list;
          if (!list) continue;
          const ranks = [...rankSequence(listDrafts.length)];

          if (ctx.chaos && !chaosApplied && listDrafts.length >= 2) {
            // Two cards, one rank: the InvalidRankError -> rebalance path
            // (CLAUDE.md, `rebalance.ts`) has something real to fire against.
            const first = ranks[0];
            if (first !== undefined) {
              ranks[1] = first;
              chaosApplied = true;
            }
          }

          for (const [index, draft] of listDrafts.entries()) {
            const rank = ranks[index];
            if (rank === undefined) {
              throw new Error('rankSequence produced fewer ranks than drafts — a bug here.');
            }

            const number = nextNumber;
            nextNumber += 1;

            const built = buildCard({
              ctx,
              rng,
              mix,
              project,
              org: project.org,
              board,
              list,
              draft,
              number,
              rank,
            });

            cardRows.push(built.cardRow);
            cardLabelRows.push(...built.labelRows);
            checklistRows.push(...built.checklistRows);
            checklistItemRows.push(...built.itemRows);
            fieldValueRows.push(...built.fieldRows);
            commentRows.push(...built.commentRows);
            if (built.cardRef) cardRefs.push(built.cardRef);

            cardCount += 1;
          }
        }
      }

      if (cardRows.length === 0) continue;

      await ctx.orgScope(project.orgId, async () => {
        await ctx.db.insert(
          'work.cards',
          [
            'id',
            'org_id',
            'project_id',
            'board_id',
            'list_id',
            'number',
            'title',
            'description::jsonb',
            'description_text',
            'rank',
            'assignee_ids::uuid[]',
            'status_id',
            'priority',
            'due_date',
            'start_date',
            'comment_count',
            'checklist_done',
            'checklist_total',
            'version',
            'archived_at',
            'deleted_at',
            'created_by',
            'created_at',
            'updated_at',
          ],
          cardRows,
        );

        if (cardLabelRows.length > 0) {
          await ctx.db.insert(
            'work.card_labels',
            ['org_id', 'project_id', 'card_id', 'label_id', 'added_at'],
            cardLabelRows,
          );
        }
        if (checklistRows.length > 0) {
          await ctx.db.insert(
            'work.checklists',
            ['id', 'org_id', 'card_id', 'name', 'rank', 'created_at', 'updated_at'],
            checklistRows,
          );
        }
        if (checklistItemRows.length > 0) {
          await ctx.db.insert(
            'work.checklist_items',
            [
              'id',
              'org_id',
              'card_id',
              'checklist_id',
              'text',
              'rank',
              'done',
              'done_by',
              'done_at',
              'created_at',
              'updated_at',
            ],
            checklistItemRows,
          );
        }
        if (fieldValueRows.length > 0) {
          await ctx.db.insert(
            'work.custom_field_values',
            ['org_id', 'project_id', 'card_id', 'field_id', 'value::jsonb', 'updated_at'],
            fieldValueRows,
          );
        }
        if (commentRows.length > 0) {
          await ctx.db.insert(
            'work.card_comments',
            [
              'id',
              'org_id',
              'card_id',
              'author_id',
              'body::jsonb',
              'body_text',
              'edited_at',
              'deleted_at',
              'created_at',
            ],
            commentRows,
          );
        }

        // The trap CLAUDE.md names first: advance the counter past every card
        // just written, or the first real `New card` collides with one of them.
        await ctx.db.query('UPDATE work.projects SET next_card_number = $1 WHERE id = $2', [
          nextNumber,
          project.id,
        ]);
      });

      ctx.log(`work.cards: ${project.key} — ${String(cardRows.length)} cards`);
    }

    return { cardCount, cardRefs };
  },
});

interface BuiltCard {
  readonly cardRow: unknown[];
  readonly labelRows: unknown[][];
  readonly checklistRows: unknown[][];
  readonly itemRows: unknown[][];
  readonly fieldRows: unknown[][];
  readonly commentRows: unknown[][];
  readonly cardRef: SeededCardRef | null;
}

function buildCard(args: {
  readonly ctx: SeedContext;
  readonly rng: Rng;
  readonly mix: CardMix;
  readonly project: SeededProject;
  readonly org: SeededOrg;
  readonly board: SeededBoard;
  readonly list: SeededList;
  readonly draft: CardDraft;
  readonly number: number;
  readonly rank: string;
}): BuiltCard {
  const { ctx, mix, project, org, board, list, draft, number, rank } = args;
  const now = ctx.now;
  const members = org.members;
  // A fork per card: this function draws a variable number of times depending
  // on what the card turns out to have, and a shared stream would make every
  // later card's content shift whenever an earlier one grew a checklist.
  const rng = args.rng.fork(`card:${project.id}:${String(number)}`);

  const cardId = rng.uuid(now);
  const createdAt = latest(board.createdAt, daysBefore(now, rng.int(1, 300)));
  const createdBy = rng.pick(members).id;
  const reference = `${project.key}-${String(number)}`;

  const title = draft.forcedTitle ?? cardTitle(rng);

  const described = rng.chance(mix.describedRate);
  const descriptionDoc = described ? descriptionDocument(rng) : null;
  const descriptionText = descriptionDoc ? flatten(descriptionDoc) : null;

  const assigneeCount = Math.min(rng.int(mix.assignees[0], mix.assignees[1]), members.length);
  const assignees = rng.sample(members, assigneeCount);
  const assigneeIds = assignees.map((user) => user.id);

  const statusId = rng.chance(mix.noStatusRate) ? null : rng.pick(project.statuses).id;
  const priority: Priority | null =
    draft.forcedPriority ?? (rng.chance(mix.noPriorityRate) ? null : rng.pick(PRIORITIES));

  const dueDate = rng.chance(mix.dueDateRate)
    ? rng.chance(mix.overdueShare)
      ? daysBefore(now, rng.int(1, 30))
      : daysAfter(now, rng.int(1, 60))
    : null;
  const startDate = rng.chance(mix.startDateRate)
    ? latest(createdAt, daysBefore(now, rng.int(5, 60)))
    : null;

  const archivedAt =
    draft.kind === 'archived' ? latest(createdAt, daysBefore(now, rng.int(1, 45))) : null;
  const deletedAt =
    draft.kind === 'deleted' ? latest(createdAt, daysBefore(now, rng.int(1, 45))) : null;

  /* ---------------------------------------------------------------------- *
   * Labels
   * ---------------------------------------------------------------------- */

  const labelRows: unknown[][] = [];
  let labelIds: readonly string[] = [];
  if (!rng.chance(mix.unlabelledRate) && project.labels.length > 0) {
    const count = Math.min(rng.int(mix.labels[0], mix.labels[1]), project.labels.length);
    const chosen = rng.sample(project.labels, count);
    labelIds = chosen.map((label) => label.id);
    for (const label of chosen) {
      labelRows.push([project.orgId, project.id, cardId, label.id, createdAt]);
    }
  }

  /* ---------------------------------------------------------------------- *
   * Checklists
   * ---------------------------------------------------------------------- */

  const checklistRows: unknown[][] = [];
  const itemRows: unknown[][] = [];
  let checklistTotal = 0;
  let checklistDone = 0;

  const checklistCount = rng.int(mix.checklists[0], mix.checklists[1]);
  const checklistRanks = [...rankSequence(checklistCount)];
  for (let c = 0; c < checklistCount; c += 1) {
    const checklistRank = checklistRanks[c];
    if (checklistRank === undefined) break;

    const checklistId = rng.uuid(now);
    checklistRows.push([
      checklistId,
      project.orgId,
      cardId,
      checklistName(rng),
      checklistRank,
      createdAt,
      createdAt,
    ]);

    const itemCount = rng.int(mix.checklistItems[0], mix.checklistItems[1]);
    const itemRanks = [...rankSequence(itemCount)];
    for (let i = 0; i < itemCount; i += 1) {
      const itemRank = itemRanks[i];
      if (itemRank === undefined) break;

      const isDone = rng.chance(mix.itemDoneRate);
      const doneBy = isDone ? rng.pick(members).id : null;
      const doneAt = isDone ? latest(createdAt, daysBefore(now, rng.int(0, 30))) : null;

      itemRows.push([
        rng.uuid(now),
        project.orgId,
        cardId,
        checklistId,
        checklistItemText(rng),
        itemRank,
        isDone,
        doneBy,
        doneAt,
        createdAt,
        createdAt,
      ]);

      checklistTotal += 1;
      if (isDone) checklistDone += 1;
    }
  }

  /* ---------------------------------------------------------------------- *
   * Custom field values
   * ---------------------------------------------------------------------- */

  const fieldRows: unknown[][] = [];
  for (const field of project.customFieldDefs) {
    if (!rng.chance(mix.customFieldRate)) continue;
    const value = generateFieldValue(rng, now, field, members);
    if (value === undefined) continue;
    fieldRows.push([project.orgId, project.id, cardId, field.id, value, createdAt]);
  }

  /* ---------------------------------------------------------------------- *
   * Comments
   * ---------------------------------------------------------------------- */

  const commentRows: unknown[][] = [];
  const liveComments: {
    readonly id: string;
    readonly createdAt: Date;
    readonly excerpt: string;
  }[] = [];

  const commentCount = rng.int(mix.comments[0], mix.comments[1]);
  let cursor = createdAt;
  for (let i = 0; i < commentCount; i += 1) {
    cursor = clampToNow(minutesAfter(cursor, rng.int(20, 6 * 60)), now);

    const commentId = rng.uuid(now);
    const authorId = rng.pick(members).id;
    const body = commentDocument(rng);
    const bodyText = flatten(body);

    const isEdited = rng.chance(mix.editedCommentRate);
    const editedAt = isEdited ? clampToNow(minutesAfter(cursor, rng.int(5, 180)), now) : null;

    const isDeleted = rng.chance(mix.deletedCommentRate);
    const commentDeletedAt = isDeleted
      ? clampToNow(minutesAfter(editedAt ?? cursor, rng.int(5, 180)), now)
      : null;

    commentRows.push([
      commentId,
      project.orgId,
      cardId,
      authorId,
      body,
      bodyText,
      editedAt,
      commentDeletedAt,
      cursor,
    ]);

    if (!isDeleted)
      liveComments.push({ id: commentId, createdAt: cursor, excerpt: bodyText.slice(0, 200) });
  }

  /* ---------------------------------------------------------------------- *
   * Events — sampled, never for every card (CLAUDE.md, `cardEventSampleRate`)
   * ---------------------------------------------------------------------- */

  if (rng.chance(ctx.profile.cardEventSampleRate)) {
    const envelope = envelopeFor(project.orgId, createdBy, createdAt);
    ctx.emit(
      createEvent(
        cardCreated,
        { cardId, boardId: board.id, listId: list.id, projectId: project.id, reference, title },
        envelope,
      ),
    );
    if (labelIds.length > 0) {
      ctx.emit(
        createEvent(
          cardLabeled,
          { cardId, boardId: board.id, before: [], after: labelIds },
          envelope,
        ),
      );
    }
    if (assigneeIds.length > 0) {
      ctx.emit(
        createEvent(
          cardAssigned,
          { cardId, boardId: board.id, before: [], after: assigneeIds },
          envelope,
        ),
      );
    }
    for (const comment of liveComments) {
      ctx.emit(
        createEvent(
          commentCreated,
          {
            commentId: comment.id,
            cardId,
            boardId: board.id,
            excerpt: comment.excerpt,
            // The seeder never generates replies (CLAUDE.md's own seeding
            // plan scopes comments to flat threads); every seeded comment is
            // top-level.
            parentCommentId: null,
          },
          envelopeFor(project.orgId, createdBy, comment.createdAt),
        ),
      );
    }
  }

  const cardRow: unknown[] = [
    cardId,
    project.orgId,
    project.id,
    board.id,
    list.id,
    number,
    title,
    descriptionDoc,
    descriptionText,
    rank,
    assigneeIds,
    statusId,
    priority,
    dueDate,
    startDate,
    liveComments.length,
    checklistDone,
    checklistTotal,
    1,
    archivedAt,
    deletedAt,
    createdBy,
    createdAt,
    createdAt,
  ];

  const cardRef: SeededCardRef | null =
    draft.kind === 'deleted'
      ? null
      : { id: cardId, orgId: project.orgId, boardId: board.id, createdAt, createdBy };

  return { cardRow, labelRows, checklistRows, itemRows, fieldRows, commentRows, cardRef };
}

/** Never later than "now" — a comment thread cannot run past the seed run's own clock. */
function clampToNow(candidate: Date, now: Date): Date {
  return candidate.getTime() > now.getTime() ? now : candidate;
}

/**
 * A value for one custom field, shaped exactly as `validateFieldValue`
 * (`custom-field-value.ts`) requires — this is the same jsonb column a real
 * save would write, so a seeded card must pass the same validator or the
 * fixture is lying about what the product accepts.
 */
function generateFieldValue(
  rng: Rng,
  now: Date,
  field: SeededCustomFieldDef,
  members: SeededOrg['members'],
): unknown {
  switch (field.type) {
    case 'text':
      return checklistItemText(rng);
    case 'number':
      return rng.int(1, 40);
    case 'date':
      return daysAfter(now, rng.int(-30, 60)).toISOString();
    case 'checkbox':
      return rng.chance(0.5);
    case 'select': {
      if (!field.options || field.options.length === 0) return undefined;
      return rng.pick(field.options);
    }
    case 'multi_select': {
      if (!field.options || field.options.length === 0) return undefined;
      const count = Math.min(rng.int(1, 3), field.options.length);
      return rng.sample(field.options, count);
    }
    case 'user':
      return rng.pick(members).id;
    default:
      return undefined;
  }
}
