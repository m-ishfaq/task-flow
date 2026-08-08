-- 0030 — people: schema + personal profiles, and the display-name expand step
-- (PLAN.md §3.5, §7; ai/phase-11.5-people.md §3.1, §3.2, §3.4, §3.5, Wave 1)
--
-- Phase 11.5, Wave 1. Three things here are load-bearing; read them before
-- touching anything.
--
-- 1. THE PEOPLE SCHEMA IS NEW, SO THE GRANT PAIRING IS NOT OPTIONAL.
--    0001 created the other schemas and their grants; `people` is created
--    here, and the same two lines 0001 spells out for each schema apply:
--    GRANT USAGE makes the namespace resolvable by taskflow_app (without it
--    the app gets "permission denied for schema" before RLS is ever
--    consulted), and ALTER DEFAULT PRIVILEGES means tables added to `people`
--    in LATER migrations (Wave 2's membership_profiles) get the app role's
--    DML automatically, the way every other schema already works.
--
-- 2. people.profiles HAS NO RLS — THE SAME CHOICE identity.users ALREADY MADE
--    (ai/phase-11.5-people.md §3.7). Nothing about a display name, a timezone,
--    or an out-of-office message is secret from other people in a shared org,
--    and the actual access boundary is which ROUTES exist, not which rows a
--    query can see: every write route here is self-scoped (the subject comes
--    from the verified token, never from an argument), so no row-level check
--    is doing work a route-level check is not already doing more legibly.
--    Adding RLS here would be defence that defends against nothing.
--
-- 3. THE BACKFILL IS AN EXPAND STEP, NOT A MIGRATION OF MEANING.
--    identity.users.display_name stays in place, still readable, and from the
--    moment this migration lands no NEW code writes it — the column becomes
--    auth's own record of a name, on its way out (§3.2's expand-migrate-
--    contract). The backfill copies every non-null name into people.profiles
--    so the read path can switch over atomically with this migration. The
--    DROP of the old column is Wave 3's separate migration, deliberately not
--    bundled here.
--
-- No new database role. Both tables are reached through the ordinary
-- taskflow_app connection, exactly like identity.users — nothing async
-- touches people (Wave 2's membership_profiles will be the one org-scoped
-- table, and it needs only the app role + RLS).

CREATE SCHEMA IF NOT EXISTS people;

GRANT USAGE ON SCHEMA people TO taskflow_app;

ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA people
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskflow_app;

ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA people
  GRANT USAGE, SELECT ON SEQUENCES TO taskflow_app;

-- --------------------------------------------------------------------------
-- people.profiles — the PERSON's own record, global, with no org_id.
--
-- One row per person who has set at least one field, populated lazily like
-- identity.notification_prefs (absent row = every field null; the read path
-- returns nulls and the UI renders an empty state). No migration-time row per
-- user — the backfill below is display_name ONLY, because that column already
-- exists and needs to move; nothing else has a source to backfill from.
--
--   timezone            IANA zone name ('America/Chicago'). The CHECK bounds
--                       length only — IANA names cannot be validated in SQL;
--                       the API validates against
--                       Intl.supportedValuesOf('timeZone') so a bad name is
--                       a readable validation error, not a stored typo.
--   working_hours_*     One weekly window (§3.4), NOT a per-day schedule:
--                       start/end as `time` (no date, interpreted in the
--                       profile's own timezone) plus a weekday set. A CHECK
--                       rejects an overnight window (end <= start) rather
--                       than storing a window every consumer would read
--                       backwards.
--   ooo_from/ooo_until  OOO can be SCHEDULED IN ADVANCE (§7 decision):
--                       ooo_from null means "starts now", matching the
--                       simpler original shape; the CHECK keeps the window
--                       from running backwards. "Is this person OOO right
--                       now" is computed at read time, never stored.
-- --------------------------------------------------------------------------
CREATE TABLE people.profiles (
  user_id              uuid        PRIMARY KEY REFERENCES identity.users (id) ON DELETE CASCADE,

  display_name         text,
  timezone             text,
  working_hours_start  time,
  working_hours_end    time,
  working_days         smallint[],   -- ISO weekday ints 1..7, e.g. {1,2,3,4,5}
  ooo_from             timestamptz,
  ooo_until            timestamptz,
  ooo_message          text,

  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- A display name that renders as an empty gap is a bug in the UI that a
  -- stored value would make permanent; the same present-and-non-blank pattern
  -- migration 0019 already used for identity.users.display_name.
  CONSTRAINT profiles_display_name_present CHECK (
    display_name IS NULL OR length(btrim(display_name)) > 0
  ),
  CONSTRAINT profiles_display_name_length CHECK (
    display_name IS NULL OR length(display_name) <= 80
  ),
  CONSTRAINT profiles_timezone_length CHECK (
    timezone IS NULL OR length(timezone) <= 64
  ),
  -- See the header note on working hours. Both columns nullable and
  -- independent: a person can set a timezone with no window at all.
  CONSTRAINT profiles_working_window CHECK (
    working_hours_start IS NULL
    OR working_hours_end IS NULL
    OR working_hours_end > working_hours_start
  ),
  CONSTRAINT profiles_working_days_valid CHECK (
    working_days IS NULL
    OR working_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
  ),
  -- ooo_from is OPTIONAL (null = starts now). A window set both ways must
  -- run forward; the read-time "is OOO" rule is the same either way.
  CONSTRAINT profiles_ooo_window CHECK (
    ooo_from IS NULL OR ooo_until IS NULL OR ooo_from < ooo_until
  ),
  CONSTRAINT profiles_ooo_message_present CHECK (
    ooo_message IS NULL OR length(btrim(ooo_message)) > 0
  ),
  CONSTRAINT profiles_ooo_message_length CHECK (
    ooo_message IS NULL OR length(ooo_message) <= 200
  )
);

-- The expand step: move every existing non-null display name into the new
-- home so the read path can switch over in the same release. Null names stay
-- null — no row is created for a person who never set one.
INSERT INTO people.profiles (user_id, display_name, updated_at)
SELECT id, display_name, now()
FROM identity.users
WHERE display_name IS NOT NULL;
