import { and, desc, eq, isNull, schema, withUserScope } from '@taskflow/db';
import { readNotificationPrefsTimezone } from '@taskflow/db';
import { errors, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { createEvent, type EventBus } from '@taskflow/events';
import { SYSTEM_ORG } from '../identity/identity.service.js';
import * as identityEvents from '../identity/events.js';
import { profileUpdated } from './events.js';
import { updateMembershipProfile } from './membership.service.js';

/**
 * A person's own profile — the canonical home of the display name, timezone,
 * working hours and out-of-office state (ai/phase-11.5-people.md §3.1–§3.5,
 * Wave 1).
 *
 * Two structural choices shape everything here:
 *
 * ## `people.profiles` has no org and no RLS, same as `identity.users`
 *    (migration 0030's header explains why: every write route is
 *    self-scoped, the subject comes from the verified token, never from an
 *    argument). Reads/writes run in `withUserScope(userId, ...)`, not
 *    `withGlobalScope` — the latter is restricted by lint to the identity
 *    module (§2.2; see `packages/config/eslint/security.js` and
 *    `.semgrep/taskflow.yml`'s `global-scope-outside-identity` rule), and
 *    `withUserScope` is the already-precedented tool outside it
 *    (`apps/api/src/platform/push.ts`, `notifications.ts`): it sets
 *    `app.user_id` and clears `app.org_id`, which is behaviourally identical
 *    to `withGlobalScope` for two tables with no RLS policy to consult either
 *    variable, without reaching for the escape hatch a non-identity module
 *    should not have. This is also why `profile.get`/`profile.update` are
 *    `selfRoute`s that must answer with no org selected — the account page is
 *    reachable before an org exists, the same contract `auth.me` already
 *    holds.
 *
 * ## The timezone fallback is a READ, never a write (§3.3).
 *    `people.profiles.timezone` starts null for everyone; `getProfile`
 *    resolves the profile's own value first, then — only when that is unset —
 *    `identity.notification_prefs.timezone` IF that column and a row for this
 *    user exist (Phase 9's quiet-hours field, probed at runtime because it
 *    may or may not exist in a given database — see
 *    `@taskflow/db`'s `readNotificationPrefsTimezone`), then null. The UI
 *    prompts for a timezone; nothing ever invents one, and nothing here
 *    writes back to `notification_prefs`.
 */

export interface ProfileView {
  readonly email: string;
  readonly displayName: string | null;
  readonly timezone: string | null;
  /** 'HH:mm:ss' in the profile's own timezone — Postgres `time` serialized as text. */
  readonly workingHoursStart: string | null;
  readonly workingHoursEnd: string | null;
  /** ISO weekday ints 1..7. */
  readonly workingDays: readonly number[] | null;
  readonly oooFrom: Date | null;
  readonly oooUntil: Date | null;
  readonly oooMessage: string | null;
  readonly createdAt: Date;
  readonly emailVerified: boolean;
}

/** The caller's own profile, merged from identity.users + people.profiles. */
export async function getProfile(userId: UserId): Promise<ProfileView> {
  return withUserScope(userId, async (tx) => {
    const users = await tx
      .select({
        email: schema.users.email,
        createdAt: schema.users.createdAt,
        emailVerifiedAt: schema.users.emailVerifiedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    const user = users[0];
    if (!user) throw errors.notFound();

    const rows = await tx
      .select({
        displayName: schema.profiles.displayName,
        timezone: schema.profiles.timezone,
        workingHoursStart: schema.profiles.workingHoursStart,
        workingHoursEnd: schema.profiles.workingHoursEnd,
        workingDays: schema.profiles.workingDays,
        oooFrom: schema.profiles.oooFrom,
        oooUntil: schema.profiles.oooUntil,
        oooMessage: schema.profiles.oooMessage,
      })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .limit(1);

    const profile = rows[0];

    /* The §3.3 fallback chain, left to right, each rung only when the
       previous one is unset. The middle rung is a runtime existence check —
       see readNotificationPrefsTimezone's own header. */
    const timezone = profile?.timezone ?? (await readNotificationPrefsTimezone(userId));

    return {
      email: user.email,
      displayName: profile?.displayName ?? null,
      timezone: timezone ?? null,
      workingHoursStart: profile?.workingHoursStart ?? null,
      workingHoursEnd: profile?.workingHoursEnd ?? null,
      workingDays: profile?.workingDays ?? null,
      oooFrom: profile?.oooFrom ?? null,
      oooUntil: profile?.oooUntil ?? null,
      oooMessage: profile?.oooMessage ?? null,
      createdAt: user.createdAt,
      emailVerified: user.emailVerifiedAt !== null,
    };
  });
}

/**
 * The patch — every field optional, and ABSENT is different from `null`.
 *
 * `null` clears a field (a real operation: removing a name, ending OOO).
 * Absent leaves it alone. Presence is read as `!== undefined` — never `??`,
 * which would treat `{ oooUntil: null }` as "not supplied" and make ending
 * OOO inexpressible, the identical discipline `apps/web`'s `useUpdateCard`
 * already established (CLAUDE.md, Phase 3). zod's `.strict()` output never
 * carries explicit `undefined` (absent keys are stripped), so `!== undefined`
 * IS presence; the explicit `| undefined` in the types exists only to keep
 * the zod output assignable under `exactOptionalPropertyTypes`.
 *
 * Dates arrive as ISO strings; the service converts to `Date` after
 * validation.
 */
export interface ProfilePatch {
  readonly displayName?: string | null | undefined;
  readonly timezone?: string | null | undefined;
  readonly workingHoursStart?: string | null | undefined;
  readonly workingHoursEnd?: string | null | undefined;
  readonly workingDays?: readonly number[] | null | undefined;
  readonly oooFrom?: string | null | undefined;
  readonly oooUntil?: string | null | undefined;
  readonly oooMessage?: string | null | undefined;
  /** Wave 2 — self-service on one's OWN membership (ai/phase-11.5-people.md §3.6). */
  readonly jobTitle?: string | null | undefined;
  readonly department?: string | null | undefined;
  /** E.164 work number, org-scoped like the two above (migration 0039). */
  readonly workPhone?: string | null | undefined;
}

export interface PeopleActor {
  readonly userId: UserId;
  /** Null when no org is selected — the account page state. */
  readonly orgId: OrgId | null;
  readonly requestId: RequestId;
}

export interface PeopleDeps {
  readonly events: EventBus;
}

/**
 * Updates the caller's own profile.
 *
 * Personal fields write `people.profiles` (org-independent,
 * `withUserScope(actor.userId, ...)` — see the file header on why not
 * `withGlobalScope`) and emit `profile.updated` with a SYSTEM_ORG envelope —
 * the identical
 * sentinel the retired `user.display_name_changed` used, because this fact is
 * true of the person in every org. `jobTitle`/`department` are membership
 * facts: they are self-service (§3.6) but org-scoped, so they require an org
 * to be selected and are written through `updateMembershipProfile` in the
 * org's scope, emitting the org-scoped event.
 */
export async function updateProfile(
  deps: PeopleDeps,
  actor: PeopleActor,
  patch: ProfilePatch,
): Promise<{ readonly changed: readonly string[] }> {
  const normalized = normalizePatch(patch);

  const now = new Date();
  const personalChanged = await withUserScope(actor.userId, async (tx) => {
    const rows = await tx
      .select({
        displayName: schema.profiles.displayName,
        timezone: schema.profiles.timezone,
        workingHoursStart: schema.profiles.workingHoursStart,
        workingHoursEnd: schema.profiles.workingHoursEnd,
        workingDays: schema.profiles.workingDays,
        oooFrom: schema.profiles.oooFrom,
        oooUntil: schema.profiles.oooUntil,
        oooMessage: schema.profiles.oooMessage,
      })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, actor.userId))
      .limit(1);

    const existing = rows[0];
    const before = rowOf(existing);
    const after = applyPatch(before, normalized);

    const changed = FIELD_NAMES.filter(
      (field) => String(before[field] ?? null) !== String(after[field] ?? null),
    );
    if (changed.length === 0) return [] as readonly string[];

    if (existing !== undefined) {
      await tx
        .update(schema.profiles)
        .set({ ...after, updatedAt: now })
        .where(eq(schema.profiles.userId, actor.userId));
    } else {
      await tx.insert(schema.profiles).values({ userId: actor.userId, ...after, updatedAt: now });
    }

    /* Published INSIDE the scope callback: a failure rolls the write back with
       it, which is the closest the bus path comes to the outbox's
       same-transaction guarantee (see events.ts's file header on why the
       outbox cannot hold a SYSTEM_ORG event). */
    await deps.events.publish([
      createEvent(
        profileUpdated,
        { userId: actor.userId, changed, before: wireOf(before), after: wireOf(after) },
        { orgId: SYSTEM_ORG, actorId: actor.userId, requestId: actor.requestId, occurredAt: now },
      ),
    ]);

    return changed;
  });

  /* Wave 2 — self-service job title/department on one's own membership.
     Requires an org: these fields live on the membership row, and there is no
     membership without one. A validation error names the gap honestly rather
     than silently dropping the fields. */
  const hasMembershipFields =
    patch.jobTitle !== undefined || patch.department !== undefined || patch.workPhone !== undefined;
  if (hasMembershipFields) {
    if (actor.orgId === null) {
      throw errors.validation({
        jobTitle: 'Select an organization before setting a job title, department, or work phone.',
      });
    }
    await updateMembershipProfile(actor.orgId, actor, actor.userId, {
      ...(patch.jobTitle !== undefined ? { jobTitle: patch.jobTitle } : {}),
      ...(patch.department !== undefined ? { department: patch.department } : {}),
      ...(patch.workPhone !== undefined ? { workPhone: patch.workPhone } : {}),
    });
  }

  return { changed: personalChanged };
}

/* -------------------------------------------------------------------------- *
 * Self-serve DSAR export (Phase 12 Wave 2 §3.6)
 * -------------------------------------------------------------------------- */

export interface DataExportView {
  readonly exportedAt: Date;
  readonly account: {
    readonly userId: string;
    readonly email: string;
    readonly displayName: string | null;
    readonly status: string;
    readonly emailVerified: boolean;
    readonly createdAt: Date;
  };
  /** Every org this account belongs to, with the org's own name and slug. */
  readonly memberships: readonly {
    readonly orgId: string;
    readonly orgName: string;
    readonly orgSlug: string;
    readonly role: string;
    readonly joinedAt: Date;
  }[];
  /** Active sessions only — metadata, never a token (tokens only ever existed as hashes). */
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly authenticatedAt: Date;
    readonly lastSeenAt: Date;
    readonly userAgent: string | null;
    readonly ip: string | null;
    readonly country: string | null;
  }[];
  /** Linked OAuth identities — provider and email, never a provider token. */
  readonly oauthIdentities: readonly {
    readonly provider: string;
    readonly email: string;
    readonly linkedAt: Date;
  }[];
  /** The people.profiles row, or null when none exists yet (lazy row). */
  readonly profile: {
    readonly displayName: string | null;
    readonly timezone: string | null;
    readonly workingHoursStart: string | null;
    readonly workingHoursEnd: string | null;
    readonly workingDays: readonly number[] | null;
    readonly oooFrom: Date | null;
    readonly oooUntil: Date | null;
    readonly oooMessage: string | null;
  } | null;
}

