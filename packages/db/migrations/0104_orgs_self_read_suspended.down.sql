-- Restores 0004's original active-only `orgs_self_read` policy.

DROP POLICY IF EXISTS orgs_self_read ON identity.orgs;
CREATE POLICY orgs_self_read ON identity.orgs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM identity.memberships m
       WHERE m.org_id = identity.orgs.id
         AND m.status = 'active'
         AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );
