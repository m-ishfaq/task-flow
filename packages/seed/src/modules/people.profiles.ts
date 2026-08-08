import { createEvent } from '@taskflow/events';
import {
  membershipProfileUpdated,
  reportingLineChanged,
} from '@taskflow/api/events/people';
import { roleGrants } from '@taskflow/policy';
import { department, jobTitle, oooMessage, type PersonName } from '../corpus.js';
import type { SeedContext } from '../context.js';
import type { Rng } from '../rng.js';
import type { PeopleMix } from '../profiles.js';
import { defineSeedModule } from '../registry.js';
import { daysAfter, daysBefore, envelopeFor, latest } from '../support.js';
import { orgsModule, type SeededMembership, type SeededOrg } from './tenancy.orgs.js';

/**
 * People — personal profiles and the org-scoped membership half (Phase 11.5).
 *
 * This module writes the two tables the whole phase exists for, and they need
 * different treatment in the one way that matters here:
 *
 * ## `people.profiles` is global; `people.membership_profiles` is tenant-scoped
 *
 * The personal profile has no `org_id` and no RLS (migration 0030's header
 * argues why), so its rows are written with the org scope CLEARED, exactly as
 * `identity.users` — the other no-tenant table — already does. One row per
 * USER, deduplicated across orgs: the profile is true of the person in every
 * org, and a user in two orgs must not produce two rows for `people.profiles`'
 * primary key.
 *
 * The membership half is an ordinary tenant table with the ordinary RLS, so
 * every row is written inside `ctx.orgScope(org.id)` — and that scope is what
 * makes the composite manager FK reachable at all, since RLS would otherwise
 * filter the row out before the database ever saw it.
 *
 * ## The org chart is cycle-free BY CONSTRUCTION, not by checking
 *
 * A manager is drawn from the memberships that appear EARLIER in the org
 * plan's `members` array. Every edge therefore runs from a later plan index
 * to an earlier one — a strict partial order — so a cycle is not merely
 * detected and refused (the service's job, `reporting.service.ts`), it
 * cannot be expressed. The same rule closes the two database-level traps for
 * free: the manager is never the member themself (`<> user_id` CHECK) and is
 * always a member of THIS org (the composite FK), because both follow from
 * "an earlier entry in the same org's plan".
 *
 * Candidates are further restricted by CAPABILITY rather than role name —
 * `roleGrants(role, 'member:read')`, the same discipline docs.spaces uses —
 * so a guest never manages anyone: a guest's role grants nothing (asserted
 * in packages/policy's decide.test.ts), and a fixture where the person who
 * cannot read the directory nonetheless appears in the org chart would read
 * as a bug in the same way a page no one could have created does.
 *
 * ## The owner reports to nobody — that is the root of the tree
 *
 * Index zero has no earlier entries, so no draw can give the owner a
 * manager. A fixture with a report above the owner is a row the product
 * could not have produced (the service would refuse the cycle or the admin
 * would have no one to set it to), and it is exactly the kind of impossible
 * row these modules exist not to invent.
 *
 * ## Which events, and why two of them and not three
 *
 * `membership_profile.updated` (actor: the member themself — §3.6 makes
 * title/department self-service) and `reporting_line.changed` (actor: the
 * org owner — §3.6 makes setting a reporting line an admin operation) are
 * org-scoped, so they buffer normally and `platform.audit` writes them to
 * the outbox like every other structural event. `profile.updated` is
 * deliberately NOT emitted here: its envelope carries `SYSTEM_ORG`, and
 * `platform.outbox`'s RLS cannot hold a SYSTEM_ORG row (migration 0006) —
 * the identical reason `apps/api/src/people/events.ts` routes that event
 * through the in-memory bus instead of the outbox. A seeder that emitted it
 * would be the one path in the whole graph that tripped over that boundary.
 */

/* Valid IANA names. The API validates a timezone against the SAME list
   profile.service.ts uses — Intl.supportedValuesOf('timeZone') — so the
   pool is filtered through it at load rather than held static: a name this
   runtime's ICU does not know would be refused by the service on this
   runtime, and the difference is real (a small-ICU Node build omits UTC
   and Asia/Kolkata from the list). Static was tempting for cross-version
   reproducibility, but a seeded timezone the API would refuse is a row the
   product could not have stored, which is the stronger property; the
   candidate list below is the deterministic part and the filter only ever
   removes. */
const IANA_ZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));

const TIMEZONES: readonly string[] = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
].filter((zone) => IANA_ZONES.has(zone));

/* One weekly window each, drawn whole: start/end/days travel together because
   that is how the product writes them (§3.4's window is one value, and a
   window with an end but no start is refused at the API). All run forward,
   matching `profiles_working_window`. */
const WORKING_WINDOWS = [
  { start: '09:00:00', end: '17:00:00', days: [1, 2, 3, 4, 5] },
  { start: '08:30:00', end: '16:30:00', days: [1, 2, 3, 4, 5] },
  { start: '10:00:00', end: '18:00:00', days: [1, 2, 3, 4, 5] },
  { start: '09:00:00', end: '13:00:00', days: [1, 2, 3, 4, 5] },
  { start: '12:00:00', end: '20:00:00', days: [1, 2, 3, 4, 5] },
  { start: '09:00:00', end: '17:00:00', days: [1, 2, 3, 4, 5, 6] },
] as const;

