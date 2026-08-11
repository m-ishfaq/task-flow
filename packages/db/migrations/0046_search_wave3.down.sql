-- 0046 down — reverse Phase 8 Wave 3.
--
-- Policies and grants come off before the table they name, so a partially
-- applied down leaves no policy pointing at a table that no longer exists
-- (the ordering 0041's down documents and 0045's repeats).

DROP POLICY IF EXISTS searches_tenant_isolation ON search.searches;
REVOKE SELECT, INSERT, UPDATE, DELETE ON search.searches FROM taskflow_app;
DROP TABLE IF EXISTS search.searches;

-- Narrowing entity_type back to Wave 2's four kinds. The DELETE is not
-- optional and not a convenience: re-adding the constraint is VALIDATED
-- against existing rows, so a database that has indexed even one transcript
-- would fail this migration with `check constraint "documents_entity_type_check"
-- is violated by some row` and leave the down half-applied.
--
-- Deleting projection rows is safe in a way deleting source rows never would
-- be: search.documents is a PROJECTION (§4 of the spec, and 0045's header) —
-- the backfill script rebuilds it from `comms.transcripts`, which this does
-- not touch. Rolling back loses an index entry, never a transcript.
DELETE FROM search.documents WHERE entity_type = 'transcript';

ALTER TABLE search.documents
  DROP CONSTRAINT documents_entity_type_check;

ALTER TABLE search.documents
  ADD CONSTRAINT documents_entity_type_check
    CHECK (entity_type IN ('card', 'message', 'page', 'comment'));
