-- 0048 down — drop the causation depth column.
--
-- The constraint comes off with the column, but is dropped explicitly first so
-- a partially applied down leaves no constraint naming a column that is gone.
--
-- Losing the values is correct rather than merely acceptable: depth only has
-- meaning to the automation engine, and an engine reading a database without
-- this column treats every event as depth 0 — the same default the up
-- migration applies. Rolling back makes chains restart their counter, which is
-- the pre-0048 behaviour and is safe because the engine is not running on a
-- database that has been rolled back past its own schema.

ALTER TABLE platform.outbox
  DROP CONSTRAINT IF EXISTS outbox_causation_depth_sane;

ALTER TABLE platform.outbox
  DROP COLUMN IF EXISTS causation_depth;
