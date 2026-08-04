-- 0008 — work: projects, boards, lists, cards (PLAN.md §3.1, §7.2, §10.1)
--
-- The first product schema. Everything before this was identity, tenancy, and
-- the machinery that protects them; this is the first table a user will
-- recognize as their own data.
--
-- Four things here are load-bearing and none of them are obvious from the
-- column lists.
--
-- 1. THE HIERARCHY IS ENFORCED BY COMPOSITE FOREIGN KEYS, NOT BY THE SERVICE.
--    A card carries project_id, board_id and list_id — denormalized, because a
--    board query that joined three levels to filter one tenant would be both
--    slower and a second place for the org boundary to be got wrong. The copies
--    are kept honest by the database: cards reference
--    (org_id, project_id, board_id, list_id) against a unique index on lists
--    that already includes its own ancestors, so a row naming a list from
--    another board — or another ORG — cannot be inserted at all.
--
--    This matters more than it looks. `withOrgScope` plus RLS stops a card being
--    written into another tenant. It does NOT stop a card being written into
--    another BOARD inside the same tenant, which is an ordinary authorization
--    bug: the caller may hold card:create on the board they named and no access
--    at all to the board they actually wrote to. The FK makes that unwritable.
--
-- 2. `rank` IS A STRING AND ITS ORDER IS THE PRODUCT BEHAVIOUR.
--    Fractional index (§10.1), base-62, sorted lexicographically. Every ordering
--    query is `ORDER BY rank, id` — the id tiebreak is required, because
--    concurrent inserts at the same point legitimately produce equal ranks and
--    without a second key two clients would render the same rows in different
--    orders.
--
--    The CHECK below is deliberately weaker than the invariant in
--    packages/contracts/rank.ts. It catches corruption (empty strings, spaces,
--    punctuation) without reimplementing the integer-part parser in SQL, where
--    it would be a second copy free to drift from the first.
--
-- 3. CARD NUMBERS COME FROM A COUNTER ON THE PROJECT ROW, NOT A SEQUENCE.
--    `WEB-142` has to be gapless and per-project, and a Postgres sequence is
--    neither: it is global unless one is created per project, and it deliberately
--    loses numbers on rollback. So `projects.next_card_number` is incremented by
--    `UPDATE ... RETURNING` inside the card's own transaction. That takes a row
--    lock on the project, which serializes card creation within one project —
--    accepted knowingly. The contended case is a bulk import, not a user typing.
--
-- 4. `description` IS jsonb AND THERE IS NO html COLUMN.
--    TipTap JSON, never HTML (§8.7). A column that could hold markup is a column
--    that eventually gets rendered as markup somewhere, and `description_text`
--    exists so that search never needs to reach into the JSON to find words.

-- --------------------------------------------------------------------------
-- Projects — the unit that owns a card-number namespace.
-- --------------------------------------------------------------------------
CREATE TABLE work.projects (
  id                uuid        PRIMARY KEY,
  org_id            uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  name              text        NOT NULL,

  -- The prefix in `WEB-142`. Short, uppercase, and stable: it appears in card
  -- URLs, in chat, and in commit messages, so renaming one is a migration
  -- rather than an edit.
  key               text        NOT NULL,

  description       text,

  -- Next number to hand out. See note 3 — this is the whole card-numbering
  -- mechanism, and it starts at 1 so the first card is WEB-1 rather than WEB-0.
  next_card_number  integer     NOT NULL DEFAULT 1,

  -- User-visible and restorable (§7.1). Distinct from deleted_at, which is a
  -- soft delete awaiting a retention purge.
  archived_at       timestamptz,
  deleted_at        timestamptz,

  created_by        uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT projects_name_present  CHECK (length(btrim(name)) > 0),
  CONSTRAINT projects_key_format    CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  CONSTRAINT projects_counter_valid CHECK (next_card_number > 0)
);

-- One project key per org. Globally unique would be wrong: two tenants both
-- wanting `WEB` is not a conflict, it is the normal case.
CREATE UNIQUE INDEX projects_org_key_key ON work.projects (org_id, key);

