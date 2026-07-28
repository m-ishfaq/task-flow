import { z } from 'zod';
import { publicRoute, router } from './trpc/builder.js';
import { createIdentityRouter, type IdentityRouterDeps } from './identity/router.js';
import { createTenancyRouter } from './tenancy/router.js';

/**
 * The root router.
 *
 * Built from dependencies rather than imported as a constant, so tests can
 * supply a stub mail deliverer and a fixed clock without touching module state.
 * `appRouter` below is the wired instance the server and the manifest assertion
 * use; its TYPE is what the client generates from, and that type is identical
 * either way.
 */

export function createAppRouter(deps: IdentityRouterDeps) {
  return router({
    health: router({
      /**
       * Liveness. Answers as long as the process is running, which is exactly
       * what an orchestrator's restart decision should depend on — a liveness
       * probe that checks the database restarts the API during a database blip,
       * turning a degradation into an outage.
       */
      live: publicRoute({
        publicReason: 'Liveness probe. Reveals nothing beyond "the process is up".',
      })
        .output(z.object({ status: z.literal('ok') }))
        .query(() => ({ status: 'ok' as const })),
    }),

    auth: createIdentityRouter(deps),

    /**
     * Tenancy, authorization and audit (Phase 2).
     *
     * Takes no dependencies: everything it needs is the tenant-scoped database
     * and the policy engine, both of which are module-level and stateless.
     * There is no clock or mailer to inject here, so a `deps` parameter would
     * be an empty object threaded through for symmetry.
     */
    tenancy: createTenancyRouter(),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
