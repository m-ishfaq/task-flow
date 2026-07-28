-- Revert 0004 — tenancy.
--
-- Dropping a table removes the policies ON it, but not policies on OTHER tables
-- that REFERENCE it. `orgs_self_read` reads identity.memberships in its USING
-- expression, so Postgres records a dependency and refuses to drop memberships
-- while that policy exists — "cannot drop table identity.memberships because
-- other objects depend on it". It has to go first, explicitly.
--
-- That failure is exactly what `migrate:verify` (up -> down -> up) is for. It
-- appeared on the first run of this migration pair and would otherwise have
-- surfaced during a rollback, which is the worst moment to discover that a
-- rollback does not work.
--
-- Order matters for the rest too: team_members references teams, and both
-- reference orgs. CASCADE is deliberately NOT used — an unexpected dependent
-- object should fail this script loudly rather than be silently destroyed.

DROP POLICY IF EXISTS orgs_self_read ON identity.orgs;

DROP TABLE IF EXISTS identity.team_members;
DROP TABLE IF EXISTS identity.teams;
DROP TABLE IF EXISTS identity.memberships;
DROP TABLE IF EXISTS identity.orgs;
