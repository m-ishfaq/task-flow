import { z } from 'zod';
import type { EventBus } from '@taskflow/events';
import { OrgIdSchema } from '@taskflow/contracts';
import { isPlatformOperator } from './operator.js';
import { FLAG_NAMES, type FlagName } from '@taskflow/feature-flags';
import { platformRoute, router, selfRoute } from '../trpc/builder.js';
import type { SubaccountDeps } from '../telephony/subaccount.service.js';
import * as directory from './org-directory.service.js';
import * as users from './user-directory.service.js';
import * as flags from './flags.service.js';
import { readOperatorAudit, recordOperatorAction } from './audit.js';

/**
 * Platform-admin routes (Phase 12 Wave 1, ai/phase-12-admin.md §3.6).
 *
 * Every route except ONE is `platformRoute`: authenticated, step-up
 * unconditionally (cross-tenant by definition, §3.2), and checked against
 * `isPlatformOperator` — never against an org membership, because there is no
 * org. A non-operator reaching any of them gets the ordinary FORBIDDEN, not a
 * disguised 404.
 *
 * The one exception is `self.check`, and §3.2's correction is why: it exists
 * so the account menu can decide whether to render a link to /platform-admin,
 * which means EVERY logged-in user calls it on every page load just to hear
 * "no". Routing it through `platformRoute` would force every ordinary member
 * through a step-up re-authentication for that. It uses `selfRoute` instead —
 * authenticated, no permission, no step-up — and its answer (`{ isOperator }`)
 * is not sensitive on its own.
 */
export interface PlatformAdminRouterDeps {
  readonly events: EventBus;
  /**
   * The carrier subaccount sync for §9 — present only when a carrier is
   * configured, so `suspendOrg`/`reactivateOrg` freeze or unfreeze the
   * org's Twilio subaccount alongside the org-status write. See
   * `org-directory.service.ts`'s `syncSubaccountStatus`.
   */
  readonly subaccounts?: SubaccountDeps;
}

const ListInput = z
  .object({
    cursor: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();

const OrgRow = z
  .object({
    orgId: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    createdAt: z.date(),
    memberCount: z.number().int().nonnegative(),
  })
  .strict();

const UserRow = z
  .object({
    userId: z.string(),
    email: z.string(),
    emailVerifiedAt: z.date().nullable(),
    status: z.string(),
    orgCount: z.number().int().nonnegative(),
    createdAt: z.date(),
  })
  .strict();

const FlagRow = z
  .object({
    flagName: z.string(),
    description: z.string(),
    phase: z.number().int(),
    perOrg: z.boolean(),
    defaultValue: z.boolean(),
    value: z.boolean(),
    source: z.enum(['override', 'default']),
    overrideSetAt: z.date().nullable(),
  })
  .strict();

export function createPlatformAdminRouter(deps: PlatformAdminRouterDeps) {
  const operatorOf = (ctx: {
    principal: { userId: string };
    requestId: string;
  }): directory.PlatformOperator => ({
    userId: ctx.principal.userId as directory.PlatformOperator['userId'],
    requestId: ctx.requestId as directory.PlatformOperator['requestId'],
  });

  return router({
    self: router({
      check: selfRoute({
        selfReason:
          'Tells the account menu whether to render a link to /platform-admin. Answers for every logged-in user, operator or not, with no step-up — §3.2.',
      })
        .output(z.object({ isOperator: z.boolean() }).strict())
        .query(async ({ ctx }) => ({ isOperator: await isPlatformOperator(ctx.principal.userId) })),
    }),

    orgs: router({
      list: platformRoute({
        platformReason:
          'The org directory — cross-tenant by definition; no org permission can describe it.',
      })
        .input(ListInput)
        .output(
          z
            .object({ orgs: z.array(OrgRow).readonly(), nextCursor: z.string().nullable() })
            .strict(),
        )
        .query(({ input, ctx }) => directory.listOrgs(operatorOf(ctx), input)),

      suspend: platformRoute({
        platformReason:
          'Suspending an org is a cross-tenant state change on identity.orgs — no org-scoped permission can authorize it.',
      })
        .input(z.object({ orgId: OrgIdSchema }).strict())
        .output(z.object({ orgId: z.string(), status: z.literal('suspended') }).strict())
        .mutation(({ input, ctx }) => directory.suspendOrg(deps, operatorOf(ctx), input.orgId)),

      reactivate: platformRoute({
        platformReason:
          'Reversing a suspension is the same cross-tenant state change, for the same reason.',
      })
        .input(z.object({ orgId: OrgIdSchema }).strict())
        .output(z.object({ orgId: z.string(), status: z.literal('active') }).strict())
        .mutation(({ input, ctx }) => directory.reactivateOrg(deps, operatorOf(ctx), input.orgId)),
    }),

    users: router({
      list: platformRoute({
        platformReason:
          'The user directory — cross-tenant by definition; read-only this wave (§2, §7 decision 5).',
      })
        .input(ListInput)
        .output(
          z
            .object({ users: z.array(UserRow).readonly(), nextCursor: z.string().nullable() })
            .strict(),
        )
        .query(({ input, ctx }) => users.listUsers(operatorOf(ctx), input)),
    }),

    flags: router({
      /* No input, like tenancy.orgs.list — nothing to validate, and an empty
         `z.object({}).strict()` would make the client pass `{}` instead of the
         undefined every no-input route in this codebase passes. */
      list: platformRoute({
        platformReason: 'Flag overrides are global by design — no org permission applies.',
      })
        .output(z.array(FlagRow).readonly())
        .query(({ ctx }) => flags.listFlags(operatorOf(ctx))),

      set: platformRoute({
        platformReason:
          'A global flag override changes every tenant — the one capability the operator tier exists for.',
      })
        .input(
          z
            .object({
              flagName: z
                .string()
                .refine((value): value is FlagName => FLAG_NAMES.includes(value as FlagName), {
                  message: 'Unknown flag.',
                }),
              value: z.boolean().nullable(),
            })
            .strict(),
        )
        .output(z.object({ flagName: z.string(), value: z.boolean().nullable() }).strict())
        .mutation(({ input, ctx }) => flags.setFlag(deps, operatorOf(ctx), input)),
    }),

    audit: router({
      list: platformRoute({
        platformReason:
          'The operator chain — the accountability record of this tier itself; reading it is an operator action.',
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
            .object({
              entries: z
                .array(
                  z
                    .object({
                      seq: z.string(),
                      operatorId: z.string(),
                      operatorEmail: z.string(),
                      action: z.string(),
                      target: z.unknown(),
                      occurredAt: z.date(),
                    })
                    .strict(),
                )
                .readonly(),
            })
            .strict(),
        )
        .query(async ({ input, ctx }) => {
          const operator = operatorOf(ctx);
          const entries = await readOperatorAudit(input);
          /* The read is itself an operator action, recorded like every other —
             the acceptance criterion is that EVERY platformAdmin.* call lands
             in the chain, including the one that reads it. */
          await recordOperatorAction(operator.userId, 'audit.list', null);
          return { entries };
        }),
    }),
  });
}
