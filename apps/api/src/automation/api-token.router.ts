import { z } from 'zod';
import { PERMISSIONS } from '@taskflow/policy';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import { listApiTokens, mintApiToken, revokeApiToken } from './api-token.service.js';
import type { AutomationActor } from './automation.service.js';

/**
 * API token routes (ai/phase-10-automation.md §6.3, §6.6 — Wave 3).
 *
 * Three routes, floored on the two matrix permissions (`apiToken:create` for
 * list+mint, `apiToken:revoke` for revoke — owner/admin only, §9 decision 10).
 *
 * ## Why mint and revoke are `stepUp: true`
 *
 * §6.4 is explicit that "a script must not be able to revoke sessions or mint
 * more tokens with a credential no browser ceremony protected". The builder's
 * slice-3 gate refuses a token-authenticated principal on step-up routes —
 * this flag is the hook that gate keys on. Until slice 3 lands, it also means
 * a browser session older than the step-up window must re-authenticate before
 * minting or revoking, which is the same posture session revocation and
 * recording export already take.
 */

const ApiTokenName = z.string().trim().min(1).max(120);
/* The catalog's size, not a guess: an owner minting a near-full-access token
   legitimately sends every permission they hold, and a hard-coded cap smaller
   than the catalog would refuse a token that is honest about what it does. */
const ApiTokenScopes = z.array(z.string()).min(1).max(PERMISSIONS.length);

const ApiTokenSummaryOutput = z.object({
  tokenId: z.string(),
  name: z.string(),
  tokenPrefix: z.string(),
  scopes: z.array(z.string()).readonly(),
  lastUsedAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
});

function actorOf(ctx: {
  principal: Parameters<typeof subjectOf>[0];
  requestId: AutomationActor['requestId'];
}): AutomationActor {
  return { subject: subjectOf(ctx.principal), requestId: ctx.requestId };
}

export function createApiTokenRouter() {
  return router({
    list: route({ permission: 'apiToken:create' })
      .input(z.object({}).strict())
      .output(z.array(ApiTokenSummaryOutput).readonly())
      .query(({ ctx }) => listApiTokens(actorOf(ctx))),

    /**
     * Mint. The output schema is the "shown once" contract: the token rides
     * this one response and is never readable again.
     */
    create: route({ permission: 'apiToken:create', stepUp: true })
      .input(z.object({ name: ApiTokenName, scopes: ApiTokenScopes }).strict())
      .output(z.object({ tokenId: z.string(), token: z.string() }))
      .mutation(({ input, ctx }) => mintApiToken(actorOf(ctx), input)),

    revoke: route({ permission: 'apiToken:revoke', stepUp: true })
      .input(z.object({ tokenId: z.string().uuid() }).strict())
      .output(z.object({ revoked: z.literal(true) }))
      .mutation(({ input, ctx }) => revokeApiToken(actorOf(ctx), input)),
  });
}