/**
 * The caller's own account-level data, as one structured document
 * (Phase 12 Wave 2 §3.6) — the self-serve half of a DSAR, modeled on chat's
 * `compliance.exported`: inline JSON, no background job, an event recording
 * that the export happened (never its contents).
 *
 * One `withUserScope` transaction reads every source: `identity.users`
 * (minus `passwordHash`), the account's memberships joined with their orgs,
 * its active sessions' metadata, its linked OAuth identities, and its
 * `people.profiles` row. The membership+org join works through the same
 * self-read policies the org switcher uses (`memberships_self_read` /
 * `orgs_self_read` — SELECT-only, no WITH CHECK), which is precisely why
 * `withUserScope` is the right scope: the data spans every org the account
 * belongs to, and no org is selected.
 *
 * Explicitly excluded, per the spec: product data the caller authored
 * across Work/Chat/Docs. Reaching that honestly needs per-org RLS-scoped
 * reads under each membership — real, larger work, named in §2 as a gap
 * rather than hidden behind an export that looks complete and isn't.
 */
export async function exportMine(
  deps: PeopleDeps,
  actor: { readonly userId: UserId; readonly requestId: RequestId },
): Promise<DataExportView> {
  return withUserScope(actor.userId, async (tx) => {
    const now = new Date();

    const users = await tx
      .select({
        id: schema.users.id,
        email: schema.users.email,
        status: schema.users.status,
        emailVerifiedAt: schema.users.emailVerifiedAt,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, actor.userId))
      .limit(1);

    const user = users[0];
    if (!user) throw errors.notFound();

    const memberships = await tx
      .select({
        orgId: schema.memberships.orgId,
        orgName: schema.orgs.name,
        orgSlug: schema.orgs.slug,
        role: schema.memberships.role,
        joinedAt: schema.memberships.createdAt,
      })
      .from(schema.memberships)
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.memberships.orgId))
      .where(eq(schema.memberships.userId, actor.userId));

    const sessions = await tx
      .select({
        sessionId: schema.sessions.id,
        authenticatedAt: schema.sessions.authenticatedAt,
        lastSeenAt: schema.sessions.lastSeenAt,
        userAgent: schema.sessions.userAgent,
        ip: schema.sessions.ip,
        country: schema.sessions.country,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, actor.userId), isNull(schema.sessions.revokedAt)))
      .orderBy(desc(schema.sessions.lastSeenAt));

    const oauth = await tx
      .select({
        provider: schema.oauthIdentities.provider,
        email: schema.oauthIdentities.email,
        linkedAt: schema.oauthIdentities.linkedAt,
      })
      .from(schema.oauthIdentities)
      .where(eq(schema.oauthIdentities.userId, actor.userId));

    const profiles = await tx
      .select({
        displayName: schema.profiles.displayName,
        timezone: schema.profiles.timezone,
        workingHoursStart: schema.profiles.workingHoursStart,
        workingHoursEnd: schema.profiles.workingHoursEnd,
        workingDays: schema.profiles.workingDays,
        oooFrom: schema.profiles.oooFrom,
        oooUntil: schema.profiles.oooUntil,
        oooMessage: schema.profiles.oooMessage,
      })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, actor.userId))
      .limit(1);

    const profileRow = profiles[0];

    /* Published INSIDE the scope callback, like `updateProfile`'s own event:
       a failure rolls the read transaction back with it. The event records
       the export happened — never its contents. */
    await deps.events.publish([
      createEvent(
        identityEvents.dataExported,
        { userId: actor.userId, exportedAt: now.toISOString() },
        {
          orgId: SYSTEM_ORG,
          actorId: actor.userId,
          requestId: actor.requestId,
          occurredAt: now,
        },
      ),
    ]);

    return {
      exportedAt: now,
      account: {
        userId: user.id,
        email: user.email,
        displayName: profileRow?.displayName ?? null,
        status: user.status,
        emailVerified: user.emailVerifiedAt !== null,
        createdAt: user.createdAt,
      },
      memberships,
      sessions,
      oauthIdentities: oauth,
      profile:
        profileRow === undefined
          ? null
          : {
              displayName: profileRow.displayName,
              timezone: profileRow.timezone,
              workingHoursStart: profileRow.workingHoursStart,
              workingHoursEnd: profileRow.workingHoursEnd,
              workingDays: profileRow.workingDays,
              oooFrom: profileRow.oooFrom,
              oooUntil: profileRow.oooUntil,
              oooMessage: profileRow.oooMessage,
            },
    };
  });
}

