import { z } from 'zod';
import { publicRoute, router } from './trpc/builder.js';
import { createIdentityRouter, type IdentityRouterDeps } from './identity/router.js';
import { createTenancyRouter } from './tenancy/router.js';
import { createWorkRouter, type WorkRouterDeps } from './work/router.js';
import { createChatRouter } from './chat/router.js';
import { createDocsRouter } from './docs/router.js';
import { createPlatformRouter } from './platform/router.js';

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
  /** Notifications — the VAPID public key for the push ceremony (§3.7). */
  readonly platform: { readonly vapidPublicKey: string | null };
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
     * Takes Work's attachment dependencies — the SAME storage provider and
     * scanner, not a second pair. §3.10 is explicit that chat file sharing is
     * the existing pipeline pointed at a channel, and sharing the object here
     * is what makes that literally true rather than aspirational: a test that
     * swaps in a scanner which always answers 'infected' covers both surfaces
     * at once, and there is no configuration under which one is scanned and the
     * other is not.
     */
    chat: createChatRouter(deps.work.attachments),

    /**
     * Docs — spaces and the page tree (Phase 6, Wave 1).
     *
     * No dependencies: like tenancy and Work's core, everything it needs is
     * the tenant-scoped database and the policy engine, both module-level and
     * stateless. Live collaborative editing is `apps/collab`, a separate
     * process — nothing here talks to it.
     */
    docs: createDocsRouter(),

    /**
     * Notifications — reading your own, and your own delivery preferences
     * (Phase 9). Moved out from under `chat` once Work and Docs became
     * producers too — see `platform/router.ts`'s own header.
     */
    notifications: createPlatformRouter(deps.platform),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
