-- 0023 — docs: spaces and pages, the materialized-path tree
-- (PLAN.md §3.3, §7.2, §9; ai/phase-6-docs.md §3.1, §3.4, §3.5, Wave 1)
--
-- Wave 1 of Phase 6. Three things here are load-bearing.
--
-- 1. THE HIERARCHY IS ENFORCED BY COMPOSITE FOREIGN KEYS, EXACTLY LIKE 0008.
--    A page carries org_id and space_id denormalized, and its self-referencing
--    parent_page_id is checked by a composite FK against
--    docs.pages (org_id, space_id, id) — so a page cannot be reparented onto a
--    page from another space (or another org) by naming an id the caller does
--    not otherwise have access to. `parent_page_id` is NULL for a space's root
--    pages; Postgres skips a composite FK when any referencing column is NULL,
--    so the constraint is correctly a no-op for roots rather than something
--    that needs a NULL-aware CASE in application code.
--
-- 2. ancestor_ids IS NEAREST-FIRST, NOT ROOT-FIRST, AND THAT IS NOT COSMETIC.
--    `packages/policy`'s `Target.ancestors` is documented as nearest-first
--    ("a card's [board, project]") and `nearestApplicable()` walks it in that
--    order, stopping at the first entry carrying a tuple. Storing this column
--    the same way means the service layer that builds a page's `Target` passes
--    `ancestor_ids` straight through — map each id to a `ResourceRef` and
--    append the space last as the final fallback — rather than reversing a
--    root-to-leaf path on every single permission check. The column is
--    maintained by the application (page create appends to the parent's array;
--    a move rewrites the moved subtree in one transaction, mirroring how
--    work's `rebalance.ts` repairs ranks) — nothing here enforces that a page's
--    `ancestor_ids` actually matches a walk of `parent_page_id`, the same way
--    nothing in 0008 enforces that a card's `rank` is really between its
--    neighbours'. Both are service-level invariants over a column the database
--    only constrains by shape.
--
-- 3. NO BODY CONTENT YET.
--    A page here is tree position and metadata only — title, parent, rank,
--    archived_at. `docs.yjs_updates` and `docs.page_versions` (§3.7) are Wave
--    2's migration, once live collaborative editing actually needs them; Wave
--    1 proves the authorization spine (tree CRUD, inherited-permission
--    resolution, the collab gateway's `onAuthenticate` hook) with at most one
--    editor at a time, per §5's Wave 1 scope. Building the CRDT storage now
--    would be guessing at a shape Wave 2 gets to design against a real caller.
--
-- No new database role in this migration. §6.1 (corrected on approval) — Wave
-- 1's `onAuthenticate` hook reads over the ordinary `taskflow_app` connection
-- via `withOrgScope`, identical to how `apps/realtime`'s `rooms.ts` loads a
-- board. `taskflow_collab` arrives with Wave 2's first migration, when
-- `apps/collab` first needs to WRITE (`docs.yjs_updates`, `docs.page_versions`).
--
-- The `docs` schema itself, and `taskflow_app`'s USAGE + default privileges on
-- it, already exist from 0001_schemas — nothing to grant here beyond RLS.

-- --------------------------------------------------------------------------
-- Spaces — the unit a page tree lives inside, and the fallback when no page
-- in a lookup chain carries an explicit grant (§3.4).
-- --------------------------------------------------------------------------
CREATE TABLE docs.spaces (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  name         text        NOT NULL,

  -- User-visible and restorable, same distinction work.projects draws: an
  -- archived space is hidden from the picker but its pages are not purged.
  archived_at  timestamptz,

  created_by   uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT spaces_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT spaces_name_length  CHECK (length(name) <= 200)
);

-- Target of docs.pages' composite FKs below — not a query index. A plain
-- REFERENCES spaces(id) would let a page name a space from another org while
-- carrying this org's org_id, which RLS would then happily show to the wrong
-- tenant because the row's own org_id column says it belongs there.
CREATE UNIQUE INDEX spaces_org_id_key ON docs.spaces (org_id, id);

CREATE INDEX spaces_live_idx ON docs.spaces (org_id, name)
  WHERE archived_at IS NULL;

-- --------------------------------------------------------------------------
-- Pages — the tree. See note 1 and 2 above for why the FKs and ancestor_ids
-- are shaped the way they are.
-- --------------------------------------------------------------------------
CREATE TABLE docs.pages (
  id              uuid        PRIMARY KEY,
  org_id          uuid        NOT NULL,
  space_id        uuid        NOT NULL,
  parent_page_id  uuid,

  title           text        NOT NULL,

  -- Sibling order, same fractional-index scheme as work.boards/lists/cards
  -- (packages/contracts/rank.ts). The CHECK is deliberately weaker than that
  -- module's own invariant, for the reason 0008 gives: it catches corruption
  -- without a second copy of the integer-part parser living in SQL.
  rank            text        NOT NULL,

  -- Nearest-first materialized path. See note 2 above.
  ancestor_ids    uuid[]      NOT NULL DEFAULT '{}',

  archived_at     timestamptz,

  created_by      uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pages_title_present     CHECK (length(btrim(title)) > 0),
  CONSTRAINT pages_title_length      CHECK (length(title) <= 500),
  CONSTRAINT pages_rank_format       CHECK (rank ~ '^[0-9A-Za-z]{2,}$'),
  CONSTRAINT pages_not_own_parent    CHECK (parent_page_id IS DISTINCT FROM id),
  CONSTRAINT pages_not_own_ancestor  CHECK (NOT (ancestor_ids && ARRAY[id])),

  CONSTRAINT pages_space_fk
    FOREIGN KEY (org_id, space_id)
      REFERENCES docs.spaces (org_id, id) ON DELETE CASCADE
);

-- Target of the self-referencing FK below, and of Wave 2's docs.yjs_updates /
-- docs.page_versions once they reference a page. Mirrors work.boards_org_id_key.
-- Created before pages_parent_fk deliberately: a self-referencing composite FK
-- cannot be declared inline in CREATE TABLE, because the unique index it
-- targets does not exist until the table does — unlike pages_space_fk above,
-- which references the ALREADY-CREATED docs.spaces and has no such ordering
-- problem.
CREATE UNIQUE INDEX pages_org_space_id_key ON docs.pages (org_id, space_id, id);

-- A page's parent must be a page in the SAME space. NULL for a root page — see
-- note 1 above for why that is a no-op rather than a violation.
ALTER TABLE docs.pages
  ADD CONSTRAINT pages_parent_fk
    FOREIGN KEY (org_id, space_id, parent_page_id)
      REFERENCES docs.pages (org_id, space_id, id) ON DELETE CASCADE;

-- Sibling listing within a parent (NULL parent_page_id = space root), the
-- query every tree render and every reorder issues.
CREATE INDEX pages_parent_rank_idx
  ON docs.pages (org_id, space_id, parent_page_id, rank, id)
  WHERE archived_at IS NULL;

-- Subtree containment ("everything under page X", used by move/archive/delete)
-- and the nearest-ancestor-grant walk (§3.4) both query this array; GIN is
-- what makes `ancestor_ids @> ARRAY[:pageId]` an index scan rather than a
-- sequential one over every page in the org.
CREATE INDEX pages_ancestor_ids_idx ON docs.pages USING gin (ancestor_ids);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, as every other tenant table.
-- --------------------------------------------------------------------------

ALTER TABLE docs.spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.spaces FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS spaces_tenant_isolation ON docs.spaces;
CREATE POLICY spaces_tenant_isolation ON docs.spaces
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE docs.pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.pages FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pages_tenant_isolation ON docs.pages;
CREATE POLICY pages_tenant_isolation ON docs.pages
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
