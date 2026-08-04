import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { orgs } from './tenancy.js';

/**
 * Work tables (migration 0008, PLAN.md §3.1, §7.2, §10.1).
 *
 * As with the other schema files, these are the TypeScript mirror of the
 * migration and not its source. Drizzle is a query builder here; the migration
 * is what CI runs up -> down -> up against real Postgres, and it carries the RLS
 * policies, the CHECK constraints, and — most importantly for this schema — the
 * COMPOSITE foreign keys that keep the denormalized hierarchy honest.
 *
 * That last point is the one to know before editing this file. `cards` carries
 * project_id, board_id and list_id, and the migration constrains all four
 * columns together against a matching unique index on `lists`, so a card cannot
 * name a list from another board or another org. Drizzle's `references()` is
 * single-column and cannot express any of it, so **the constraint that matters
 * most on this table has no representation here at all**. Reading these
 * definitions and concluding that `list_id` is an ordinary FK would be reading
 * the weaker half of the truth.
 *
 * If the two disagree, the migration wins and this file is the bug.
 */

const work = pgSchema('work');

/**
 * A project — the unit that owns a card-number namespace.
 *
 * `nextCardNumber` is the entire card-numbering mechanism: `WEB-142` has to be
 * gapless and per-project, and a Postgres sequence is neither. The service
 * increments it with `UPDATE ... RETURNING` inside the card's own transaction,
 * which takes a row lock and therefore serializes card creation within one
 * project. Accepted knowingly — the contended case is a bulk import, not a user
 * typing.
 */
export const projects = work.table(
  'projects',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    /** The prefix in `WEB-142`. Appears in URLs and chat, so renaming is a migration. */
    key: text('key').notNull(),
    description: text('description'),

    nextCardNumber: integer('next_card_number').notNull().default(1),

    /** User-visible and restorable, unlike `deletedAt` (§7.1). */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('projects_org_key_key').on(table.orgId, table.key),
    // Target of the composite foreign keys on boards, not a query index.
    uniqueIndex('projects_org_id_key').on(table.orgId, table.id),
    index('projects_live_idx')
      .on(table.orgId, table.name)
      .where(sql`archived_at IS NULL AND deleted_at IS NULL`),
  ],
);

/**
 * A board — a kanban surface inside a project.
 *
 * `orgId` and `projectId` have no `references()` here because the migration's
 * constraint is `(org_id, project_id) -> projects (org_id, id)`, which Drizzle
 * cannot express. See the note at the top of this file.
 */
export const boards = work.table(
  'boards',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),

    name: text('name').notNull(),

    /** Fractional index (§10.1). Ordered within the project by `(rank, id)`. */
    rank: text('rank').notNull(),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('boards_org_id_key').on(table.orgId, table.id),
    uniqueIndex('boards_org_project_id_key').on(table.orgId, table.projectId, table.id),
    index('boards_project_rank_idx')
      .on(table.orgId, table.projectId, table.rank, table.id)
      .where(sql`archived_at IS NULL AND deleted_at IS NULL`),
  ],
);

/**
 * A list — a column of a board. A card's list IS its status; there is no
 * separate status column to disagree with it.
 */
export const lists = work.table(
  'lists',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),
    boardId: uuid('board_id').notNull(),

    name: text('name').notNull(),
    rank: text('rank').notNull(),

    /**
     * Work-in-progress limit, or null for none.
     *
     * Advisory. The API reports a breach and does not refuse the move — a hard
     * block turns a planning tool into an obstacle at exactly the moment
     * someone is trying to record reality.
     */
    wipLimit: integer('wip_limit'),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The full ancestor chain, so a card's composite FK can inherit every
    // constraint above it in one reference.
    uniqueIndex('lists_org_project_board_id_key').on(
      table.orgId,
      table.projectId,
      table.boardId,
      table.id,
    ),
    index('lists_board_rank_idx')
      .on(table.orgId, table.boardId, table.rank, table.id)
      .where(sql`archived_at IS NULL AND deleted_at IS NULL`),
  ],
);

