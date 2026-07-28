-- Reverses 0002.
--
-- Dropped in dependency order rather than with CASCADE. CASCADE would silently
-- take anything a later migration attached to these tables, and the whole point
-- of running up -> down -> up in CI is to find out that something depends on
-- this before a production rollback does.

DROP TABLE IF EXISTS identity.password_resets;
DROP TABLE IF EXISTS identity.email_verifications;
DROP TABLE IF EXISTS identity.refresh_tokens;
DROP TABLE IF EXISTS identity.sessions;
DROP TABLE IF EXISTS identity.users;
