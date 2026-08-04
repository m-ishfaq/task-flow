-- 0009 — card detail: labels, checklists, custom fields, comments
-- (PLAN.md §3.1, §7, §7.2)
--
-- Everything a card holds that is not a column on the card itself. Four
-- independent features, one migration, because they share the same two
-- structural problems and solving them once is cheaper than four times.
--
-- PROBLEM 1 — A CHILD MUST NOT ATTACH TO A CARD IN ANOTHER PROJECT.
--   Labels and custom fields are defined PER PROJECT, and the row joining one
--   to a card names both. RLS keeps that inside a tenant and says nothing about
--   which project — so a label from project A on a card in project B is
--   writable as far as tenancy is concerned, and would render as a label the
--   board's own settings do not list.
--
--   Fixed the same way as 0008: the join table carries project_id, and two
--   composite foreign keys force the card and the definition to agree on it.
--   That needs new unique indexes on cards and on the definition tables, added
--   here rather than in 0008 because 0008 is applied and migrations are never
--   edited once applied (§7.4).
--
-- PROBLEM 2 — DENORMALIZED COUNTERS MUST NOT DRIFT.
--   `cards.comment_count`, `checklist_done` and `checklist_total` exist so that
--   rendering a board does not count children per card. They are maintained by
--   the services that own the children, inside the same transaction as the
--   write — never by a periodic reconciliation, which would mean the board is
--   routinely wrong and nobody can tell whether a given number is stale or a
--   bug. The CHECK constraint from 0008 (`checklist_done <= checklist_total`)
--   is what turns a drift bug into a failed write rather than a wrong badge.

-- --------------------------------------------------------------------------
-- Indexes that later composite foreign keys point at.
--
-- Adding an index to a table created by an earlier migration is the expand
-- step of expand/migrate/contract, and is safe: no existing row changes, and
-- nothing yet depends on them.
-- --------------------------------------------------------------------------
CREATE UNIQUE INDEX cards_org_id_key ON work.cards (org_id, id);
CREATE UNIQUE INDEX cards_org_project_id_key ON work.cards (org_id, project_id, id);

-- --------------------------------------------------------------------------
-- Labels — per project, so a board's label set is the project's label set.
--
-- Not per board: the same "bug" label on two boards of one project would be
-- two rows, and filtering "all bugs in this project" would have to union them.
-- --------------------------------------------------------------------------
CREATE TABLE work.labels (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL,
  project_id  uuid        NOT NULL,

  name        text        NOT NULL,

  -- Stored as a hex triplet rather than a name from a fixed palette. The UI
  -- picks from a palette; the column does not need to know which one, and a
  -- palette change would otherwise be a data migration.
  color       text        NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT labels_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT labels_name_length  CHECK (length(name) <= 60),
  CONSTRAINT labels_color_format CHECK (color ~ '^#[0-9a-f]{6}$'),

  CONSTRAINT labels_project_fk
    FOREIGN KEY (org_id, project_id) REFERENCES work.projects (org_id, id) ON DELETE CASCADE
);

-- One label of a given name per project. Two labels called "bug" is a data
-- entry accident that makes filtering silently incomplete.
CREATE UNIQUE INDEX labels_project_name_key ON work.labels (org_id, project_id, lower(name));

-- Target of card_labels' composite FK — carries project_id so the join can
-- assert the label and the card belong to the SAME project.
CREATE UNIQUE INDEX labels_org_project_id_key ON work.labels (org_id, project_id, id);

