import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  index,
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

    /**
     * Publish-to-public (Wave 4, §3.9). Both null or both set — enforced by
     * `pages_published_pair` in the migration, not here (Drizzle has no
     * multi-column CHECK builder that reads better than the raw SQL one).
     * `publishedVersionId` is NOT a plain FK to `page_versions.id` — see
     * migration 0026's own header on why the composite FK (org + THIS page)
     * matters and where it actually lives.
     */
    publishedVersionId: uuid('published_version_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),

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
    //
    // Likewise `pages_published_version_fk` (the composite FK to
    // page_versions) and `pages_published_idx` — the migration is the
    // source, this is its mirror.
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

/**
 * Comments (Wave 3, §3.6). `anchorFrom`/`anchorTo` are opaque, serialized Yjs
 * `RelativePosition`s — see the migration's own header for why: neither this
 * schema nor any server process ever decodes what character they point at,
 * only that they are structurally valid (`apps/api/src/docs/anchor.ts`).
 */
export const comments = docs.table(
  'comments',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    pageId: uuid('page_id').notNull(),

    anchorFrom: bytea('anchor_from').notNull(),
    anchorTo: bytea('anchor_to').notNull(),

    body: jsonb('body').notNull(),
    bodyText: text('body_text').notNull(),

    /** A resolved comment stays in the thread — only hidden from the default view. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),

    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('comments_page_idx')
      .on(table.orgId, table.pageId, table.createdAt)
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * Suggestions (Wave 3, §3.6) — a tracked-change-style proposed edit. Accept/
 * reject is STATE only; applying an accepted suggestion to the live document
 * is a client-side edit through the ordinary Yjs sync session (see the
 * migration's own header — the same "known limitation, named rather than
 * assumed away" shape `page-version.service.ts`'s restore already has).
 */
export const suggestions = docs.table(
  'suggestions',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    pageId: uuid('page_id').notNull(),

    anchorFrom: bytea('anchor_from').notNull(),
    anchorTo: bytea('anchor_to').notNull(),

    /** 'insert' | 'delete' | 'replace'. */
    kind: text('kind').notNull(),
    /** Null for 'delete'. */
    proposedContent: jsonb('proposed_content'),

    /** 'pending' | 'accepted' | 'rejected'. */
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),

    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('suggestions_page_pending_idx')
      .on(table.orgId, table.pageId, table.createdAt)
      .where(sql`status = 'pending'`),
    check('suggestions_kind_valid', sql`${table.kind} IN ('insert', 'delete', 'replace')`),
    check('suggestions_status_valid', sql`${table.status} IN ('pending', 'accepted', 'rejected')`),
  ],
);

/**
 * Backlinks (Wave 3, §3.10) — "which pages link to this one". A plain edge
 * list, wholesale-recomputed per source page by the backlinks relay, never
 * patched incrementally — see `apps/api/src/docs/backlinks.ts`.
 */
export const backlinks = docs.table(
  'backlinks',
  {
    orgId: uuid('org_id').notNull(),
    sourcePageId: uuid('source_page_id').notNull(),
    targetPageId: uuid('target_page_id').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.sourcePageId, table.targetPageId] }),
    index('backlinks_target_idx').on(table.orgId, table.targetPageId),
  ],
);

/**
 * The backlinks relay's dispatch bookkeeping (Wave 3, migration 0025's own
 * header). A row here means PROCESSED — written by the consumer
 * (`taskflow_backlinks`) after folding a `page_versions` row into
 * `docs.backlinks`, never by whatever wrote that row in the first place.
 * Absence is "not yet processed": an existence anti-join, not a position
 * cursor (the same choice migration 0015 made for `outbox_dispatch`, for
 * the same reason).
 */
export const backlinkDispatch = docs.table('backlink_dispatch', {
  pageVersionId: uuid('page_version_id')
    .primaryKey()
    .references(() => pageVersions.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),

  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Page templates (Wave 4, §5) — "page_versions-shaped seed content" scoped
 * to a space, not a page: reusable starting content for creating new pages
 * IN a space, the same relationship a project's label set or custom field
 * definitions have to its cards (CLAUDE.md's "managing the project's
 * vocabulary" distinction). `state` is captured once, at save time, by
 * materializing whichever page it was copied from — it does not track that
 * page afterward. See migration 0026's own header for the full reasoning,
 * including why this needed no new permission.
 */
export const pageTemplates = docs.table(
  'page_templates',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    spaceId: uuid('space_id').notNull(),

    name: text('name').notNull(),
    state: bytea('state').notNull(),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('page_templates_space_idx').on(table.orgId, table.spaceId, table.name),
    check('page_templates_name_present', sql`length(btrim(${table.name})) > 0`),
    check('page_templates_name_length', sql`length(${table.name}) <= 200`),
    // The composite FK to docs.spaces (org_id, space_id) lives only in the
    // migration, for the same reason `pages.parentPageId` and
    // `backlinks_target_fk` do — Drizzle's `references()` is single-column.
  ],
);
