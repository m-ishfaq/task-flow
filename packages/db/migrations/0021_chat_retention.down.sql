-- Revert 0021 — retention, legal hold, and the guest marker.
--
-- Indexes go with their columns, so only the columns are named here.
--
-- What is lost, and it is worth being precise because one of these is not like
-- the others: retention WINDOWS and the guest marker are configuration and can
-- be re-entered. LEGAL HOLDS cannot. Dropping `held_at` discards the record of
-- which messages were preserved and since when — and unlike most lost
-- configuration, the consequence shows up later, when the next retention sweep
-- deletes messages that were under hold and nothing anywhere says they were.
--
-- `migrate:verify` runs up -> down -> up against `taskflow_test` routinely, so
-- this is safe there. Running it against a database holding real holds is not a
-- migration, it is a compliance incident.

DROP INDEX IF EXISTS chat.messages_retention_idx;
DROP INDEX IF EXISTS chat.messages_held_idx;
DROP INDEX IF EXISTS authz.tuples_guest_idx;

ALTER TABLE chat.messages
  DROP COLUMN IF EXISTS held_at,
  DROP COLUMN IF EXISTS held_by;

ALTER TABLE chat.channels
  DROP COLUMN IF EXISTS retention_days,
  DROP COLUMN IF EXISTS retention_hold;

ALTER TABLE authz.relationship_tuples
  DROP COLUMN IF EXISTS is_guest;