CREATE TABLE work.card_labels (
  org_id      uuid        NOT NULL,
  project_id  uuid        NOT NULL,
  card_id     uuid        NOT NULL,
  label_id    uuid        NOT NULL,

  added_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (card_id, label_id),

  -- The pair that makes a cross-project label unwritable: both sides must
  -- agree on org_id AND project_id.
  CONSTRAINT card_labels_card_fk
    FOREIGN KEY (org_id, project_id, card_id)
      REFERENCES work.cards (org_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT card_labels_label_fk
    FOREIGN KEY (org_id, project_id, label_id)
      REFERENCES work.labels (org_id, project_id, id) ON DELETE CASCADE
);

-- "Which cards carry this label" — the filter query, and the reverse of the
-- primary key.
CREATE INDEX card_labels_label_idx ON work.card_labels (org_id, label_id);

-- --------------------------------------------------------------------------
-- Checklists
-- --------------------------------------------------------------------------
CREATE TABLE work.checklists (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL,
  card_id     uuid        NOT NULL,

  name        text        NOT NULL,
  rank        text        NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT checklists_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT checklists_name_length  CHECK (length(name) <= 120),
  CONSTRAINT checklists_rank_format  CHECK (rank ~ '^[0-9A-Za-z]{2,}$'),

  CONSTRAINT checklists_card_fk
    FOREIGN KEY (org_id, card_id) REFERENCES work.cards (org_id, id) ON DELETE CASCADE
);

CREATE INDEX checklists_card_idx ON work.checklists (org_id, card_id, rank, id);

-- Target of checklist_items' composite FK.
CREATE UNIQUE INDEX checklists_org_id_key ON work.checklists (org_id, id);

CREATE TABLE work.checklist_items (
  id            uuid        PRIMARY KEY,
  org_id        uuid        NOT NULL,

  -- Denormalized from checklists so the counter update on the card can find
  -- its card without a three-table join, and so RLS filters on this table.
  card_id       uuid        NOT NULL,
  checklist_id  uuid        NOT NULL,

  text          text        NOT NULL,
  rank          text        NOT NULL,

  done          boolean     NOT NULL DEFAULT false,
  -- Who ticked it and when. Null whenever `done` is false; the CHECK below is
  -- what stops the three columns disagreeing about whether the item is done.
  done_by       uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  done_at       timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT checklist_items_text_present CHECK (length(btrim(text)) > 0),
  CONSTRAINT checklist_items_text_length  CHECK (length(text) <= 500),
  CONSTRAINT checklist_items_rank_format  CHECK (rank ~ '^[0-9A-Za-z]{2,}$'),

  -- `done_at` is set exactly when `done` is true. Without this the card's
  -- `checklist_done` counter and the item rows can tell different stories, and
  -- only one of them is shown to the user.
  CONSTRAINT checklist_items_done_consistent
    CHECK ((done AND done_at IS NOT NULL) OR (NOT done AND done_at IS NULL AND done_by IS NULL)),

  CONSTRAINT checklist_items_checklist_fk
    FOREIGN KEY (org_id, checklist_id)
      REFERENCES work.checklists (org_id, id) ON DELETE CASCADE,
  CONSTRAINT checklist_items_card_fk
    FOREIGN KEY (org_id, card_id) REFERENCES work.cards (org_id, id) ON DELETE CASCADE
);

CREATE INDEX checklist_items_checklist_idx
  ON work.checklist_items (org_id, checklist_id, rank, id);

-- Recomputing a card's counters after a delete.
CREATE INDEX checklist_items_card_idx ON work.checklist_items (org_id, card_id);

-- --------------------------------------------------------------------------
-- Custom fields
--
-- Definition per project, value per card. The alternative — a column added per
-- custom field — is a DDL change triggered by a user clicking a button, which
-- is a migration story nobody wants and a lock on the busiest table.
-- --------------------------------------------------------------------------
CREATE TABLE work.custom_field_defs (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL,
  project_id  uuid        NOT NULL,

  name        text        NOT NULL,

  -- Closed list. The value column is jsonb, so the TYPE is the only thing that
  -- says how to read it — an unknown type would be a value nothing can render
  -- and nothing can filter.
  type        text        NOT NULL,

  -- Choices for 'select' and 'multi_select', null otherwise. The CHECK pairs
  -- the two so a select field cannot exist with nothing to select.
  options     jsonb,

  rank        text        NOT NULL,
  archived_at timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT custom_field_defs_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT custom_field_defs_name_length  CHECK (length(name) <= 60),
  CONSTRAINT custom_field_defs_rank_format  CHECK (rank ~ '^[0-9A-Za-z]{2,}$'),
  CONSTRAINT custom_field_defs_type_valid
    CHECK (type IN ('text', 'number', 'date', 'checkbox', 'select', 'multi_select', 'user')),
  CONSTRAINT custom_field_defs_options_present
    CHECK (
      (type IN ('select', 'multi_select') AND jsonb_typeof(options) = 'array')
      OR (type NOT IN ('select', 'multi_select') AND options IS NULL)
    ),

  CONSTRAINT custom_field_defs_project_fk
    FOREIGN KEY (org_id, project_id) REFERENCES work.projects (org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX custom_field_defs_project_name_key
  ON work.custom_field_defs (org_id, project_id, lower(name));

CREATE UNIQUE INDEX custom_field_defs_org_project_id_key
  ON work.custom_field_defs (org_id, project_id, id);

CREATE TABLE work.custom_field_values (
  org_id      uuid        NOT NULL,
  project_id  uuid        NOT NULL,
  card_id     uuid        NOT NULL,
  field_id    uuid        NOT NULL,

  -- Shape depends on the definition's `type`, validated by the service against
  -- that definition. jsonb rather than a column per type because the latter is
  -- seven mostly-null columns and a CHECK nobody can read.
  value       jsonb       NOT NULL,

  updated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (card_id, field_id),

  -- Same pairing as card_labels: the card and the field definition must agree
  -- on their project, so a field from another project cannot be set on a card.
  CONSTRAINT custom_field_values_card_fk
    FOREIGN KEY (org_id, project_id, card_id)
      REFERENCES work.cards (org_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT custom_field_values_field_fk
    FOREIGN KEY (org_id, project_id, field_id)
      REFERENCES work.custom_field_defs (org_id, project_id, id) ON DELETE CASCADE
);

-- "Every card where field X is Y" — the filter query (§10.2).
CREATE INDEX custom_field_values_field_idx ON work.custom_field_values (org_id, field_id);

-- --------------------------------------------------------------------------
-- Comments
--
-- TipTap JSON with a flattened copy, exactly as `cards.description` (§8.7).
-- There is no HTML column here either, and for the same reason.
-- --------------------------------------------------------------------------
CREATE TABLE work.card_comments (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL,
  card_id     uuid        NOT NULL,

  author_id   uuid        REFERENCES identity.users (id) ON DELETE SET NULL,

  body        jsonb       NOT NULL,
  body_text   text        NOT NULL,

  -- Set on edit, so the UI can show "edited" without comparing timestamps that
  -- differ by milliseconds on every row.
  edited_at   timestamptz,

  -- Soft delete: a deleted comment leaves a tombstone so a thread does not
  -- silently lose its middle and become incoherent.
  deleted_at  timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT card_comments_card_fk
    FOREIGN KEY (org_id, card_id) REFERENCES work.cards (org_id, id) ON DELETE CASCADE
);

-- The thread render: oldest first, which is also insertion order because ids
-- are UUIDv7 (§7.1).
CREATE INDEX card_comments_card_idx ON work.card_comments (org_id, card_id, id);

-- Full-text over comment bodies, for Phase 8. Same immutability requirement as
-- the cards index in 0008: the config argument is not optional.
CREATE INDEX card_comments_search_idx ON work.card_comments
  USING gin (to_tsvector('english', body_text));

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3)
-- --------------------------------------------------------------------------

ALTER TABLE work.labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.labels FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS labels_tenant_isolation ON work.labels;
CREATE POLICY labels_tenant_isolation ON work.labels
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE work.card_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.card_labels FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_labels_tenant_isolation ON work.card_labels;
CREATE POLICY card_labels_tenant_isolation ON work.card_labels
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE work.checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.checklists FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checklists_tenant_isolation ON work.checklists;
CREATE POLICY checklists_tenant_isolation ON work.checklists
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE work.checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.checklist_items FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS checklist_items_tenant_isolation ON work.checklist_items;
CREATE POLICY checklist_items_tenant_isolation ON work.checklist_items
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE work.custom_field_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.custom_field_defs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custom_field_defs_tenant_isolation ON work.custom_field_defs;
CREATE POLICY custom_field_defs_tenant_isolation ON work.custom_field_defs
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE work.custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.custom_field_values FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS custom_field_values_tenant_isolation ON work.custom_field_values;
CREATE POLICY custom_field_values_tenant_isolation ON work.custom_field_values
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE work.card_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.card_comments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS card_comments_tenant_isolation ON work.card_comments;
CREATE POLICY card_comments_tenant_isolation ON work.card_comments
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