export interface SeededPersonProfile {
  readonly userId: string;
  readonly displayName: string | null;
  readonly timezone: string | null;
  readonly workingHoursStart: string | null;
  readonly workingHoursEnd: string | null;
  readonly workingDays: readonly number[] | null;
  readonly oooFrom: Date | null;
  readonly oooUntil: Date | null;
  readonly oooMessage: string | null;
}

export interface SeededMembershipProfile {
  readonly orgId: string;
  readonly userId: string;
  readonly managerUserId: string | null;
  readonly jobTitle: string | null;
  readonly department: string | null;
}

export interface PeopleOutput {
  readonly profiles: readonly SeededPersonProfile[];
  readonly membershipProfiles: readonly SeededMembershipProfile[];
}

/** A user about to get a personal profile — id plus the name it may display. */
interface UserForProfile {
  readonly id: string;
  readonly name: PersonName;
}

export const peopleModule = defineSeedModule({
  name: 'people.profiles',
  requires: [orgsModule],
  tables: ['people.profiles', 'people.membership_profiles'],

  async seed(ctx): Promise<PeopleOutput> {
    const rng = ctx.rng.fork('people.profiles');
    const { orgs } = ctx.use(orgsModule);
    const mix = ctx.profile.people;

    /* One row per USER, not per membership. Two passes over the same
       membership list would give a two-org user two rows and trip
       `profiles_pkey`; the map is what dedupes. */
    const usersById = new Map<string, UserForProfile>();
    for (const org of orgs) {
      for (const membership of org.memberships) {
        usersById.set(membership.user.id, { id: membership.user.id, name: membership.user.name });
      }
    }
    const profiles: SeededPersonProfile[] = [];
    const profileRows: unknown[][] = [];
    const usersWithProfiles = new Set<string>();
    for (const user of usersById.values()) {
      if (!rng.chance(mix.profileRate)) continue;
      const profile = personalProfile(rng, ctx, user, mix);
      profiles.push(profile);
      usersWithProfiles.add(user.id);
      /* A profile that shows OOO RIGHT NOW was last touched when the OOO
         began (an active window is set in the same update); anything else
         was set somewhere in history. Either way it is a past date, and the
         row never claims a future write. */
      const updatedAt =
        profile.oooFrom !== null && profile.oooFrom.getTime() < ctx.now.getTime()
          ? profile.oooFrom
          : daysBefore(ctx.now, rng.int(1, 120));
      profileRows.push([
        profile.userId,
        profile.displayName,
        profile.timezone,
        profile.workingHoursStart,
        profile.workingHoursEnd,
        profile.workingDays,
        profile.oooFrom,
        profile.oooUntil,
        profile.oooMessage,
        updatedAt,
      ]);
    }

    /* One global line, not one per org: the personal profile is a fact about
       the PERSON, not the membership, so a per-org count would print the same
       total under every org heading. The per-org lines below count only the
       org-scoped rows. */
    ctx.log(
      `people.profiles: ${String(usersWithProfiles.size)}/${String(usersById.size)} users have a personal profile`,
    );

    /* No org scope, on purpose: the table has no RLS and no org_id, exactly
       like identity.users — setting a scope here would be a lie, and the
       insert's row-count guard would have nothing to catch because no policy
       is filtering anything. */
    await ctx.db.insert(
      'people.profiles',
      [
        'user_id',
        'display_name',
        'timezone',
        'working_hours_start',
        'working_hours_end',
        'working_days::smallint[]',
        'ooo_from',
        'ooo_until',
        'ooo_message',
        'updated_at',
      ],
      profileRows,
    );

    const membershipProfiles: SeededMembershipProfile[] = [];

    for (const org of orgs) {
      const rows: unknown[][] = [];
      const logs: string[] = [];
      let managerCount = 0;

      org.memberships.forEach((membership, index) => {
        if (!rng.chance(mix.membershipProfileRate)) return;

        const title = rng.chance(mix.jobTitleRate) ? jobTitle(rng, membership.role) : null;
        const dept = rng.chance(mix.departmentRate) ? department(rng) : null;
        const manager = pickManager(rng, org, index, mix.managerRate);
        if (manager !== null) managerCount += 1;

        /* A profile fact is a fact about when it was set — later than the org
           (nothing here may predate the tenant, docs.spaces' rule) and earlier
           than now, so it reads as history rather than as a boot-time write. */
        const setAt = latest(org.createdAt, daysBefore(ctx.now, rng.int(1, 90)));

        membershipProfiles.push({
          orgId: org.id,
          userId: membership.user.id,
          managerUserId: manager?.user.id ?? null,
          jobTitle: title,
          department: dept,
        });
        rows.push([org.id, membership.user.id, manager?.user.id ?? null, title, dept, setAt]);

        /* Self-service fields, actor = the member; the before-half is nulls
           because this is the row's first write, exactly as the service's own
           first `updateMembershipProfile` emits it. `changed` lists only the
           fields that actually landed. */
        const changed = [
          ...(title !== null ? ['jobTitle'] : []),
          ...(dept !== null ? ['department'] : []),
        ];
        if (changed.length > 0) {
          ctx.emit(
            createEvent(
              membershipProfileUpdated,
              {
                orgId: org.id,
                userId: membership.user.id,
                changed,
                before: { jobTitle: null, department: null },
                after: { jobTitle: title, department: dept },
              },
              envelopeFor(org.id, membership.user.id, setAt),
            ),
          );
        }

        /* An admin-only operation (§3.6), so the owner is the actor — the same
           reason tenancy.orgs makes the owner the inviter of everyone else. */
        if (manager !== null) {
          ctx.emit(
            createEvent(
              reportingLineChanged,
              {
                orgId: org.id,
                userId: membership.user.id,
                before: null,
                after: manager.user.id,
              },
              envelopeFor(org.id, org.owner.id, setAt),
            ),
          );
        }

        logs.push(membership.user.name.first);
      });

      await ctx.orgScope(org.id, async () => {
        await ctx.db.insert(
          'people.membership_profiles',
          [
            'org_id',
            'user_id',
            'manager_user_id',
            'job_title',
            'department',
            'updated_at',
          ],
          rows,
        );
      });

      ctx.log(
        `people.profiles: ${org.slug} — ${String(rows.length)} membership profiles ` +
          `(${String(managerCount)} with a manager)`,
      );
    }

    return { profiles, membershipProfiles };
  },
});

