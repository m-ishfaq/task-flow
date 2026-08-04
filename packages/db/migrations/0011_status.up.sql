-- 0011 — status and priority (ai/phase-3.5-work-ux.md §5.3)
--
-- The structural decision behind this migration: a card's COLUMN is a grouping,
-- not its status. Today `cards.list_id` is the only classification a card has,
-- so "group by assignee" or "group by priority" have no field to read. Adding
-- `statuses` as a per-project vocabulary and `cards.status_id` as a field gives
-- the board a second, independent classification without touching `list_id` —
-- lists keep board layout, `rank` scope and WIP limits; status takes grouping,
-- filtering and done-ness. See §3 of the plan for why replacing lists outright
-- is a larger, more destructive change than this phase needs.
--
-- Expand only. `status_id` is NULLABLE here and stays that way in this
-- migration on purpose: giving it NOT NULL with a default would silently
-- assign every existing card a status nobody chose. 0012 backfills existing
-- rows; a future contract migration is what would make it NOT NULL, once the
-- application has run against backfilled data for a while.

-- --------------------------------------------------------------------------
-- Statuses — per PROJECT, matching labels and custom fields (already
-- project-scoped vocabulary — CLAUDE.md, card detail notes). Per board would
-- multiply what a user maintains by the number of boards for no one's benefit.
-- --------------------------------------------------------------------------
CREATE TABLE work.statuses (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL,
  project_id  uuid        NOT NULL,

  name        text        NOT NULL,

  -- What the status MEANS, independent of its name — a project renaming "Done"
  -- to "Shipped" must not break anything asking "is this card finished".
  category    text        NOT NULL,

  -- Hex triplet, same convention as work.labels.color. The UI owns the
  -- palette; the column does not need to know it.
  color       text        NOT NULL,

  -- Display order within the project. A plain integer, not the fractional
  -- rank cards and lists use — reordering a project's handful of statuses is
  -- an occasional admin action, not a drag-heavy end-user one, so there is no
  -- concurrent-insertion case here to size a fractional index for.
  position    integer     NOT NULL,

  -- The status a newly created card lands in when nothing else was chosen.
  -- At most one per project — see the partial unique index below. Not used by
  -- 0012's backfill mapping, which falls back to the first `not_started`
  -- status by position rather than this flag: a project's default status and
  -- "the status backfilled cards with no better match get" are different
  -- questions that happen to often have the same answer.
  is_default  boolean     NOT NULL DEFAULT false,

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT statuses_name_present  CHECK (length(btrim(name)) > 0),
  CONSTRAINT statuses_name_length   CHECK (length(name) <= 60),
  CONSTRAINT statuses_color_format  CHECK (color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT statuses_category_valid
    CHECK (category IN ('not_started', 'active', 'done')),

  CONSTRAINT statuses_project_fk
    FOREIGN KEY (org_id, project_id) REFERENCES work.projects (org_id, id) ON DELETE CASCADE
);

-- One status of a given name per project, case-insensitive — the same
-- collision `labels_project_name_key` prevents. Two statuses called "Done"
-- and "done" would make "group by status" show two columns for the same
-- concept.
CREATE UNIQUE INDEX statuses_project_name_key ON work.statuses (org_id, project_id, lower(name));

-- Target of cards' composite FK — carries project_id so the join can assert
-- the status and the card belong to the SAME project, exactly as
-- `labels_org_project_id_key` does for labels.
CREATE UNIQUE INDEX statuses_org_project_id_key ON work.statuses (org_id, project_id, id);

-- At most one default per project. Partial rather than a boolean-plus-check:
-- Postgres has no CHECK that can see other rows, and this is the standard way
-- to express "unique among the trues".
CREATE UNIQUE INDEX statuses_project_default_key
  ON work.statuses (org_id, project_id) WHERE is_default;

-- Listing a project's statuses in display order — the board's "group by
-- status" read, and the project settings page.
CREATE INDEX statuses_project_position_idx ON work.statuses (org_id, project_id, position, id);

-- --------------------------------------------------------------------------
-- Cards gain status_id and priority.
-- --------------------------------------------------------------------------
ALTER TABLE work.cards ADD COLUMN status_id uuid;
ALTER TABLE work.cards ADD COLUMN priority  text;

ALTER TABLE work.cards ADD CONSTRAINT cards_priority_valid
  CHECK (priority IS NULL OR priority IN ('urgent', 'high', 'normal', 'low'));

-- The same composite-FK pattern as `cards_list_fk`: RLS stops a status being
-- read across a TENANT, and says nothing about a status from another PROJECT
-- of the same tenant. This is the control that makes that unwritable rather
-- than merely unwritten.
--
-- `ON DELETE SET NULL (status_id)` — the column-list form, not the bare
-- `ON DELETE SET NULL` a composite FK defaults to. The bare form would null
-- EVERY column in the constraint when a status is deleted, which here would
-- also blank the card's org_id and project_id: an unlabelled card turning
-- into a tenant-less one. Requires Postgres 15+; this project runs 17.
ALTER TABLE work.cards ADD CONSTRAINT cards_status_fk
  FOREIGN KEY (org_id, project_id, status_id)
    REFERENCES work.statuses (org_id, project_id, id) ON DELETE SET NULL (status_id);

-- "Group by status" and "filter by status" — the same shape as
-- `cards_due_idx`.
CREATE INDEX cards_status_idx ON work.cards (org_id, status_id)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, repeated verbatim from
-- packages/db/src/rls.ts, exactly as every other tenant table in this schema.
-- --------------------------------------------------------------------------

ALTER TABLE work.statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.statuses FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS statuses_tenant_isolation ON work.statuses;
CREATE POLICY statuses_tenant_isolation ON work.statuses
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
