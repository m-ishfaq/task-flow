-- Reverses 0064.
--
-- The table grant comes off before the schema USAGE: revoking USAGE first
-- would leave a SELECT privilege on a table whose schema the role can no
-- longer resolve — harmless in effect, but it leaves the catalog describing an
-- access path that does not exist, which is exactly the kind of half-state a
-- down migration is supposed to remove.

REVOKE SELECT ON people.profiles FROM taskflow_platform_admin;

REVOKE USAGE ON SCHEMA people FROM taskflow_platform_admin;

COMMENT ON TABLE people.profiles IS NULL;
