import { z } from 'zod';
import type { EventBus } from '@taskflow/events';
import { route, router, selfRoute } from '../trpc/builder.js';
import * as directory from './directory.service.js';
import * as membership from './membership.service.js';
import * as profile from './profile.service.js';
import * as reporting from './reporting.service.js';

/**
 * People routes (PLAN.md §3.5; ai/phase-11.5-people.md §3.8–§3.9, Waves 1+2).
 *
 * ## Why the profile routes are `selfRoute`, not `memberRoute`
 *
 * §3.8's draft leaned toward `memberRoute` for `profile.get`/`profile.update`,
 * with `selfRoute` as the fallback if Phase 9's builder had not merged. It
 * merged — and `selfRoute` is still the right answer, for a reason the draft
 * itself provides: these routes back the `/account` page, which is
 * reachable with NO org selected (that is the entire point of
 * `ai/account-page.md`, and why `auth.me` is a `selfRoute`). `memberRoute`
 * resolves an org and answers NOT_A_MEMBER without one; `people.profiles`
 * has no org_id at all. A `memberRoute` here would break the account page
 * exactly where it must work — the same reasoning `notifications.prefs.*`
 * already gives for its own `selfRoute` choice.
 *
 * The directory and the org-scoped mutations are the opposite: they read and
 * write org-scoped tables, so they are `route({ permission })` — `member:read`
 * to look, `member:manage` to edit another member's membership fields or set
 * a reporting line. No new permission or resource type was added (zero matrix
 * rows — §3.8); the existing two cover every question these routes ask.
 */
export interface PeopleRouterDeps {
  readonly events: EventBus;
}

const ProfileViewSchema = z
  .object({
    email: z.string(),
    displayName: z.string().nullable(),
    timezone: z.string().nullable(),
    workingHoursStart: z.string().nullable(),
    workingHoursEnd: z.string().nullable(),
    workingDays: z.array(z.number().int()).readonly().nullable(),
    oooFrom: z.date().nullable(),
    oooUntil: z.date().nullable(),
    oooMessage: z.string().nullable(),
    createdAt: z.date(),
    emailVerified: z.boolean(),
  })
  .strict();

/**
 * The update patch — every field optional, `.strict()`, and ABSENT is
 * different from `null` (null clears, absent leaves alone; the service reads
 * presence with `'x' in patch`). The router does not `.default()` anything,
 * because a default would destroy exactly that distinction.
 */
const ProfilePatchSchema = z
  .object({
    displayName: z.string().trim().max(80).nullable().optional(),
    timezone: z.string().trim().max(64).nullable().optional(),
    workingHoursStart: z.string().nullable().optional(),
    workingHoursEnd: z.string().nullable().optional(),
    workingDays: z.array(z.number().int().min(1).max(7)).readonly().nullable().optional(),
    oooFrom: z.string().nullable().optional(),
    oooUntil: z.string().nullable().optional(),
    oooMessage: z.string().trim().max(200).nullable().optional(),
    /* Wave 2 — self-service on one's own membership (§3.6). */
    jobTitle: z.string().trim().max(120).nullable().optional(),
    department: z.string().trim().max(120).nullable().optional(),
    /* Validated as E.164 by the service, not here: the same parser every other
       phone number in this system crosses, so a malformed value is a field
       error rather than a geo-allowlist refusal later (migration 0039). */
    workPhone: z.string().trim().max(16).nullable().optional(),
  })
  .strict();

const DirectoryMemberSchema = z
  .object({
    userId: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    timezone: z.string().nullable(),
    workingHoursStart: z.string().nullable(),
    workingHoursEnd: z.string().nullable(),
    workingDays: z.array(z.number().int()).readonly().nullable(),
    oooFrom: z.date().nullable(),
    oooUntil: z.date().nullable(),
    oooMessage: z.string().nullable(),
    jobTitle: z.string().nullable(),
    department: z.string().nullable(),
    workPhone: z.string().nullable(),
    managerUserId: z.string().nullable(),
    role: z.string(),
  })
  .strict();

const ResolvedMemberSchema = z
  .object({ userId: z.string(), displayName: z.string().nullable(), email: z.string() })
  .strict();

/* The self-serve DSAR export (Phase 12 Wave 2 §3.6) — the caller's own
   account data, inline. Dates are `z.date()` like every other output; the
   wire boundary serializes them to ISO strings. */