/* -------------------------------------------------------------------------- *
 * Field plumbing
 * -------------------------------------------------------------------------- */

const FIELD_NAMES = [
  'displayName',
  'timezone',
  'workingHoursStart',
  'workingHoursEnd',
  'workingDays',
  'oooFrom',
  'oooUntil',
  'oooMessage',
] as const;

/** A people.profiles row, with dates as Dates and days as a number array. */
interface ProfileRecord {
  displayName: string | null;
  timezone: string | null;
  workingHoursStart: string | null;
  workingHoursEnd: string | null;
  workingDays: number[] | null;
  oooFrom: Date | null;
  oooUntil: Date | null;
  oooMessage: string | null;
}

/** The normalized patch — what normalizePatch returns: final values, dates as Dates. */
type NormalizedPatch = Partial<ProfileRecord>;

function rowOf(row: ProfileRecord | undefined): ProfileRecord {
  return (
    row ?? {
      displayName: null,
      timezone: null,
      workingHoursStart: null,
      workingHoursEnd: null,
      workingDays: null,
      oooFrom: null,
      oooUntil: null,
      oooMessage: null,
    }
  );
}

function applyPatch(before: ProfileRecord, patch: NormalizedPatch): ProfileRecord {
  /* Written field-by-field rather than looped: an indexed write with a union
     key requires the intersection of the field types, which no real value
     satisfies. Each spread is the value that field actually holds. */
  return {
    ...before,
    ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
    ...(patch.workingHoursStart !== undefined
      ? { workingHoursStart: patch.workingHoursStart }
      : {}),
    ...(patch.workingHoursEnd !== undefined ? { workingHoursEnd: patch.workingHoursEnd } : {}),
    ...(patch.workingDays !== undefined
      ? { workingDays: patch.workingDays === null ? null : [...patch.workingDays] }
      : {}),
    ...(patch.oooFrom !== undefined ? { oooFrom: patch.oooFrom } : {}),
    ...(patch.oooUntil !== undefined ? { oooUntil: patch.oooUntil } : {}),
    ...(patch.oooMessage !== undefined ? { oooMessage: patch.oooMessage } : {}),
  };
}

