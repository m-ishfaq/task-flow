-- `orgs_self_read` (0004) still hard-coded `m.status = 'active'`, from
-- before a suspended membership was a state this codebase distinguished
-- from "never a member" at all. `org.service.ts`'s `listMyOrgs` was fixed
-- to report a suspended membership rather than silently omitting it (see
-- that function's own comment — "narrowing to 'active' used to happen
-- here... a suspended membership was indistinguishable from no membership
-- at all"), but its `INNER JOIN` against `identity.orgs` still runs inside
-- `withUserScope`, where THIS policy is what actually admits the org row.
-- With the org row invisible under RLS for a suspended membership, the
-- join silently drops it regardless of what the app-level query intends —
-- found by CI (`tenancy.service.test.ts`'s "reports a suspended membership
-- rather than omitting it"), not by the change that introduced the gap.
--
-- `resolveOrgMembership` (`resolve.ts`) is unaffected: it throws on a
-- non-active membership BEFORE it ever queries `identity.orgs`, so this
-- widening never changes what that function admits — it only fixes the
-- one caller, `listMyOrgs`, that genuinely needs to see the org row for a
-- suspended membership.

DROP POLICY IF EXISTS orgs_self_read ON identity.orgs;
CREATE POLICY orgs_self_read ON identity.orgs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM identity.memberships m
       WHERE m.org_id = identity.orgs.id
         AND m.status IN ('active', 'suspended')
         AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
  );
