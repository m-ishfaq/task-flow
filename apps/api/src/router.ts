import { z } from 'zod';
import { publicRoute, router } from './trpc/builder.js';
import { createIdentityRouter, type IdentityRouterDeps } from './identity/router.js';
import { createTenancyRouter } from './tenancy/router.js';
import { createWorkRouter, type WorkRouterDeps } from './work/router.js';
import { createChatRouter } from './chat/router.js';

/**
 * The root router.
 *
 * Built from dependencies rather than imported as a constant, so tests can
 * supply a stub mail deliverer and a fixed clock without touching module state.
 * `appRouter` below is the wired instance the server and the manifest assertion
 * use; its TYPE is what the client generates from, and that type is identical
 * either way.
 */

export interface AppRouterDeps extends IdentityRouterDeps {
  /**
   * Work's external dependencies — object storage and the virus scanner.
   *
   * Threaded through rather than constructed here so a test can supply a
   * scanner that always answers 'infected', or a storage provider backed by a
   * map, without a container.
   */
  readonly work: WorkRouterDeps;
}

export function createAppRouter(deps: AppRouterDeps) {
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

    /**
     * Work — projects, boards, lists, cards, card detail, attachments (Phase 3).
     *
     * Almost dependency-free, for the same reason as tenancy: the tenant-scoped
     * database and the policy engine are module-level and stateless, and the
     * rank generator is a pure function in @taskflow/contracts. Attachments are
     * the exception — object storage and the virus scanner are external
     * services with configuration and a lifecycle.
     */
    work: createWorkRouter(deps.work),

    /**
     * Chat — channels, direct messages, messages (Phase 5).
     *
     * Dependency-free for the same reason as tenancy: the tenant-scoped
     * database and the policy engine are module-level and stateless, and the
     * rich-text validator is a pure schema. File sharing arrives in Wave 3 and
     * reuses Work's attachment pipeline rather than growing a second one, so
     * even that will not add a dependency here.
     */
    chat: createChatRouter(),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
