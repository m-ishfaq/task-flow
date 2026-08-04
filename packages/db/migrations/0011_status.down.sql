-- Revert 0011 — status and priority.
--
-- Cards first: the FK, the CHECK and the columns it added all have to go
-- before the table they reference can be dropped. Indexes on cards are
-- dropped automatically with their columns; the statuses table's own indexes
-- go automatically with the table.

DROP INDEX IF EXISTS work.cards_status_idx;

ALTER TABLE work.cards DROP CONSTRAINT IF EXISTS cards_status_fk;
ALTER TABLE work.cards DROP CONSTRAINT IF EXISTS cards_priority_valid;

ALTER TABLE work.cards DROP COLUMN IF EXISTS priority;
ALTER TABLE work.cards DROP COLUMN IF EXISTS status_id;

DROP TABLE IF EXISTS work.statuses;