-- Target of the composite foreign keys below, not a query index. A plain
-- REFERENCES projects(id) would let a board name a project from another org
-- while carrying this org's org_id — a row RLS would happily show to the wrong
-- tenant, because its org_id column says it belongs there.
CREATE UNIQUE INDEX projects_org_id_key ON work.projects (org_id, id);

CREATE INDEX projects_live_idx ON work.projects (org_id, name)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

-- --------------------------------------------------------------------------
-- Boards — a kanban surface inside a project.
-- --------------------------------------------------------------------------
CREATE TABLE work.boards (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL,
  project_id   uuid        NOT NULL,

  name         text        NOT NULL,

  -- Boards are ordered within their project by the same mechanism as cards.
  rank         text        NOT NULL,

  archived_at  timestamptz,
  deleted_at   timestamptz,

  created_by   uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT boards_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT boards_rank_format  CHECK (rank ~ '^[0-9A-Za-z]{2,}$'),

  CONSTRAINT boards_project_fk
    FOREIGN KEY (org_id, project_id) REFERENCES work.projects (org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX boards_org_id_key ON work.boards (org_id, id);

-- Carries project_id so a card's composite FK can assert board-within-project
-- as well as board-within-org.
CREATE UNIQUE INDEX boards_org_project_id_key ON work.boards (org_id, project_id, id);

CREATE INDEX boards_project_rank_idx ON work.boards (org_id, project_id, rank, id)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

-- --------------------------------------------------------------------------
-- Lists — the columns of a board. A card's list is its status.
-- --------------------------------------------------------------------------
CREATE TABLE work.lists (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL,
  project_id   uuid        NOT NULL,
  board_id     uuid        NOT NULL,

  name         text        NOT NULL,
  rank         text        NOT NULL,

  -- Work-in-progress limit. NULL means none. Advisory: the API reports the
  -- breach and does not refuse the move, because a hard block on a WIP limit
  -- turns a planning tool into an obstacle at exactly the moment someone is
  -- trying to record reality.
  wip_limit    integer,

  archived_at  timestamptz,
  deleted_at   timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lists_name_present CHECK (length(btrim(name)) > 0),
  CONSTRAINT lists_rank_format  CHECK (rank ~ '^[0-9A-Za-z]{2,}$'),
  CONSTRAINT lists_wip_valid    CHECK (wip_limit IS NULL OR wip_limit > 0),

  CONSTRAINT lists_board_fk
    FOREIGN KEY (org_id, project_id, board_id)
      REFERENCES work.boards (org_id, project_id, id) ON DELETE CASCADE
);

-- The full ancestor chain, so a card can reference it and inherit every
-- constraint above in one foreign key.
CREATE UNIQUE INDEX lists_org_project_board_id_key
  ON work.lists (org_id, project_id, board_id, id);

CREATE INDEX lists_board_rank_idx ON work.lists (org_id, board_id, rank, id)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

-- --------------------------------------------------------------------------
-- Cards (§7.2)
-- --------------------------------------------------------------------------
CREATE TABLE work.cards (
  id                uuid        PRIMARY KEY,
  org_id            uuid        NOT NULL,
  project_id        uuid        NOT NULL,
  board_id          uuid        NOT NULL,
  list_id           uuid        NOT NULL,

  -- Per-project, from projects.next_card_number. Renders as `<key>-<number>`.
  number            integer     NOT NULL,

  title             text        NOT NULL,

  -- TipTap JSON. NOT html, and there is deliberately no column that could hold
  -- markup — see note 4 at the top of this file.
  description       jsonb,

  -- The same content flattened to plain text, maintained by the service that
  -- writes `description`. Exists so search never parses JSON, and so the
  -- full-text index below has something immutable to index.
  description_text  text,

  rank              text        NOT NULL,

  -- Multi-assignee from the start. Changing a scalar assignee_id into an array
  -- later means an expand/migrate/contract cycle over the busiest table in the
  -- product (§7.4), which is a lot of ceremony to avoid one column now.
  assignee_ids      uuid[]      NOT NULL DEFAULT '{}',

  due_date          timestamptz,
  start_date        timestamptz,

  -- Denormalized counters (§7.2). Maintained by the services that own the
  -- children, so rendering a board never counts comments per card.
  comment_count     integer     NOT NULL DEFAULT 0,
  checklist_done    integer     NOT NULL DEFAULT 0,
  checklist_total   integer     NOT NULL DEFAULT 0,

  -- Optimistic concurrency (§7.1). Every update carries the version it read and
  -- fails if it no longer matches, so two people editing one card produce a
  -- conflict the second one is told about rather than a silent overwrite.
  version           integer     NOT NULL DEFAULT 1,

  archived_at       timestamptz,
  deleted_at        timestamptz,

  created_by        uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cards_title_present   CHECK (length(btrim(title)) > 0),
  CONSTRAINT cards_title_length    CHECK (length(title) <= 500),
  CONSTRAINT cards_rank_format     CHECK (rank ~ '^[0-9A-Za-z]{2,}$'),
  CONSTRAINT cards_number_valid    CHECK (number > 0),
  CONSTRAINT cards_version_valid   CHECK (version > 0),
  CONSTRAINT cards_counters_valid  CHECK (
    comment_count >= 0 AND checklist_done >= 0 AND checklist_total >= 0
    AND checklist_done <= checklist_total
  ),

  -- The whole ancestor chain in one constraint. A card cannot name a list from
  -- another board, a board from another project, or anything from another org.
  CONSTRAINT cards_list_fk
    FOREIGN KEY (org_id, project_id, board_id, list_id)
      REFERENCES work.lists (org_id, project_id, board_id, id) ON DELETE CASCADE
);

-- `WEB-142` resolves to exactly one card. Also what makes the counter on
-- projects self-checking: a bug that handed out a number twice fails here
-- rather than producing two cards with the same name.
CREATE UNIQUE INDEX cards_project_number_key ON work.cards (org_id, project_id, number);

-- The board render: every card in a list, in order. Ends with `id` so the
-- (rank, id) tiebreak is served by the index rather than by a sort.
CREATE INDEX cards_list_rank_idx ON work.cards (org_id, board_id, list_id, rank, id)
  WHERE archived_at IS NULL AND deleted_at IS NULL;

-- "My cards, soonest first". §7.2 specifies (org_id, assignee_ids, due_date) as
-- one index; it is written as two here because a btree cannot answer array
-- containment — `assignee_ids @> ARRAY[$1]` needs GIN, and GIN cannot order by
-- due_date. The pair does what the single entry intended.
CREATE INDEX cards_assignees_idx ON work.cards USING gin (assignee_ids);
CREATE INDEX cards_due_idx ON work.cards (org_id, due_date)
  WHERE due_date IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL;

-- Full-text over the flattened description, for Phase 8. Built now because
-- adding a GIN index to a large live table later means either a long lock or
-- CONCURRENTLY outside a transaction, and this table is empty today.
-- The 'english' argument is required: the single-argument to_tsvector depends on
-- a session GUC and is therefore not immutable, so it cannot be indexed.
CREATE INDEX cards_search_idx ON work.cards
  USING gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description_text, '')));

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3)
--
-- Generated form, repeated verbatim from packages/db/src/rls.ts. FORCE is what
-- makes it apply to the table owner (taskflow_migrator) as well; ENABLE alone
-- protects nothing from the role that ran this file.
-- --------------------------------------------------------------------------

ALTER TABLE work.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.projects FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS projects_tenant_isolation ON work.projects;
CREATE POLICY projects_tenant_isolation ON work.projects
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE work.boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.boards FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS boards_tenant_isolation ON work.boards;
CREATE POLICY boards_tenant_isolation ON work.boards
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE work.lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.lists FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lists_tenant_isolation ON work.lists;
CREATE POLICY lists_tenant_isolation ON work.lists
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE work.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE work.cards FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cards_tenant_isolation ON work.cards;
CREATE POLICY cards_tenant_isolation ON work.cards
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
