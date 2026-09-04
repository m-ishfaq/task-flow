-- Reverse of 0094.up.sql, in the opposite order: orgs first — the FK would
-- refuse deleting the plan row while any org still points at it — then the
-- row itself. Every org this migration moved onto 'trial' returns to NULL,
-- matching migration 0063's own "NULL means not on a plan" contract; nothing
-- here can tell an org 0094.up.sql moved apart from one an operator moved
-- there manually afterward, so both revert identically. That is the same
-- trade every other down.sql in this codebase makes.
UPDATE identity.orgs
   SET plan_id = NULL
 WHERE plan_id = 'trial';

DELETE FROM billing.plans WHERE id = 'trial';
