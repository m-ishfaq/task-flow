-- 0026 — docs: publish-to-public, PDF export, page templates (PLAN.md §3.3,
-- §10.6; ai/phase-6-docs.md §3.9, §4, Wave 4)
--
-- Three things here are load-bearing.
--
-- 1. PUBLISHING REUSES page_versions, EXACTLY AS §3.9 SPECIFIES — no parallel
--    "published content" table. `pages.published_version_id` points at a row
--    in the same table restore already writes into, tagged with a new 'kind'
--    value ('publish') this migration adds to the CHECK migration 0024 left
--    it out of on purpose (that migration's own comment: "No 'publish' yet —
--    see note 3 above"). Publishing therefore has the identical durability
--    and shape guarantee restore already has: a full materialized snapshot,
--    never a live document a request could observe mid-edit.
--
-- 2. THE PUBLISHED POINTER IS A COMPOSITE FK, NOT A BARE uuid COLUMN. A plain
--    `published_version_id uuid REFERENCES docs.page_versions (id)` would
--    only prove the row exists SOMEWHERE — not that it belongs to the same
--    page, or the same org. That is exactly the weaker-half-of-the-truth
--    trap this file's own schema header (packages/db/src/schema/docs.ts)
--    warns about for `pages.parent_page_id`, and here it would let a bug
--    elsewhere point a page's published pointer at another page's (or
--    another tenant's) content — RLS stops the cross-tenant case but does
--    nothing about a page in the SAME org pointing at the wrong page's
--    version, the identical gap the work.cards composite FK exists to close.
--    `page_versions_org_id_page_key` below is what makes the composite FK
--    expressible: PostgreSQL can only reference a column set that is unique,
--    and `id` alone already is, but `(org_id, id, page_id)` needs its own
--    index to be a valid FK target.
--
-- 3. PAGE TEMPLATES ARE "page_versions-SHAPED SEED CONTENT", NOT A SEPARATE
--    MECHANISM. §5's own Wave 4 description names this directly. A template
--    row's `state` is the identical `Y.encodeStateAsUpdate` bytes a
--    page_versions row carries, captured by materializing an existing page's
--    current content (`materializeCurrentState`, already built for restore
--    and the backlinks relay) at the moment a template is saved. Creating a
--    page from a template writes that `state` as the new page's FIRST
--    page_versions row (kind = 'manual') — the exact "write a new snapshot,
--    let replay find it as latest" mechanism restorePageVersion already
--    uses, reused a third time rather than re-invented. Templates are scoped
--    to a SPACE, not a page (a template is reusable content for creating new
--    pages IN a space, not an attribute of any one page), and use the
--    existing `space:manage` / `space:read` permissions — see
--    template.service.ts's own header on why this needed no new permission.

-- --------------------------------------------------------------------------
-- Publish. `page_versions.kind` gains 'publish' as an allowed value.
-- --------------------------------------------------------------------------
ALTER TABLE docs.page_versions DROP CONSTRAINT page_versions_kind_valid;
ALTER TABLE docs.page_versions
  ADD CONSTRAINT page_versions_kind_valid CHECK (kind IN ('autosave', 'manual', 'publish'));

-- Target of the composite FK below. `id` is already globally unique (it is
-- the primary key), so this adds no real uniqueness constraint beyond what
-- already holds — it exists purely so Postgres has a matching index to
-- reference three columns against, the identical reason `pages_org_id_key`
-- was added in migration 0024 for the (org_id, id) pair `page_versions`
-- itself now references transitively.
CREATE UNIQUE INDEX page_versions_org_id_page_key ON docs.page_versions (org_id, id, page_id);

ALTER TABLE docs.pages
  ADD COLUMN published_version_id uuid,
  ADD COLUMN published_at         timestamptz;

ALTER TABLE docs.pages
  ADD CONSTRAINT pages_published_pair
    CHECK ((published_version_id IS NULL) = (published_at IS NULL));

-- Position-for-position: org_id -> org_id, published_version_id -> id (the
-- version's own id), id -> page_id (the version must belong to THIS page).
-- A published pointer can therefore never name a version of another page,
-- in this org or any other, regardless of what application code does.
ALTER TABLE docs.pages
  ADD CONSTRAINT pages_published_version_fk
    FOREIGN KEY (org_id, published_version_id, id)
    REFERENCES docs.page_versions (org_id, id, page_id);

-- "Which pages are currently published" — the one query the public
-- read path and any future "published pages" admin list need.
CREATE INDEX pages_published_idx ON docs.pages (org_id, published_at)
  WHERE published_version_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Page templates — see note 3 above.
-- --------------------------------------------------------------------------
CREATE TABLE docs.page_templates (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL,
  space_id    uuid        NOT NULL,

  name        text        NOT NULL,

  -- A full materialized Yjs document state, captured once at template-save
  -- time — not a live reference to the source page, which may itself be
  -- edited or archived afterward with no effect on the template. See note 3.
  state       bytea       NOT NULL,

  created_by  uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT page_templates_space_fk
    FOREIGN KEY (org_id, space_id) REFERENCES docs.spaces (org_id, id) ON DELETE CASCADE,
  CONSTRAINT page_templates_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT page_templates_name_length CHECK (length(name) <= 200)
);

CREATE INDEX page_templates_space_idx ON docs.page_templates (org_id, space_id, name);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, as every other tenant table.
-- --------------------------------------------------------------------------
ALTER TABLE docs.page_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.page_templates FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS page_templates_tenant_isolation ON docs.page_templates;
CREATE POLICY page_templates_tenant_isolation ON docs.page_templates
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- taskflow_app already has default privileges on every table in the `docs`
-- schema (migration 0001) — no explicit GRANT needed for page_templates, the
-- same fact every prior Docs migration has confirmed for its own new tables.
--
-- No new database role, unlike Waves 2-3. Publish, PDF export and templates
-- are all ordinary authenticated (or, for the public read path, explicitly
-- public) apps/api routes over the ORDINARY taskflow_app connection — none
-- of them touch docs.yjs_updates, so there is nothing here for
-- taskflow_collab's write-exception boundary to widen, and no new
-- cross-tenant background process (unlike taskflow_backlinks) that would
-- need a role of its own.
