-- 0041 down — reverse Phase 13 Wave 1.
--
-- Children before parents, the ordering tenancy-seed.ts's clearTenant already
-- documents: turn_issuance and participants both reference rtc.sessions
-- composite-with-org, so the sessions table cannot go first.
--
-- Policies and grants come off before the tables they name, so a partially
-- applied down leaves no policy pointing at a table that no longer exists.

DROP POLICY IF EXISTS turn_issuance_tenant_isolation ON rtc.turn_issuance;
DROP POLICY IF EXISTS participants_tenant_isolation ON rtc.participants;
DROP POLICY IF EXISTS sessions_tenant_isolation ON rtc.sessions;

REVOKE SELECT, INSERT, DELETE ON rtc.turn_issuance FROM taskflow_app;
REVOKE SELECT, INSERT, UPDATE ON rtc.participants  FROM taskflow_app;
REVOKE SELECT, INSERT, UPDATE ON rtc.sessions      FROM taskflow_app;

DROP TABLE rtc.turn_issuance;
DROP TABLE rtc.participants;
DROP TABLE rtc.sessions;

REVOKE USAGE ON SCHEMA rtc FROM taskflow_app;

-- The schema itself goes too. It carries no default privileges to revoke —
-- see the up migration's header on why that is deliberate.
DROP SCHEMA IF EXISTS rtc;
