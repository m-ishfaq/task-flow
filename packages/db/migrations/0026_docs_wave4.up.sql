-- 0026 — docs: publish-to-public, page templates
-- (PLAN.md §3.3, §7.2, §9; ai/phase-6-docs.md §3.9, §4, §5, Wave 4)
--
-- Wave 4 of Phase 6. Two things here are load-bearing.
--
-- 1. PUBLISH REUSES page_versions' STORAGE SHAPE, PER §3.9, NOT A PARALLEL
--    MECHANISM. `kind` gains a third value, 'publish' — a full materialized
--    snapshot, taken the moment `publishPage` runs, exactly like a 'manual'
--    save. `docs.pages.published_version_id` names WHICH row is currently
--    live to the public; re-publishing writes a NEW row and repoints it,
--    never mutates the old one in place, so every past publish stays exactly
--    what a version-history reader would expect to find. This is the
--    constraint 0024's own note 3 predicted: "Wave 4 adds it in its own
--    migration ... once publish-to-public actually exists."
--
-- 2. THE PUBLIC READ PATH IS TWO NEW POLICIES, NOT A SIXTH DATABASE ROLE.
--    Every prior Docs wave that needed cross-tenant reach (taskflow_collab,
--    taskflow_backlinks) added a role because the READER'S IDENTITY was what
--    had to be narrow — a socket process, a background relay. A public page
--    view has no identity to narrow: anyone with the URL, logged in or not,
--    is meant to see it. That is exactly the shape `identity.orgs`' and
--    `identity.memberships`' `_self_read` policies already solved in
--    migration 0004 — a SECOND, ADDITIVE `FOR SELECT` policy, permissive
--    (permissive policies OR together), that only ever contributes a row
--    when `app.org_id` is UNSET. `withOrgScope` never leaves it unset — see
--    packages/db/src/client.ts — so an ordinary authenticated request is
--    unaffected regardless of how many orgs have published pages; the
--    org-scoped `*_tenant_isolation` policies below are untouched. The one
--    caller that runs unscoped is apps/api's new public docs route, reusing
--    `withGlobalScope` exactly as ITS OWN docstring already named this
--    scenario ("reading a public share link") before Docs existed to need
--    it. No new pool, no new role, no new grant — `taskflow_app` already
--    holds default SELECT on both tables from migration 0001.
--
--    A published page's `page_versions` row is found by joining back through
--    `docs.pages.published_version_id`, not by trusting `kind = 'publish'`
--    alone — a page can be UNPUBLISHED (§3.9: unpublish clears the pointer,
--    the row itself is left alone as ordinary version history) while an old
--    'publish'-kind row still sits in the table, and that row must stop
--    being publicly readable the moment it does.
--
-- docs.templates is new, deliberately NOT built on page_versions' table
-- itself (§5's "almost certainly a page_versions-SHAPED concept" is about
-- the STORAGE SHAPE — a full materialized snapshot, not a live document —
-- not the literal table). A template's `state` is a DETACHED copy: page_
-- versions rows cascade-delete with their page (0024's own FK), and a
-- template must survive its source page being deleted or moved, since reuse
-- is the entire point of having saved it. `source_page_id` is informational
-- only, carries no FK, and is never dereferenced by anything that renders a
-- template — the same trust boundary `page_versions.created_by` already
-- draws by going SET NULL rather than CASCADE.

-- --------------------------------------------------------------------------
-- Publish. See note 1 above.
-- --------------------------------------------------------------------------

ALTER TABLE docs.page_versions DROP CONSTRAINT page_versions_kind_valid;
ALTER TABLE docs.page_versions
  ADD CONSTRAINT page_versions_kind_valid CHECK (kind IN ('autosave', 'manual', 'publish'));

ALTER TABLE docs.pages ADD COLUMN published_at timestamptz;

-- Simple, non-composite FK — deliberately, not a three-column composite
-- pinning (org_id, id, published_version_id) against page_versions(org_id,
-- page_id, id). Postgres's ON DELETE SET NULL nulls EVERY referencing
-- column on a composite FK, and org_id/id here are the page's OWN identity
-- columns — not nullable, so a composite version of this FK would turn a
-- version-row deletion into a constraint violation instead of the clean
-- "this page silently reverts to unpublished" this column is for. Nothing
-- in this codebase deletes an individual page_versions row today (only
-- pages' own CASCADE removes one, which takes this row with it), so the
-- weaker guarantee — "names a real version row", not "names a version row
-- of THIS page" — costs nothing in practice and is enforced the same way
-- ancestor_ids' own consistency is: a service-level invariant `publishPage`
-- upholds by construction, documented here rather than assumed silent.
ALTER TABLE docs.pages
  ADD COLUMN published_version_id uuid REFERENCES docs.page_versions (id) ON DELETE SET NULL;

-- --------------------------------------------------------------------------
-- Templates. See the file header on why this is its own table rather than
-- page_versions rows or a flag on docs.pages.
-- --------------------------------------------------------------------------
CREATE TABLE docs.templates (
  id              uuid        PRIMARY KEY,
  org_id          uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  name            text        NOT NULL,
  description     text,

  -- A detached, full materialized Yjs state — the same
  -- Y.encodeStateAsUpdate shape page_versions.state carries, copied out at
  -- creation time rather than referenced live.
  state           bytea       NOT NULL,

  -- Informational only. No FK: a template must survive its source page's
  -- deletion, and a dangling id here is meaningless rather than dangerous —
  -- nothing ever dereferences it.
  source_page_id  uuid,

  archived_at     timestamptz,

  created_by      uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT templates_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT templates_name_length  CHECK (length(name) <= 200)
);

CREATE INDEX templates_live_idx ON docs.templates (org_id, name)
  WHERE archived_at IS NULL;

ALTER TABLE docs.templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE docs.templates FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS templates_tenant_isolation ON docs.templates;
CREATE POLICY templates_tenant_isolation ON docs.templates
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- taskflow_app already has default privileges on every table in the `docs`
-- schema (migration 0001), matching every other table this phase has added.

-- --------------------------------------------------------------------------
-- Public reads. See note 2 above.
-- --------------------------------------------------------------------------

-- `TO taskflow_app` on both — not cosmetic. Without it, `taskflow_collab` and
-- `taskflow_backlinks` (neither of which holds any grant on docs.pages, by
-- design — see 0023's and 0025's own headers) fail EVERY read of
-- docs.page_versions with "permission denied for table pages", even for an
-- ordinary org-scoped query that would never satisfy this policy's own
-- condition. Postgres checks table-level privileges for every relation a
-- policy's USING clause references at rewrite time, before the boolean logic
-- ever runs — an unreachable EXISTS subquery still demands SELECT on
-- docs.pages from whichever role is running the query, even one this policy
-- was never written for. Scoping the policy to the one role that actually
-- calls withGlobalScope for Docs keeps it invisible to every other role,
-- exactly as if it did not exist for them — confirmed against a real
-- database: apps/collab's own test suite (replay.test.ts) is what caught
-- this the first version of this migration got wrong.
DROP POLICY IF EXISTS pages_public_read ON docs.pages;
CREATE POLICY pages_public_read ON docs.pages
  FOR SELECT TO taskflow_app
  USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    AND published_at IS NOT NULL
    AND archived_at IS NULL
  );

DROP POLICY IF EXISTS page_versions_public_read ON docs.page_versions;
CREATE POLICY page_versions_public_read ON docs.page_versions
  FOR SELECT TO taskflow_app
  USING (
    NULLIF(current_setting('app.org_id', true), '') IS NULL
    AND EXISTS (
      SELECT 1 FROM docs.pages p
       WHERE p.published_version_id = docs.page_versions.id
         AND p.published_at IS NOT NULL
         AND p.archived_at IS NULL
    )
  );