/** Dates to ISO strings, for the event payload (survives a queue round-trip). */
function wireOf(row: ProfileRecord) {
  return {
    displayName: row.displayName,
    timezone: row.timezone,
    workingHoursStart: row.workingHoursStart,
    workingHoursEnd: row.workingHoursEnd,
    workingDays: row.workingDays,
    oooFrom: row.oooFrom === null ? null : row.oooFrom.toISOString(),
    oooUntil: row.oooUntil === null ? null : row.oooUntil.toISOString(),
    oooMessage: row.oooMessage,
  };
}

/** HH:mm or HH:mm:ss. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

/**
 * Validates and normalizes a patch: trims free text ('' → null, the same
 * policy the retired `updateDisplayName` used), refuses impossible
 * combinations with a readable validation error instead of a
 * constraint-violation 500, and converts dates. A value this function
 * returns for a present key is final.
 */
function normalizePatch(patch: ProfilePatch): NormalizedPatch {
  const out: NormalizedPatch = {};

  if (patch.displayName !== undefined) {
    const value = patch.displayName;
    if (value !== null && value.trim().length > 80) {
      throw errors.validation({ displayName: 'A name can be at most 80 characters.' });
    }
    const trimmed = value === null ? null : value.trim();
    out.displayName = trimmed === '' ? null : trimmed;
  }

  if (patch.timezone !== undefined) {
    const value = patch.timezone;
    if (value !== null) {
      const trimmed = value.trim();
      if (trimmed === '') {
        out.timezone = null;
      } else {
        if (!IANA_ZONES.has(trimmed)) {
          throw errors.validation({ timezone: 'That is not a valid timezone.' });
        }
        out.timezone = trimmed;
      }
    } else {
      out.timezone = null;
    }
  }

  if (patch.workingHoursStart !== undefined || patch.workingHoursEnd !== undefined) {
    const start = patch.workingHoursStart;
    const end = patch.workingHoursEnd;

    // A window needs both ends. "Hours set but incomplete" is a state every
    // consumer would have to guess about; refuse it here (§3.4's nullable-and-
    // independent rule applies to the WINDOW as a whole, not to its halves).
    if ((start === undefined) !== (end === undefined)) {
      throw errors.validation({
        workingHoursEnd: 'A working-hours window needs both a start and an end time.',
      });
    }

    out.workingHoursStart = normalizeTime(start ?? null);
    out.workingHoursEnd = normalizeTime(end ?? null);

    if (out.workingHoursStart !== null && out.workingHoursEnd !== null) {
      if (out.workingHoursEnd <= out.workingHoursStart) {
        throw errors.validation({
          workingHoursEnd: 'The end time must be after the start time.',
        });
      }
    }
  }

  if (patch.workingDays !== undefined) {
    const days = patch.workingDays;
    if (days === null || days.length === 0) {
      out.workingDays = null;
    } else {
      const seen = new Set<number>();
      for (const day of days) {
        if (!Number.isInteger(day) || day < 1 || day > 7) {
          throw errors.validation({ workingDays: 'Working days are 1 (Monday) to 7 (Sunday).' });
        }
        seen.add(day);
      }
      out.workingDays = [...seen].sort((a, b) => a - b);
    }
  }

  if (patch.oooFrom !== undefined || patch.oooUntil !== undefined) {
    const from = patch.oooFrom !== undefined ? parseDate(patch.oooFrom, 'oooFrom') : null;
    const until = patch.oooUntil !== undefined ? parseDate(patch.oooUntil, 'oooUntil') : null;

    // A SCHEDULED start needs a return date (§7 decision: OOO can be planned
    // in advance). oooFrom alone is a window that never starts being OOO —
    // refuse it rather than store state that does nothing.
    if (from !== null && until === null) {
      throw errors.validation({ oooFrom: 'A scheduled start needs a return date too.' });
    }
    if (from !== null && until !== null && from >= until) {
      throw errors.validation({ oooFrom: 'The return date must be after the start date.' });
    }

    out.oooFrom = from;
    out.oooUntil = until;
  }

  if (patch.oooMessage !== undefined) {
    const value = patch.oooMessage;
    if (value !== null) {
      if (value.trim().length === 0) {
        out.oooMessage = null;
      } else if (value.trim().length > 200) {
        throw errors.validation({
          oooMessage: 'An out-of-office message can be at most 200 characters.',
        });
      } else {
        out.oooMessage = value.trim();
      }
    } else {
      out.oooMessage = null;
    }
  }

  return out;
}

function normalizeTime(value: string | null): string | null {
  if (value === null) return null;
  if (!TIME.test(value)) {
    throw errors.validation({ workingHoursStart: 'Times use HH:MM 24-hour format.' });
  }
  return value.length === 5 ? `${value}:00` : value;
}

function parseDate(value: string | null | undefined, field: string): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw errors.validation({ [field]: 'That is not a valid date.' });
  }
  return parsed;
}

/**
 * The IANA timezone names, computed once per process.
 *
 * This is also the validation the migration cannot do: `timezone`'s CHECK
 * bounds length only, because IANA names are not expressible in SQL. The API
 * is where a bad name becomes a readable validation error.
 */
const IANA_ZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));
