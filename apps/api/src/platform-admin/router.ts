import { z } from 'zod';
import type { EventBus } from '@taskflow/events';
import { readOperatorAuditEntries } from '@taskflow/db';
import { OrgIdSchema } from '@taskflow/contracts';
import { FLAG_NAMES, type FlagName } from '@taskflow/feature-flags';
import { platformRoute, router, selfRoute } from '../trpc/builder.js';
import * as flags from './flags.service.js';
import * as orgs from './orgs.service.js';
import { isPlatformOperator } from './self.service.js';
import * as users from './users.service.js';

/**
 * The platform-operator console (Phase 12 §3.2, §3.6).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — a new privilege-escalation surface of the
 * same shape as `apps/api/src/identity` and `apps/collab/src/auth.ts`.
 *
 * Every route below is `platformRoute` — authenticated, unconditional
 * step-up, `isPlatformOperator`-gated, and (see `trpc/builder.ts`'s own
 * comment on `platformRoute`) automatically written into
 * `platform.operator_audit_log` on success — EXCEPT `self.check`, which is
 * deliberately `selfRoute`.
 */
export interface PlatformAdminRouterDeps {
  readonly events: EventBus;
}

export function createPlatformAdminRouter(deps: PlatformAdminRouterDeps) {
  return router({
    self: router({
      /**
       * Whether the CALLER is a platform operator — so `apps/web`'s account
       * menu can decide whether to render a `/platform-admin` link at all.
       *
       * Deliberately NOT `platformRoute` (§3.2's own correction of the
       * first draft, which would have routed this through the builder like
       * everything else). Every non-operator who has ever logged in calls
       * this on every page load; routing it through `platformRoute` would
       * mean every ordinary member re-authenticates with step-up just to
       * have the account menu decide not to show them a link — a real,
       * avoidable dead-end. `false` tells a non-operator nothing they did
       * not already know, and `true` is exactly what every `platformRoute`
       * below already assumes the caller can see once they reach it, still
       * gated by that route's own check.
       */
      check: selfRoute({
        selfReason:
          'Lets the account menu decide whether to render a platform-admin link, for every signed-in user, without the step-up every real platformAdmin.* action requires.',
      })
        .output(z.object({ isOperator: z.boolean() }))
        .query(async ({ ctx }) => ({ isOperator: await isPlatformOperator(ctx.principal.userId) })),
    }),

    orgs: router({
      list: platformRoute({
        platformReason: 'The org directory — sees that an org exists, never its product data.',
      })
        .input(
          z
            .object({
              limit: z.number().int().min(1).max(100).default(50),
              before: z.string().nullable().default(null),
              search: z.string().max(200).nullable().default(null),
            })
            .strict(),
        )
        .output(
          z.object({
            orgs: z
              .array(
                z.object({
                  orgId: z.string(),
                  name: z.string(),
                  slug: z.string(),
                  status: z.string(),
                  memberCount: z.number(),
                  createdAt: z.date(),
                }),
              )
              .readonly(),
            nextCursor: z.string().nullable(),
          }),
        )
        .query(({ input }) => orgs.listOrgs(input)),

      suspend: platformRoute({
        platformReason: 'Freezes an org — reversible, the low-stakes half of org governance (§2).',
      })
        .input(z.object({ orgId: OrgIdSchema }).strict())
        .output(z.object({ status: z.literal('suspended') }))
        .mutation(({ input, ctx }) =>
          orgs.suspendOrg(input.orgId, {
            userId: ctx.principal.userId,
            requestId: ctx.requestId,
          }),
        ),

      reactivate: platformRoute({
        platformReason: 'Lifts a suspension.',
      })
        .input(z.object({ orgId: OrgIdSchema }).strict())
        .output(z.object({ status: z.literal('active') }))
        .mutation(({ input, ctx }) =>
          orgs.reactivateOrg(input.orgId, {
            userId: ctx.principal.userId,
            requestId: ctx.requestId,
          }),
        ),
    }),

    users: router({
      /** Read-only in this wave — user suspension is a later Phase 12 wave (§2, §7 decision 5). */
      list: platformRoute({
        platformReason: 'The user directory — read-only; this console can freeze an org, not a person.',
      })
        .input(
          z
            .object({
              limit: z.number().int().min(1).max(100).default(50),
              before: z.string().nullable().default(null),
              search: z.string().max(200).nullable().default(null),
            })
            .strict(),
        )
        .output(
          z.object({
            users: z
              .array(
                z.object({
                  userId: z.string(),
                  email: z.string(),
                  emailVerifiedAt: z.date().nullable(),
                  status: z.string(),
                  orgCount: z.number(),
                  createdAt: z.date(),
                }),
              )
              .readonly(),
            nextCursor: z.string().nullable(),
          }),
        )
        .query(({ input }) => users.listUsers(input)),
    }),

    flags: router({
      list: platformRoute({ platformReason: 'The flag catalog with its currently resolved values.' })
        .output(
          z
            .array(
              z.object({
                flag: z.enum(FLAG_NAMES as [FlagName, ...FlagName[]]),
                description: z.string(),
                value: z.boolean(),
                source: z.enum(['platform-override', 'default']),
                setBy: z.string().nullable(),
                updatedAt: z.date().nullable(),
              }),
            )
            .readonly(),
        )
        .query(() => flags.listFlags()),

      set: platformRoute({ platformReason: 'Sets a global override for one flag.' })
        .input(z.object({ flag: z.enum(FLAG_NAMES as [FlagName, ...FlagName[]]), value: z.boolean() }).strict())
        .output(z.object({ set: z.literal(true) }))
        .mutation(async ({ input, ctx }) => {
          await flags.setFlag(input.flag, input.value, { userId: ctx.principal.userId }, deps.events);
          return { set: true as const };
        }),

      clear: platformRoute({
        platformReason: 'Clears a global override, falling back to the environment/registry default.',
      })
        .input(z.object({ flag: z.enum(FLAG_NAMES as [FlagName, ...FlagName[]]) }).strict())
        .output(z.object({ cleared: z.literal(true) }))
        .mutation(async ({ input, ctx }) => {
          await flags.clearFlag(input.flag, { userId: ctx.principal.userId }, deps.events);
          return { cleared: true as const };
        }),
    }),

    audit: router({
      list: platformRoute({
        platformReason: "The operator accountability log itself (§3.10's Audit tab).",
      })
        .input(
          z
            .object({
              limit: z.number().int().min(1).max(200).default(50),
              before: z.string().regex(/^\d+$/).nullable().default(null),
            })
            .strict(),
        )
        .output(
          z
            .array(
              z.object({
                seq: z.string(),
                operatorId: z.string(),
                action: z.string(),
                target: z.unknown(),
                occurredAt: z.date(),
              }),
            )
            .readonly(),
        )
        .query(({ input }) => readOperatorAuditEntries(input)),
    }),
  });
}
