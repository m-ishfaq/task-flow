import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * People domain events — guardrail 11 (PLAN.md §2.1, §10.6;
 * ai/phase-11.5-people.md §4).
 *
 * Three new events, one retirement (`identity.displayNameChanged` — see
 * `apps/api/src/people/profile.service.ts` for the replacement). Each carries
 * the BEFORE value where one exists, the same rule every other update event in
 * this codebase follows: an event saying only what a field became cannot
 * answer whether anything changed, and "what was this person's manager before
 * the change?" is the question an audit reader has when an old org chart no
 * longer matches anyone.
 *
 * ## One deliberate asymmetry in how the three are delivered
 *
 * `membership_profile.updated` and `reporting_line.changed` are emitted to the
 * TRANSACTIONAL OUTBOX inside `withOrgScope` — the ordinary guardrail-11 path
 * used by work/chat/docs, where the event commits or rolls back with the write.
 *
 * `profile.updated` is NOT, and the reason is structural rather than a
 * preference: its envelope carries `SYSTEM_ORG` (a profile fact is true of the
 * person in every org — the identical sentinel the retired
 * `user.display_name_changed` used), and `platform.outbox`'s RLS policy is
 * `org_id = app.org_id` on WITH CHECK (migration 0006) — it cannot hold an
 * event whose org id is not the scope's org, and SYSTEM_ORG is no org at all.
 * So it is published through the `EventBus` dependency, exactly the path
 * `identity` uses for its own SYSTEM_ORG events. The event is still typed and
 * still emitted, which is what guardrail 11 and the audit projection's
 * RESOURCE_OF table require.
 */

/**
 * The personal-profile fields, one shape for both sides of the diff.
 *
 * Dates serialize to ISO strings and time columns to 'HH:mm:ss' — the same
 * string discipline `card.updated` uses, so the payload survives a queue
 * round-trip unchanged.
 */
const profileFields = z
  .object({
    displayName: z.string().nullable(),
    timezone: z.string().nullable(),
    workingHoursStart: z.string().nullable(),
    workingHoursEnd: z.string().nullable(),
    workingDays: z.array(z.number().int()).readonly().nullable(),
    oooFrom: z.string().nullable(),
    oooUntil: z.string().nullable(),
    oooMessage: z.string().nullable(),
  })
  .strict();

/**
 * A person's personal profile changed — display name, timezone, working
 * hours, or out-of-office. `changed` lists exactly which fields moved, the
 * same shape `card.updated` established, so a future consumer (Phase 10's
 * automation, a quiet-hours default) filters without diffing.
 */
export const profileUpdated = defineEvent(
  'profile.updated',
  z
    .object({
      userId: z.string(),
      changed: z.array(z.string()).readonly(),
      before: profileFields,
      after: profileFields,
    })
    .strict(),
);

/**
 * A membership's org-scoped profile fields changed — job title or department.
 *
 * Its own event rather than folded into `profile.updated` for the same reason
 * `reporting_line.changed` is separate: the audit log must be able to answer
 * "what has this person been called, in this org" without opening every
 * personal-profile entry to find out. Real `orgId`, not `SYSTEM_ORG` — this
 * fact is org-scoped and the audit projection attributes it to that org.
 */
export const membershipProfileUpdated = defineEvent(
  'membership_profile.updated',
  z
    .object({
      orgId: z.string(),
      userId: z.string(),
      changed: z.array(z.string()).readonly(),
      /* `workPhone` is carried in the payload, and therefore into the audit
         log, deliberately. It is a directory value shown to every colleague by
         design — unlike a `comms` counterparty number, which belongs to a
         member of the public and is encrypted and blind-indexed for exactly
         that reason. Recording who changed someone's listed contact number,
         and to what, is the audit entry's whole purpose; omitting the value
         would leave "a field changed" with no way to review it. */
      before: z
        .object({
          jobTitle: z.string().nullable(),
          department: z.string().nullable(),
          workPhone: z.string().nullable(),
        })
        .strict(),
      after: z
        .object({
          jobTitle: z.string().nullable(),
          department: z.string().nullable(),
          workPhone: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
);

/**
 * A reporting line (org-chart edge) changed.
 *
 * Its own event, deliberately not folded into `membership_profile.updated`:
 * a structural fact other people rely on — an org chart, eventually Phase
 * 10's approval routing — is more sensitive than a free-text title, and
 * deserves to be independently greppable in the audit log rather than mixed
 * into a "some profile field changed" bucket (ai/phase-11.5-people.md §4).
 */
export const reportingLineChanged = defineEvent(
  'reporting_line.changed',
  z
    .object({
      orgId: z.string(),
      userId: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    })
    .strict(),
);
