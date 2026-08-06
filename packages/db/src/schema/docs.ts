import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { orgs } from './tenancy.js';

/**
 * Docs tables — spaces, the page tree, and (as of migration 0024) the Yjs
 * write-ahead log and page versions (PLAN.md §3.3, §7.2; ai/phase-6-docs.md
 * §3.1, §3.4, §3.5, §3.7, Wave 1 + Wave 2).
 *
 * As with the other schema files, this is the TypeScript MIRROR of the
 * migration and not its source. If the two disagree, the migration wins and
 * this file is the bug.
 *
 * The one thing to know before editing this file: `pages.parentPageId` has no
 * `references()` here for the same reason `boards.projectId` doesn't in
 * `work.ts` — the migration's real constraint is the composite
 * `(org_id, space_id, parent_page_id) -> pages (org_id, space_id, id)`, which
 * keeps a page's parent inside its own space (and its own org), and Drizzle's
 * single-column `references()` cannot express that. Reading `parentPageId`
 * here and concluding it is an ordinary self-referencing FK is reading the
 * weaker half of the truth.
 *
 * `ancestorIds` is nearest-first — `[immediate parent, grandparent, ..., root]`
 * — matching `packages/policy`'s `Target.ancestors` convention exactly, so a
 * page's row is passed straight into a permission check with no reversal.
 */

const docs = pgSchema('docs');

/** `bytea` — Drizzle has no built-in Postgres binary column type. */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * A space — the unit a page tree lives inside, and the fallback when no page
 * in an inheritance chain carries an explicit grant tuple (§3.4).
 */
export const spaces = docs.table(
  'spaces',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),

    /** User-visible and restorable — an archived space's pages are not purged. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Target of pages' composite foreign keys, not a query index.
    uniqueIndex('spaces_org_id_key').on(table.orgId, table.id),
    index('spaces_live_idx')
      .on(table.orgId, table.name)
      .where(sql`archived_at IS NULL`),
  ],
);

/**
 * A page — the tree. `orgId` and `spaceId` have no `references()` here; see
 * the note at the top of this file.
 */
export const pages = docs.table(
  'pages',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    spaceId: uuid('space_id').notNull(),
    parentPageId: uuid('parent_page_id'),

    title: text('title').notNull(),

    /** Fractional index (packages/contracts/rank.ts), ordered within a parent by `(rank, id)`. */
    rank: text('rank').notNull(),

    /** Nearest-first materialized path. See the file-level note above. */
    ancestorIds: uuid('ancestor_ids')
      .array()
      .notNull()
      .default(sql`'{}'`),

    archivedAt: timestamp('archived_at', { withTimezone: true }),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Target of the self-referencing composite FK on parent_page_id, and of
    // Wave 2's docs.yjs_updates / docs.page_versions once they reference a
    // page. The migration is what enforces the FK itself — Drizzle has no way
    // to declare a composite, self-referencing foreign key.
    uniqueIndex('pages_org_space_id_key').on(table.orgId, table.spaceId, table.id),
    index('pages_parent_rank_idx')
      .on(table.orgId, table.spaceId, table.parentPageId, table.rank, table.id)
      .where(sql`archived_at IS NULL`),
    check('pages_title_present', sql`length(btrim(${table.title})) > 0`),
    check('pages_title_length', sql`length(${table.title}) <= 500`),
    check('pages_rank_format', sql`${table.rank} ~ '^[0-9A-Za-z]{2,}$'`),
    check('pages_not_own_parent', sql`${table.parentPageId} IS DISTINCT FROM ${table.id}`),
    // The GIN index on ancestor_ids (subtree containment, the nearest-
    // ancestor-grant walk) exists only in the migration. Drizzle has no
    // expression-index builder for `USING gin`, and a half-declared index
    // here would suggest this list is complete — see work.ts's identical note
    // on cards_assignees_idx.
  ],
);

/**
 * The write-ahead log (migration 0024, §3.7). `data` is an opaque raw
 * y-protocols/sync sub-message (syncStep2 or update), not a bare Yjs update —
 * see `apps/collab/src/persist.ts` for what writes here and why. `pageId` has
 * no `references()` for the same reason `pages.parentPageId` doesn't: the
 * migration's real constraint is composite, `(org_id, page_id) -> pages
 * (org_id, id)`.
 */
export const yjsUpdates = docs.table(
  'yjs_updates',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    pageId: uuid('page_id').notNull(),

    data: bytea('data').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('yjs_updates_page_order_idx').on(table.orgId, table.pageId, table.createdAt, table.id),
  ],
);

/**
 * Explicit save points, plus the periodic compacted state that doubles as an
 * autosave (§3.7). `state` is a full materialized `Y.encodeStateAsUpdate`
 * snapshot, not a delta — restoring a version is a single row read.
 */
export const pageVersions = docs.table(
  'page_versions',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    pageId: uuid('page_id').notNull(),

    /** 'autosave' (written by compaction) or 'manual' (on-demand save). No 'publish' yet — Wave 4's migration adds it. */
    kind: text('kind').notNull(),

    state: bytea('state').notNull(),

    /** Null for 'autosave' — compaction is not an act any user performed. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('page_versions_page_idx').on(table.orgId, table.pageId, table.createdAt),
    check('page_versions_kind_valid', sql`${table.kind} IN ('autosave', 'manual')`),
  ],
);
