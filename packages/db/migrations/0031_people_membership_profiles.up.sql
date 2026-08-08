-- 0031 — people: membership profiles, the org-scoped half of the profile
-- (PLAN.md §3.5; ai/phase-11.5-people.md §3.1, §3.6, §3.7, Wave 2)
--
-- Phase 11.5, Wave 2. The facts that are true of a MEMBERSHIP rather than of
-- a person — job title, department, who you report to — with the same
-- containment the plan's §3.1 argues for. Three things are load-bearing:
--
-- 1. THE COMPOSITE FOREIGN KEYS ARE THE ENTIRE ORG-CHART SAFETY ARGUMENT.
--    `identity.memberships` carries the unique index (org_id, user_id)
--    (migration 0004) precisely so a child row can be constrained to
--    reference a membership that actually exists IN THAT ORG. `manager_
--    user_id` naming someone who is a member of a DIFFERENT org is refused
--    by the database, not caught by a service-layer lookup someone could
--    forget to write — the identical argument CLAUDE.md makes for Work's
--    card hierarchy and Docs' page tree.
--
--    `ON DELETE SET NULL` on the manager FK (rather than CASCADE) is
--    deliberate: a manager leaving the org orphans their reports'
--    `manager_user_id` back to null, but must not delete the reports' own
--    job-title/department rows. The profile row itself cascades with its
--    membership.
--
-- 2. NO SELF-REPORT IS THE ONE CHECK A SERVICE CANNOT REPLACE.
--    `manager_user_id <> user_id` is expressible in SQL, so it is a CHECK.
--    The TRANSITIVE case — A manages B, B manages A — is not expressible in
--    a constraint language, and is closed by the service's cycle walk in
--    apps/api/src/people/reporting.service.ts instead (the same split
--    movePage already uses for the page tree).
--
-- 3. THIS TABLE GETS THE ORDINARY TENANT RLS, UNLIKE people.profiles
--    (ai/phase-11.5-people.md §3.7). The difference is which routes touch
--    it: `reportingLine.set` is callable by an ADMIN naming another member
--    as the subject, so its queries are not self-scoped, and `withOrgScope`
--    plus RLS is what stops an admin of org A from naming org B's
--    membership rows at all — the same guarantee every other tenant table
--    relies on.

CREATE TABLE people.membership_profiles (
  org_id           uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  manager_user_id  uuid,
  job_title        text,
  department       text,
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT membership_profiles_pk
    PRIMARY KEY (org_id, user_id),

  CONSTRAINT membership_profiles_membership_fk
    FOREIGN KEY (org_id, user_id)
      REFERENCES identity.memberships (org_id, user_id) ON DELETE CASCADE,

  CONSTRAINT membership_profiles_manager_fk
    FOREIGN KEY (org_id, manager_user_id)
      REFERENCES identity.memberships (org_id, user_id) ON DELETE SET NULL,

  CONSTRAINT membership_profiles_no_self_report
    CHECK (manager_user_id IS NULL OR manager_user_id <> user_id),

  CONSTRAINT membership_profiles_job_title_present CHECK (
    job_title IS NULL OR length(btrim(job_title)) > 0
  ),
  CONSTRAINT membership_profiles_job_title_length CHECK (
    job_title IS NULL OR length(job_title) <= 120
  ),
  CONSTRAINT membership_profiles_department_present CHECK (
    department IS NULL OR length(btrim(department)) > 0
  ),
  CONSTRAINT membership_profiles_department_length CHECK (
    department IS NULL OR length(department) <= 120
  )
);

-- "Who reports to whom, in this org" — the query every org chart render and
-- every direct-reports list issues.
CREATE INDEX membership_profiles_manager_idx
  ON people.membership_profiles (org_id, manager_user_id);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — the generated form, as every other tenant table.
-- --------------------------------------------------------------------------

ALTER TABLE people.membership_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE people.membership_profiles FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS membership_profiles_tenant_isolation ON people.membership_profiles;
CREATE POLICY membership_profiles_tenant_isolation ON people.membership_profiles
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