/**
 * One personal profile, field by field.
 *
 * `displayName` reuses the person's seeded NAME — 60% the full name, 40% the
 * first name alone, which is the mix a real directory shows ("Amara" next to
 * "Amara Okonkwo") — rather than inventing a second identity that disagrees
 * with their email. The OOO window is one of three shapes on purpose: an
 * ACTIVE window makes the directory badge and the profile header render "OOO
 * now", an UPCOMING one renders the scheduled state, and a PAST one exists
 * for the read path to answer "was OOO" without ever being shown as current.
 */
function personalProfile(
  rng: Rng,
  ctx: SeedContext,
  user: UserForProfile,
  mix: PeopleMix,
): SeededPersonProfile {
  const displayName =
    rng.chance(mix.displayNameRate) && rng.chance(mix.displayNameNicknameShare)
      ? user.name.first
      : user.name.full;

  const timezone = rng.chance(mix.timezoneRate) ? rng.pick(TIMEZONES) : null;

  let start: string | null = null;
  let end: string | null = null;
  let days: readonly number[] | null = null;
  if (rng.chance(mix.workingHoursRate)) {
    const window = rng.pick(WORKING_WINDOWS);
    start = window.start;
    end = window.end;
    days = window.days;
  }

  let oooFrom: Date | null = null;
  let oooUntil: Date | null = null;
  const message = rng.chance(mix.oooRate) ? oooMessage(rng) : null;
  if (message !== null) {
    if (rng.chance(mix.oooActiveShare)) {
      // Right now: started within the last fortnight, ends within the next.
      oooFrom = daysBefore(ctx.now, rng.int(1, 14));
      oooUntil = daysAfter(ctx.now, rng.int(1, 14));
    } else if (rng.chance(0.5)) {
      // Scheduled: entirely in the future — the state the profile header
      // renders as "OOO from <date>".
      oooFrom = daysAfter(ctx.now, rng.int(1, 30));
      oooUntil = daysAfter(oooFrom, rng.int(1, 30));
    } else {
      // Over: ended recently — history the read path must not call "now".
      // The bounds keep `from < until` by construction (from ≤ -30 days,
      // until ≥ -29 days... see the comment below).
      oooFrom = daysBefore(ctx.now, rng.int(30, 90));
      // Between 1 and 29 days ago: strictly AFTER `oooFrom` (which is at
      // least 30 days back) and before now.
      oooUntil = daysBefore(ctx.now, rng.int(1, 29));
    }
  }

  return {
    userId: user.id,
    displayName,
    timezone,
    workingHoursStart: start,
    workingHoursEnd: end,
    workingDays: days,
    oooFrom,
    oooUntil,
    oooMessage: message,
  };
}

/**
 * A manager for the membership at plan `index`, or null.
 *
 * Candidates are the memberships EARLIER in the plan order that hold
 * `member:read` — the capability asked rather than the role name compared,
 * so a future directory-visible role is picked up here without an edit, and
 * the guest is excluded by the same rule `decide.test.ts` already asserts.
 * The earlier-index restriction is what makes the graph acyclic, the self-
 * report CHECK unreachable, and the composite FK satisfiable, all at once
 * (see the file header).
 */
function pickManager(
  rng: Rng,
  org: SeededOrg,
  index: number,
  managerRate: number,
): SeededMembership | null {
  if (!rng.chance(managerRate)) return null;
  const candidates = org.memberships.filter(
    (membership, candidateIndex) =>
      candidateIndex < index && roleGrants(membership.role, 'member:read'),
  );
  if (candidates.length === 0) return null;
  return rng.pick(candidates);
}
