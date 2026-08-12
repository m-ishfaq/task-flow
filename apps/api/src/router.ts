import { z } from 'zod';
import type { KeyProvider } from '@taskflow/contracts';
import { publicRoute, router, selfRoute } from './trpc/builder.js';
import { getResolvedFlags } from './platform-admin/flag-evaluator.js';
import { createIdentityRouter, type IdentityRouterDeps } from './identity/router.js';
import { createTenancyRouter } from './tenancy/router.js';
import { createWorkRouter, type WorkRouterDeps } from './work/router.js';
import { createChatRouter } from './chat/router.js';
import { createDocsRouter } from './docs/router.js';
import { createPlatformRouter } from './platform/router.js';
import { createPeopleRouter } from './people/router.js';
import { createPlatformAdminRouter } from './platform-admin/router.js';
import { createTelephonyRouter } from './telephony/router.js';
import type { TelephonyDeps } from './telephony/deps.js';
import type { BillingDeps } from './billing/deps.js';
import { createRtcRouter } from './rtc/router.js';
import type { RtcDeps } from './rtc/deps.js';
import { createSearchRouter } from './search/router.js';
import { createAutomationRouter } from './automation/router.js';
import { createApiTokenRouter } from './automation/api-token.router.js';
import { PostgresSearchProvider } from './search/postgres-provider.js';

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
   * Automation (Phase 10). Only the webhook registry needs anything external
   * — a KeyProvider to wrap the per-webhook signing secrets at rest — so the
   * dep is exactly that, threaded through `createAutomationRouter`.
   */
  readonly automation: { readonly keys: KeyProvider };
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
  /**
   * Voice & Messaging (Phase 7 Wave 2).
   *
   * Undefined when no carrier is configured. The routes still EXIST in that
   * case and answer SERVICE_UNAVAILABLE — the browser client generates from
   * this router's TYPE (guardrail 5), so a shape that varied by deployment
   * would produce a different client per environment, which is the drift that
   * guarantee exists to prevent.
   */
  readonly telephony: TelephonyDeps | undefined;
  /**
   * In-app voice (Phase 13 Wave 1).
   *
   * Not optional, unlike `telephony`. An instance with STUN and no TURN is a
   * working deployment — most networks connect peer-to-peer — so there is no
   * "voice is not configured" state for the routes to answer with. What varies
   * is whether `iceServers` includes a relay, which is data rather than shape.
   */
  readonly rtc: RtcDeps;
  /**
   * Billing & org lifecycle (Phase 12 Wave 3).
   *
   * Not optional, unlike `telephony`: `PAYMENTS_PROVIDER` defaults to `fake`
   * rather than to an absent credential, so every instance has SOME
   * `PaymentProvider` and every org gets a real trial. `tenancy.orgs.create`
   * reads `trialDays` off this same object — see `tenancy/router.ts`.
   */
  readonly billing: BillingDeps;
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
     * Takes `trialDays` (Phase 12 Wave 3) and nothing else: everything else
     * it needs is the tenant-scoped database and the policy engine, both of
     * which are module-level and stateless.
     */
    tenancy: createTenancyRouter({ trialDays: deps.billing.trialDays }),

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

    /**
     * People — the org directory and personal profiles (Phase 11.5).
     *
     * Needs the event bus for `profile.updated`, which — like identity's own
     * events — carries a SYSTEM_ORG envelope that the transactional outbox
     * cannot hold (platform.outbox's RLS rejects events whose org id is not
     * the scope's org). See `people/events.ts`'s file header.
     */
    people: createPeopleRouter({ events: deps.identity.events }),

    /**
     * Platform admin — the operator console (Phase 12 Wave 1).
     *
     * Needs the event bus for the platform events, which — like identity's
     * own — cannot ride the transactional outbox: they are emitted by
     * `taskflow_platform_admin`, a role with no grant on `platform.outbox`
     * and no org scope. See `platform-admin/events.ts`'s file header.
     */
    platformAdmin: createPlatformAdminRouter({
      events: deps.identity.events,
      /* §9: suspend/reactivate also freeze or unfreeze the org's Twilio
         subaccount, when a carrier is configured. The narrowed dep keeps the
         platform-admin module from seeing the storage provider and spend
         configuration it has no business with. (Conditional spread: with
         exactOptionalPropertyTypes, an explicit `undefined` is not the same
         as an absent optional property.) */
      ...(deps.telephony === undefined
        ? {}
        : {
            subaccounts: {
              telephony: deps.telephony.telephony,
              keys: deps.telephony.keys,
            },
          }),
    }),

    /** Voice & Messaging (Phase 7 Wave 2). */
    telephony: createTelephonyRouter(deps.telephony),

    /**
     * In-app voice — WebRTC call sessions (Phase 13 Wave 1).
     *
     * Distinct from `telephony` on purpose (ai/phase-13-webrtc.md §3.7): a PSTN
     * call carries an encrypted counterparty number and a spend-ledger row; an
     * in-app call carries participant user ids and costs nothing per minute.
     * One namespace for both would make every caller disambiguate.
     */
    rtc: createRtcRouter(deps.rtc),

    /**
     * Search (Phase 8 Wave 2) — one query over cards, messages, pages and
     * comments, projected into `search.documents` by the indexer relay.
     * `search:query` is the membership floor; every hit is re-checked with
     * per-resource `can()` before it is returned (§2.7).
     */
    search: createSearchRouter(new PostgresSearchProvider()),

    /**
     * Automation rules (Phase 10 Wave 1) — the surface that MANAGES rules.
     *
     * The engine that runs them lives in `apps/worker` and is reachable from
     * nothing here, which is the point: a route in this process can take an
     * authenticated request and can never execute a rule, and the worker can
     * execute and never takes a request.
     *
     * `automation:manage` is org-level (§9 decision 4), so the route floor is
     * the whole decision at this layer — safe only because the resource-aware
     * question is asked at EXECUTION, per action, against the rule owner's
     * live permissions.
     */
    automation: createAutomationRouter(deps.automation),

    /**
     * Programmatic-access tokens (Phase 10 Wave 3, §6).
     *
     * Top-level rather than nested under automation because a token is not an
     * automation thing — it authenticates the whole org's API surface. The
     * mint/revoke routes are step-up (§6.4), which is the hook the slice-3
     * builder gate uses to refuse token principals here.
     */
    apiToken: createApiTokenRouter(),

    /**
     * Feature flags — the resolved snapshot for the client bootstrap
     * (Phase 12 Wave 1 §3.8).
     *
     * `selfRoute`, deliberately not `platformRoute`: this is the product
     * surface view every logged-in user needs ("what features am I allowed
     * to see?"), and the resolved values are non-sensitive. The operator
     * console's read/write of the override store lives under
     * `platformAdmin.flags` instead.
     */
    flags: router({
      snapshot: selfRoute({
        selfReason:
          'The resolved feature-flag snapshot for the client bootstrap — every logged-in user reads it; non-sensitive product surface (§3.8).',
      })
        .output(z.record(z.boolean()))
        .query(async () => getResolvedFlags()),
    }),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
