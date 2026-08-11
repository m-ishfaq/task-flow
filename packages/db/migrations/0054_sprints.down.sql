-- 0054 down — sprints.

ALTER TABLE work.cards DROP CONSTRAINT IF EXISTS cards_sprint_fk;
ALTER TABLE work.cards DROP COLUMN IF EXISTS sprint_id;

DROP TABLE IF EXISTS work.sprints;
