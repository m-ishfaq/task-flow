import { z } from 'zod';
import { route, router } from '../trpc/builder.js';
import * as people from '../people/profile.service.js';
import * as billing from './org-billing.service.js';
import type { BillingDeps } from './deps.js';

/**
 * The owner-facing billing routes (Phase 12 Wave 3 §3.1, §5). `billing.*`,
 * deliberately not nested under `tenancy.orgs.*` — a visibly different
 * namespace from `platformAdmin.billing.*` is what keeps the two questions
 * ("what does MY org pay" vs. "show me every org's billing state") from
 * reading like the same feature with two doors into it.
 *
 * Every route is `route({ permission: 'org:billing' })` — Owner-only,
 * ORG_LEVEL, never satisfiable by a resource tuple (`packages/policy`'s own
 * comment on why `org:billing` lives in that set).
 */
export function createBillingRouter(deps: BillingDeps) {
  return router({
    status: route({ permission: 'org:billing' })
      .output(
        z.object({
          billingStatus: z.string(),
          planId: z.string().nullable(),
          trialEndsAt: z.date().nullable(),
          billingGraceEndsAt: z.date().nullable(),
        }),
      )
      .query(({ ctx }) => billing.getStatus(ctx.principal.org.orgId)),

    createCheckoutSession: route({ permission: 'org:billing' })
      .input(z.object({ planId: z.literal('pro') }).strict())
      .output(z.object({ url: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const profile = await people.getProfile(ctx.principal.userId);
        return billing.createCheckoutSession(
          deps,
          ctx.principal.org.orgId,
          { userId: ctx.principal.userId, email: profile.email },
          input,
        );
      }),

    createPortalSession: route({ permission: 'org:billing' })
      .output(z.object({ url: z.string() }))
      .mutation(async ({ ctx }) => {
        const profile = await people.getProfile(ctx.principal.userId);
        return billing.createPortalSession(deps, ctx.principal.org.orgId, {
          userId: ctx.principal.userId,
          email: profile.email,
        });
      }),
  });
}
