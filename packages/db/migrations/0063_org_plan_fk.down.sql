-- Reverses 0063.
--
-- The constraint comes off BEFORE the seeded rows go, or the DELETE is refused
-- by the very foreign key this migration added — and the refusal would name
-- identity.orgs, sending the reader to look for a data problem in a table this
-- migration only constrained.
--
-- Dropping the constraint leaves any `plan_id = 'pro'` dangling, which is
-- precisely the pre-0063 state: a free text column with no referent. Restoring
-- that is what reversing this migration means.

ALTER TABLE identity.orgs DROP CONSTRAINT IF EXISTS orgs_plan_id_fk;

DROP INDEX IF EXISTS identity.orgs_plan_id_idx;

DELETE FROM billing.plans WHERE id IN ('free', 'pro');