const DataExportSchema = z
  .object({
    exportedAt: z.date(),
    account: z
      .object({
        userId: z.string(),
        email: z.string(),
        displayName: z.string().nullable(),
        status: z.string(),
        emailVerified: z.boolean(),
        createdAt: z.date(),
      })
      .strict(),
    memberships: z
      .array(
        z
          .object({
            orgId: z.string(),
            orgName: z.string(),
            orgSlug: z.string(),
            role: z.string(),
            joinedAt: z.date(),
          })
          .strict(),
      )
      .readonly(),
    sessions: z
      .array(
        z
          .object({
            sessionId: z.string(),
            authenticatedAt: z.date(),
            lastSeenAt: z.date(),
            userAgent: z.string().nullable(),
            ip: z.string().nullable(),
            country: z.string().nullable(),
          })
          .strict(),
      )
      .readonly(),
    oauthIdentities: z
      .array(z.object({ provider: z.string(), email: z.string(), linkedAt: z.date() }).strict())
      .readonly(),
    profile: z
      .object({
        displayName: z.string().nullable(),
        timezone: z.string().nullable(),
        workingHoursStart: z.string().nullable(),
        workingHoursEnd: z.string().nullable(),
        workingDays: z.array(z.number().int()).readonly().nullable(),
        oooFrom: z.date().nullable(),
        oooUntil: z.date().nullable(),
        oooMessage: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export function createPeopleRouter(deps: PeopleRouterDeps) {
  return router({
    profile: router({
      get: selfRoute({
        selfReason:
          'A user reading their own profile. No org permission describes it, and it must answer with no org selected — the account page.',
      })
        .output(ProfileViewSchema)
        .query(({ ctx }) => profile.getProfile(ctx.principal.userId)),

      update: selfRoute({
        selfReason:
          'A user editing their own profile (name, timezone, working hours, out-of-office, and their own job title). No org permission describes managing your own fields.',
      })
        .input(ProfilePatchSchema)
        .output(z.object({ changed: z.array(z.string()).readonly() }).strict())
        .mutation(({ input, ctx }) =>
          profile.updateProfile(
            deps,
            {
              userId: ctx.principal.userId,
              orgId: ctx.principal.org?.orgId ?? null,
              requestId: ctx.requestId,
            },
            input,
          ),
        ),

      /* Phase 12 Wave 2 §3.6 — self-serve DSAR export: the caller's own
         account-level data as one structured document, returned inline.
         `selfRoute` for the same reason the two above are: the data spans
         every org the account belongs to (the memberships join reads through
         the self policies), and it must answer with no org selected. The
         export's only audit fact is the event the service emits — never the
         export's contents. */
      exportMine: selfRoute({
        selfReason:
          'A user exporting their own account data — the self-serve DSAR export. No org permission describes it; the data spans every org they belong to.',
      })
        .output(DataExportSchema)
        .query(({ ctx }) =>
          profile.exportMine(deps, {
            userId: ctx.principal.userId,
            requestId: ctx.requestId,
          }),
        ),
    }),

    directory: router({
      /**
       * The org directory, cursor-paginated (§7 decision: paginate from
       * Wave 1). The cursor is a user id — UUIDv7 is creation-ordered and
       * unique, so `user_id > cursor` is a total order with no ties.
       */
      list: route({ permission: 'member:read' })
        .input(
          z
            .object({
              cursor: z.string().uuid().optional(),
              limit: z.number().int().min(1).max(100).default(50),
            })
            .strict(),
        )
        .output(
          z
            .object({
              members: z.array(DirectoryMemberSchema).readonly(),
              nextCursor: z.string().nullable(),
            })
            .strict(),
        )
        .query(({ input, ctx }) =>
          directory.listDirectory(ctx.principal.org.orgId, input.cursor ?? null, input.limit),
        ),

      /** One member's full profile — manager and direct reports resolved. */
      get: route({ permission: 'member:read' })
        .input(z.object({ userId: z.string().uuid() }).strict())
        .output(
          DirectoryMemberSchema.extend({
            manager: ResolvedMemberSchema.nullable(),
            directReports: z.array(ResolvedMemberSchema).readonly(),
          }).strict(),
        )
        .query(({ input, ctx }) =>
          directory.getDirectoryMember(ctx.principal.org.orgId, input.userId),
        ),
    }),

    /** Admin edit of ANOTHER member's job title/department (§3.6). */
    membershipProfile: router({
      update: route({ permission: 'member:manage' })
        .input(
          z
            .object({
              userId: z.string().uuid(),
              jobTitle: z.string().trim().max(120).nullable().optional(),
              department: z.string().trim().max(120).nullable().optional(),
              workPhone: z.string().trim().max(16).nullable().optional(),
            })
            .strict(),
        )
        .output(z.object({ changed: z.array(z.string()).readonly() }).strict())
        .mutation(({ input, ctx }) =>
          membership.updateMembershipProfile(
            ctx.principal.org.orgId,
            {
              userId: ctx.principal.userId,
              orgId: ctx.principal.org.orgId,
              requestId: ctx.requestId,
            },
            input.userId,
            {
              ...('jobTitle' in input ? { jobTitle: input.jobTitle } : {}),
              ...('department' in input ? { department: input.department } : {}),
              ...('workPhone' in input ? { workPhone: input.workPhone } : {}),
            },
          ),
        ),
    }),

    reportingLine: router({
      /** Sets who a member reports to. `member:manage` always, no self-exception. */
      set: route({ permission: 'member:manage' })
        .input(
          z
            .object({ userId: z.string().uuid(), managerUserId: z.string().uuid().nullable() })
            .strict(),
        )
        .output(z.object({ before: z.string().nullable(), after: z.string().nullable() }).strict())
        .mutation(({ input, ctx }) =>
          reporting.setReportingLine(
            ctx.principal.org.orgId,
            {
              userId: ctx.principal.userId,
              orgId: ctx.principal.org.orgId,
              requestId: ctx.requestId,
            },
            input,
          ),
        ),
    }),
  });
}
