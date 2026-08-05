-- 0014 — saved views (ai/phase-3.5-work-ux.md §6)
--
-- A view is a NAMED, STORED arrangement of one board: its type, its grouping,
-- its sort, and its filter. Wave 2 made all four expressible; this makes them
-- worth setting more than once.
--
-- ## Why rows rather than URL parameters
--
-- The board already encodes grouping and filter in the URL, and that is the
-- right primitive — a link someone pastes into chat must carry what they were
-- looking at. What a URL cannot do is be SHARED as a standing arrangement: it
-- has no name, no owner, nothing to list, and nobody discovers a colleague's
-- link by opening the board. Those are row properties.
--
-- ## The filter column stores the AST, and `@me` stays symbolic in it
--
-- `filter` is a `FilterNode` tree exactly as `packages/filter` defines it —
-- which is why that package shipping in Phase 3 rather than Phase 8 keeps
-- paying off. `@me` is stored UNRESOLVED and substituted at compile time
-- (§10.2). Resolving it at save time would turn a shared "assigned to me" view
-- into "assigned to whoever saved it", which is the one thing a shared view of
-- that shape must not mean.
--
-- Stored as jsonb and re-validated by the service on read AND write. The
-- compiler already refuses unknown fields, so a tree that somehow reached the
-- column cannot become SQL — but a view that fails to parse should be reported
-- as a broken view, not as a 500 from the board.

CREATE TABLE work.views (
  id               uuid        PRIMARY KEY,
  org_id           uuid        NOT NULL,

  -- Denormalized so the composite FK below can assert board-within-project,
  -- the same reason cards carry it. RLS stops a view being attached to another
  -- TENANT's board and says nothing about another PROJECT's board.
  project_id       uuid        NOT NULL,
  board_id         uuid        NOT NULL,

  name             text        NOT NULL,

  -- Which renderer: the kanban, the virtualized table, or the grouped list.
  -- Text plus a CHECK rather than a Postgres enum — adding a value to an enum
  -- cannot be done in a transaction that also uses it, which makes the
  -- expand-migrate-contract discipline awkward for no gain at this size.
  type             text        NOT NULL,

  -- Both nullable: "no grouping" and "board order" are real, and a default of
  -- 'list'/'rank' would make every view look deliberately configured when the
  -- author only wanted to save a filter.
  group_by         text,
  sort_by          text,

  -- The filter AST, or NULL for an unfiltered view. Not `'{}'::jsonb` — an
  -- empty object is a malformed FilterNode, and storing one would mean every
  -- reader has to distinguish "no filter" from "a filter that failed to parse".
  filter           jsonb,

  -- Table view's column selection. NULL means "whatever the table defaults
  -- to", which keeps a view valid when a future column is added rather than
  -- freezing it to the set that existed the day it was saved.
  visible_columns  jsonb,

  -- Shared views are part of the board for everyone who can read it; private
  -- ones are visible only to their author. The read policy is in the service,
  -- not here: RLS answers the TENANT question, and this is an ordinary
  -- authorization one.
  is_shared        boolean     NOT NULL DEFAULT false,

  -- Who may edit a PRIVATE view, and who is recorded as the author of a shared
  -- one. `ON DELETE CASCADE` on the user: a departed member's private views are
  -- visible to nobody and editable by nobody, so keeping them is keeping
  -- garbage. Shared views are deliberately not exempt — see the down file.
  created_by       uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  -- Display order in the board's view tabs. A plain integer for the same
  -- reason `statuses.position` is one: reordering a handful of tabs is an
  -- occasional action, not a drag-heavy concurrent one worth a fractional index.
  position         integer     NOT NULL DEFAULT 0,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT views_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT views_name_length  CHECK (length(name) <= 60),

  CONSTRAINT views_type_valid   CHECK (type IN ('board', 'table', 'list')),

  -- Mirrors GroupBy and SortBy in apps/web/src/features/work/grouping.ts. A
  -- value the client cannot render is a view that silently shows the wrong
  -- thing, so the column refuses it rather than the UI falling back.
  --
  -- `manual` is the board's own rank order, and it is the default the toolbar
  -- starts in — NOT a synonym for "unsorted". Naming it `rank` here would have
  -- been a CHECK that rejected the single most common value a saved view can
  -- hold, and every attempt to save an unmodified board would have been a 500.
  CONSTRAINT views_group_by_valid
    CHECK (group_by IS NULL OR group_by IN ('list', 'status', 'assignee', 'priority', 'due')),
  CONSTRAINT views_sort_by_valid
    CHECK (sort_by IS NULL OR sort_by IN ('manual', 'title', 'due', 'priority')),

  -- A filter must be an OBJECT if present. Catches an array or a bare string
  -- reaching the column, which would fail to parse on every subsequent read.
  CONSTRAINT views_filter_shape
    CHECK (filter IS NULL OR jsonb_typeof(filter) = 'object'),
  CONSTRAINT views_visible_columns_shape
    CHECK (visible_columns IS NULL OR jsonb_typeof(visible_columns) = 'array'),

  -- board-within-project-within-org, unwritable rather than merely unwritten.
  CONSTRAINT views_board_fk
    FOREIGN KEY (org_id, project_id, board_id)
      REFERENCES work.boards (org_id, project_id, id) ON DELETE CASCADE
);

-- One view of a given name per board, case-insensitive — but only among SHARED
-- views. Two people may each keep a private "My stuff"; two shared tabs with
-- the same name on one board are indistinguishable to everyone else.
CREATE UNIQUE INDEX views_board_shared_name_key
  ON work.views (org_id, board_id, lower(name)) WHERE is_shared;

-- And one private view of a given name per person per board, for the same
-- reason applied to an audience of one.
CREATE UNIQUE INDEX views_board_private_name_key
  ON work.views (org_id, board_id, created_by, lower(name)) WHERE NOT is_shared;

-- The board's view tabs: every shared view plus the caller's own private ones,
-- in display order. Leads with org_id per the convention.
CREATE INDEX views_board_position_idx ON work.views (org_id, board_id, position, id);

-- "My saved views" across boards, for the personal surfaces in Wave 3.
CREATE INDEX views_author_idx ON work.views (org_id, created_by, board_id);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, repeated verbatim from
-- packages/db/src/rls.ts, exactly as every other tenant table in this schema.
-- --------------------------------------------------------------------------

ALTER TABLE work.views ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.views FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS views_tenant_isolation ON work.views;
CREATE POLICY views_tenant_isolation ON work.views
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
