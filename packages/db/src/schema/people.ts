import { sql } from 'drizzle-orm';
import { check, index, pgSchema, smallint, text, time, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity.js';

/**
 * People tables — profiles and org-scoped membership profiles
 * (PLAN.md §3.5; ai/phase-11.5-people.md §3.1, migration 0030 Wave 1,
 * migration 0031 Wave 2).
 *
 * As with the other schema files, this is the TypeScript MIRROR of the
 * migration and not its source. If the two disagree, the migration wins and
 * this file is the bug.
 *
 * The split is the one the plan's §3.1 argues for: `profiles` holds facts
 * true of the PERSON in every org (display name, timezone, working hours,
 * out-of-office) and has NO org_id and NO RLS — the same choice
 * `identity.users` already made (see migration 0030's header). `membership
 * profiles` holds facts true of a MEMBERSHIP (job title, department, who you
 * report to) and IS tenant-scoped with the ordinary RLS policy.
 *
 * `membershipProfiles.managerUserId` has no `references()` here for the same
 * reason `docs.pages.parentPageId` doesn't in `docs.ts`: the migration's real
 * constraints are COMPOSITE foreign keys — (org_id, user_id) → identity.
 * memberships (org_id, user_id) for the row itself, and (org_id,
 * manager_user_id) → identity.memberships (org_id, user_id) for the manager
 * — which keep both the profile and its manager inside the SAME org, and
 * Drizzle's single-column `references()` cannot express that. Reading
 * `managerUserId` here and concluding it is an ordinary FK is reading the
 * weaker half of the truth.
 */

const people = pgSchema('people');

/**
 * A person's own record — global, one row per person who has set at least
 * one field (migration 0030). No `org_id`: a display name is true of the
 * person, identically in every organization they belong to.
 */
export const profiles = people.table(
  'profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),

    displayName: text('display_name'),
    /** IANA zone name, e.g. 'America/Chicago'. Validated at the API, bounded here. */
    timezone: text('timezone'),
    /** One weekly window (§3.4) — `time` values interpreted in the profile's own timezone. */
    workingHoursStart: time('working_hours_start'),
    workingHoursEnd: time('working_hours_end'),
    /** ISO weekday ints 1..7 — e.g. [1,2,3,4,5] for Monday–Friday. */
    workingDays: smallint('working_days').array(),
    /** Null means "OOO starts now" — the §7 decision to allow scheduling in advance. */
    oooFrom: timestamp('ooo_from', { withTimezone: true }),
    oooUntil: timestamp('ooo_until', { withTimezone: true }),
    oooMessage: text('ooo_message'),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    // The CHECK constraints live only in the migration — Drizzle's builder
    // cannot express `end > start` pairs or array-containment checks more
    // readably than the raw SQL ones in 0030.
  ],
);

/**
 * Organizational profile facts — one row per (org, member) who has set at
 * least one field (migration 0031). The composite FKs to identity.memberships
 * are the migration's source; see the file-level note.
 */
export const membershipProfiles = people.table(
  'membership_profiles',
  {
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),
    managerUserId: uuid('manager_user_id'),
    jobTitle: text('job_title'),
    department: text('department'),
    /**
     * E.164 work number for click-to-call (migration 0039). Org-scoped rather
     * than on `profiles`, so a number given to one employer is not disclosed
     * to every other org the same person belongs to. The E.164 CHECK lives in
     * the migration.
     */
    workPhone: text('work_phone'),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('membership_profiles_manager_idx').on(table.orgId, table.managerUserId),
    check('membership_profiles_job_title_present', sql`length(btrim(${table.jobTitle})) > 0`),
    check('membership_profiles_job_title_length', sql`length(${table.jobTitle}) <= 120`),
    check('membership_profiles_department_present', sql`length(btrim(${table.department})) > 0`),
    check('membership_profiles_department_length', sql`length(${table.department}) <= 120`),
    // The tenant-isolation RLS policy, the composite FKs, and the
    // no-self-report CHECK all live only in the migration.
  ],
);
