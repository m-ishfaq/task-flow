-- 0046 — Phase 8 Wave 3: transcripts join the projection, and saved searches
-- (ai/phase-8-search.md §3.2, §5, and 0045's own "transcripts widen the CHECK
-- in Wave 3" note).
--
-- Two changes, one wave. They share nothing structurally; they are together
-- because they are the two things Wave 3 needs from the database, and a wave
-- that ships as one migration is one thing to roll back.

-- ==========================================================================
-- 1. `transcript` joins search.documents' entity_type
-- ==========================================================================
--
-- 0045 closed `entity_type` to Wave 2's four kinds and said transcripts would
-- widen the CHECK "the way 0027 widened notifications' kind — one constraint
-- swap, no enum ceremony". This is that swap.
--
-- ## What a transcript document holds, and what it deliberately does not
--
-- `body` is `comms.transcripts.text`, which is ALREADY REDACTED — that table
-- has no `raw_text` column at all, and 0033's header explains why: redaction
-- runs before the insert, so there is no unredacted form anywhere for this
-- projection to accidentally copy. Search indexing a transcript therefore
-- cannot widen PII exposure beyond what the transcript row already is.
--
-- `title` stays NULL. The obvious title — who the call was with — is a phone
-- number, and 0033 stores counterparties as a BLIND INDEX precisely so a
-- number is not readable from a row. Putting one in a plaintext `title`
-- column with a trigram index over it would undo that in the one table built
-- for substring matching.
--
-- `author_id` also stays NULL. A transcript has no author: it is what a
-- machine heard two people say, and naming either of them as its author would
-- make `author = @me` answer a question about a recording's ownership that
-- nobody asked.
--
-- ## The permission is not derived from the parent, unlike every other kind
--
-- Cards, messages and pages resolve a per-hit Target from a parent row. A
-- transcript's authorization question is `recording:read` with NO target —
-- Admin-and-Owner by role alone, exactly as `getTranscript` asks it
-- (transcript.service.ts: "being allowed to see that a call happened is a
-- different question from being allowed to read what was said"). The route's
-- per-hit loop asks the same question the transcript route does, so search can
-- never be the cheaper door to a transcript than the telephony surface is.
ALTER TABLE search.documents
  DROP CONSTRAINT documents_entity_type_check;

ALTER TABLE search.documents
  ADD CONSTRAINT documents_entity_type_check
    CHECK (entity_type IN ('card', 'message', 'page', 'comment', 'transcript'));

-- ==========================================================================
-- 2. search.searches — saved searches (§3.2)
-- ==========================================================================
--
-- A NEW resource, not a widening of work.views. A view is board-scoped by
-- `board_id` and its whole shape (type, group_by, sort_by, visible_columns)
-- describes how to render ONE board. A saved search spans every product and
-- renders as a result list; folding it into views would mean a board_id column
-- that is NULL for half the rows and a type CHECK that admits a fourth value
-- no board renderer knows — the shape of a table doing two jobs badly.
--
-- ## The query is stored as TQL TEXT, not as the AST
--
-- `work.views.filter` stores the AST because the VISUAL BUILDER edits the AST
-- — its UI has no text form to preserve. A saved search is created by someone
-- typing TQL into a text box, and `format(parse(text))` is not the identity:
-- it normalizes spacing, quoting and clause order. Storing the tree and
-- re-formatting it on read would hand a user back a reworded version of the
-- query they saved, which reads as the system having edited their work.
--
-- Both storage forms are equally UNRESOLVED, which is the property §3.2
-- actually requires: `@me` and `-7d` survive as the literal characters the
-- user typed, so a shared "assigned to me" search means "assigned to whoever
-- is running it" (§1.5, and 0014's own header on the same trap for views).
--
-- Storing text costs one parse per read. That parse is not new work: the
-- search route already parses on every query, because the SERVER is the only
-- TQL parser (§2.7) — a stored string is exactly as untrusted as a typed one,
-- and gets exactly the same treatment.
--
-- The 1,000-character cap is the same bound `TqlQuery` applies at the route.
-- It is repeated here rather than left to the service because a column with no
-- length limit is one a future caller fills, and the trigram-indexed sibling
-- table next door is what makes long text expensive.
CREATE TABLE search.searches (
  id          uuid        PRIMARY KEY,
  org_id      uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  name        text        NOT NULL,

  -- The TQL source, verbatim. Re-parsed and re-validated on every read; a
  -- string that no longer parses is reported as a BROKEN saved search, never
  -- as a 500 from the search page (the `parseStoredFilter` precedent in
  -- view.service.ts).
  query       text        NOT NULL,

  -- Shared searches are org furniture for every member; private ones are
  -- visible only to their author. As with views, the read policy lives in the
  -- service: RLS answers the TENANT question, and two members of one org are
  -- on the same side of that boundary.
  is_shared   boolean     NOT NULL DEFAULT false,

  -- ON DELETE CASCADE for the reason 0014 gives: a departed member's private
  -- searches are visible to nobody and editable by nobody, so keeping them is
  -- keeping garbage. Shared ones go too, deliberately — see the down file.
  created_by  uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT searches_name_present  CHECK (length(btrim(name)) > 0),
  CONSTRAINT searches_name_length   CHECK (length(name) <= 60),

  -- An empty query is not a saved search, it is a saved nothing: the route
  -- answers an empty tree with zero results (§2.7), so storing one creates a
  -- named entry that can only ever show nothing.
  CONSTRAINT searches_query_present CHECK (length(btrim(query)) > 0),
  CONSTRAINT searches_query_length  CHECK (length(query) <= 1000)
);

-- One shared search of a given name per org, case-insensitive; and one private
-- search of a given name per person. Two people may each keep a "Mine"; two
-- shared entries with the same name are indistinguishable to everyone else.
-- Both mirror views' partial-unique pair exactly (0014).
CREATE UNIQUE INDEX searches_org_shared_name_key
  ON search.searches (org_id, lower(name)) WHERE is_shared;

CREATE UNIQUE INDEX searches_org_private_name_key
  ON search.searches (org_id, created_by, lower(name)) WHERE NOT is_shared;

-- The list query: every shared search plus the caller's own, newest name-order
-- resolved in the service. Leads with org_id per the RLS convention.
CREATE INDEX searches_org_owner_idx ON search.searches (org_id, created_by);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, repeated verbatim from
-- packages/db/src/rls.ts, exactly as search.documents next door.
-- --------------------------------------------------------------------------
ALTER TABLE search.searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE search.searches FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS searches_tenant_isolation ON search.searches;
CREATE POLICY searches_tenant_isolation ON search.searches
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Explicit, because the `search` schema has NO ALTER DEFAULT PRIVILEGES —
-- 0045's deliberate choice, restated here because it is exactly the situation
-- 0036 had to correct elsewhere: in a schema WITH default privileges this
-- GRANT would be decoration over access the app role already had, and the
-- absence of a grant would not mean the absence of access.
--
-- taskflow_search is given NOTHING here. It claims outbox events; a saved
-- search is written by a user through a route under taskflow_app, and the
-- indexer has no reason to know this table exists.
GRANT SELECT, INSERT, UPDATE, DELETE ON search.searches TO taskflow_app;
