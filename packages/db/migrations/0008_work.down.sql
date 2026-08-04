-- Revert 0008 — work: projects, boards, lists, cards.
--
-- Dropped children-first. The composite foreign keys make the order mandatory
-- rather than tidy: cards depend on lists, lists on boards, boards on projects.

DROP TABLE IF EXISTS work.cards;
DROP TABLE IF EXISTS work.lists;
DROP TABLE IF EXISTS work.boards;
DROP TABLE IF EXISTS work.projects;
