-- Revert 0009 — card detail.
--
-- Children first, then the indexes 0008's tables gained here. Dropping the
-- indexes last matters: the composite foreign keys above point at them, and
-- Postgres refuses to drop an index a constraint depends on.

DROP TABLE IF EXISTS work.card_comments;
DROP TABLE IF EXISTS work.custom_field_values;
DROP TABLE IF EXISTS work.custom_field_defs;
DROP TABLE IF EXISTS work.checklist_items;
DROP TABLE IF EXISTS work.checklists;
DROP TABLE IF EXISTS work.card_labels;
DROP TABLE IF EXISTS work.labels;

DROP INDEX IF EXISTS work.cards_org_project_id_key;
DROP INDEX IF EXISTS work.cards_org_id_key;