/** Cards (§7.2) — the busiest table in the product. */
export const cards = work.table(
  'cards',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),
    boardId: uuid('board_id').notNull(),
    listId: uuid('list_id').notNull(),

    /** Per-project, from `projects.nextCardNumber`. Renders as `<key>-<number>`. */
    number: integer('number').notNull(),

    title: text('title').notNull(),

    /**
     * TipTap JSON, never HTML — CLAUDE.md rule 4, PLAN.md §8.7.
     *
     * There is deliberately no sibling column that could hold markup: a column
     * that can hold HTML is a column that eventually gets rendered as HTML.
     */
    description: jsonb('description'),

    /** The same content flattened, so search never has to parse JSON. */
    descriptionText: text('description_text'),

    rank: text('rank').notNull(),

    /** Multi-assignee from the start — see the migration on why not a scalar. */
    assigneeIds: uuid('assignee_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),

    /**
     * Grouping and done-ness, independent of `listId` (migration 0011).
     *
     * Nullable: existing cards have no status until 0012 backfills them, and
     * the composite FK to `statuses` (org_id, project_id, status_id) — which
     * Drizzle cannot express, see the file header — is what stops a status
     * from another project being set here.
     */
    statusId: uuid('status_id'),
    /** One of PRIORITIES. Nullable — "no priority" is a real, common state. */
    priority: text('priority'),

    dueDate: timestamp('due_date', { withTimezone: true }),
    startDate: timestamp('start_date', { withTimezone: true }),

    /** Denormalized counters (§7.2), maintained by the services owning the children. */
    commentCount: integer('comment_count').notNull().default(0),
    checklistDone: integer('checklist_done').notNull().default(0),
    checklistTotal: integer('checklist_total').notNull().default(0),

    /**
     * Optimistic concurrency (§7.1).
     *
     * Every update carries the version it read and fails when it no longer
     * matches, so two people editing one card produce a conflict the second is
     * told about rather than a silent overwrite.
     */
    version: integer('version').notNull().default(1),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('cards_project_number_key').on(table.orgId, table.projectId, table.number),
    index('cards_list_rank_idx')
      .on(table.orgId, table.boardId, table.listId, table.rank, table.id)
      .where(sql`archived_at IS NULL AND deleted_at IS NULL`),
    index('cards_due_idx')
      .on(table.orgId, table.dueDate)
      .where(sql`due_date IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL`),
    // The GIN indexes — `cards_assignees_idx` and `cards_search_idx` — exist
    // only in the migration. Drizzle has no expression-index builder, and a
    // half-declared index here would suggest this list is complete.
  ],
);

/* -------------------------------------------------------------------------- *
 * Card detail (migration 0009) — labels, checklists, custom fields, comments
 *
 * Every join table below carries `projectId` or `cardId` denormalized, and in
 * every case the migration pairs it with a COMPOSITE foreign key that Drizzle
 * cannot express. The rule those constraints enforce — a label and the card it
 * is attached to must belong to the same project — has no representation in
 * this file at all.
 * -------------------------------------------------------------------------- */

/**
 * A label, defined per PROJECT rather than per board.
 *
 * The same "bug" label on two boards of one project would otherwise be two
 * rows, and "all bugs in this project" would have to union them.
 */
export const labels = work.table(
  'labels',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),

    name: text('name').notNull(),
    /** Hex triplet. The UI owns the palette; the column does not need to know it. */
    color: text('color').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('labels_org_project_id_key').on(table.orgId, table.projectId, table.id),
    // `labels_project_name_key` is case-insensitive — a lower(name) expression
    // index, which Drizzle has no builder for. Migration only.
  ],
);

export const cardLabels = work.table(
  'card_labels',
  {
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),
    cardId: uuid('card_id').notNull(),
    labelId: uuid('label_id').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.cardId, table.labelId] }),
    index('card_labels_label_idx').on(table.orgId, table.labelId),
  ],
);

export const checklists = work.table(
  'checklists',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    cardId: uuid('card_id').notNull(),

    name: text('name').notNull(),
    rank: text('rank').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('checklists_org_id_key').on(table.orgId, table.id),
    index('checklists_card_idx').on(table.orgId, table.cardId, table.rank, table.id),
  ],
);

/**
 * A checklist item.
 *
 * `cardId` is denormalized from the checklist so the card's counter update can
 * find its card without a three-table join, and so RLS filters on a column of
 * this table. The migration's CHECK is what keeps `done`, `doneAt` and `doneBy`
 * from telling three different stories about whether the item is finished.
 */
export const checklistItems = work.table(
  'checklist_items',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    cardId: uuid('card_id').notNull(),
    checklistId: uuid('checklist_id').notNull(),

    text: text('text').notNull(),
    rank: text('rank').notNull(),

    done: boolean('done').notNull().default(false),
    doneBy: uuid('done_by').references(() => users.id, { onDelete: 'set null' }),
    doneAt: timestamp('done_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('checklist_items_checklist_idx').on(table.orgId, table.checklistId, table.rank, table.id),
    index('checklist_items_card_idx').on(table.orgId, table.cardId),
  ],
);

/**
 * A custom field DEFINITION, per project.
 *
 * The alternative — a real column added per custom field — is a DDL change
 * triggered by a user clicking a button, and a lock on the busiest table.
 */
export const customFieldDefs = work.table(
  'custom_field_defs',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),

    name: text('name').notNull(),
    /** One of CUSTOM_FIELD_TYPES. The migration's CHECK is the enforcement. */
    type: text('type').notNull(),
    /** Choices for select types, null otherwise. Paired by a CHECK. */
    options: jsonb('options'),

    rank: text('rank').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('custom_field_defs_org_project_id_key').on(table.orgId, table.projectId, table.id),
  ],
);

export const customFieldValues = work.table(
  'custom_field_values',
  {
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),
    cardId: uuid('card_id').notNull(),
    fieldId: uuid('field_id').notNull(),

    /** Shape depends on the definition's `type`, validated by the service. */
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.cardId, table.fieldId] }),
    index('custom_field_values_field_idx').on(table.orgId, table.fieldId),
  ],
);

/** A card comment. TipTap JSON with a flattened copy, exactly as `cards.description`. */
export const cardComments = work.table(
  'card_comments',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    cardId: uuid('card_id').notNull(),

    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),

    body: jsonb('body').notNull(),
    bodyText: text('body_text').notNull(),

    /** Set on edit, so "edited" does not mean comparing near-identical timestamps. */
    editedAt: timestamp('edited_at', { withTimezone: true }),
    /** Tombstone, so a thread does not silently lose its middle. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('card_comments_card_idx').on(table.orgId, table.cardId, table.id)],
);

/* -------------------------------------------------------------------------- *
 * Status (migration 0011) — a card's grouping and done-ness, independent of
 * `listId`. See the migration header for why this coexists with lists rather
 * than replacing them.
 * -------------------------------------------------------------------------- */

/**
 * A status, defined per PROJECT — matching labels and custom fields.
 *
 * `cards.statusId` carries the composite FK Drizzle cannot express: (org_id,
 * project_id, status_id) against (org_id, project_id, id) here, with
 * `ON DELETE SET NULL (status_id)` so deleting a status un-classifies its
 * cards rather than deleting them. See the migration for why the column-list
 * form of `SET NULL` is the one that matters — the bare form would also null
 * a card's org_id and project_id.
 */
export const statuses = work.table(
  'statuses',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    projectId: uuid('project_id').notNull(),

    name: text('name').notNull(),
    /** One of not_started / active / done. The migration's CHECK is the enforcement. */
    category: text('category').notNull(),
    /** Hex triplet, same convention as `labels.color`. */
    color: text('color').notNull(),
    /** Display order. A plain integer — see the migration for why not a rank. */
    position: integer('position').notNull(),
    /** The status a new card lands in when nothing else was chosen. At most one per project. */
    isDefault: boolean('is_default').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('statuses_org_project_id_key').on(table.orgId, table.projectId, table.id),
    index('statuses_project_position_idx').on(table.orgId, table.projectId, table.position, table.id),
    // `statuses_project_name_key` is case-insensitive (lower(name)) and
    // `statuses_project_default_key` is partial (WHERE is_default) — both
    // expression indexes Drizzle has no builder for. Migration only.
  ],
);
