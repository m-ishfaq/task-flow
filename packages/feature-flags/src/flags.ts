/**
 * The flag registry (PLAN.md §13).
 *
 * Every product module beyond Phase 4 ships behind a flag so that unfinished
 * work can merge to `main` continuously without `main` ever being broken or
 * undeployable. This is what makes an 18-month solo roadmap survivable: there is
 * no long-lived feature branch to reconcile.
 *
 * Rules:
 *   - A flag is added the moment work on a module starts, defaulting to `off`.
 *   - A flag is DELETED once its module is fully launched. Flags are scaffolding,
 *     not configuration; a registry full of permanently-on flags is just dead
 *     branching that every future reader has to reason about.
 *   - Flags gate *product surface*. They must never gate a security control —
 *     an authorization check behind a flag is an authorization check that can be
 *     turned off.
 *
 * ## The deletion rule has an exception now, and it is deliberate
 *
 * Phase 12 Wave 4 gives these entries a SECOND job: `billing.plans.features`
 * names them, and the entitlement resolver turns a plan's list into the
 * per-org tier `FeatureFlags.evaluate()` has always had and never had a
 * producer for. So `chat`, `docs` and the rest are no longer scaffolding due
 * for deletion — they are the vocabulary a plan is written in, and deleting
 * one now would silently drop it from every plan that grants it.
 *
 * ## `defaultValue` inverted back to `false` for every launched, perOrg flag
 *
 * This is the second reversal this file has documented, and it is worth
 * being honest that it directly contradicts the reasoning the FIRST one
 * gave. That reasoning was not wrong at the time — it was solving a real
 * problem (a stale `false` on a shipped module going dark for a paying
 * customer with nothing in any log to explain it) with the tool available
 * then, which was "assume on unless told off." The problem with that fix,
 * found only once real plan data existed to look at: a plan's feature list
 * can only ADD a grant on top of the registry default (see
 * `entitlement-resolver.ts`'s own tier-2 comment) — it can never restrict
 * one. So with every launched flag defaulting `true`, NO plan could ever
 * withhold Chat, Docs, Voice & Messaging, Advanced Search, Automation, or
 * the Public API from anything — Free and an org with no plan at all
 * resolved identically to Business, because there was nothing left for a
 * plan to restrict. `analytics` was the one flag that ever actually
 * differed by plan, for the single reason that it alone had kept
 * `defaultValue: false`.
 *
 * `ai/phase-12-wave4-plans.md` §3.6 already specified the intended shape —
 * "an org spends fourteen days on trial entitlements... lands on Free with
 * no Docs" — a real restriction. The registry could not produce it while
 * every flag defaulted to `true`. Flipping back to `false` is what makes a
 * plan's `features` list a real decision again instead of a decorative one,
 * matching how `analytics` worked all along.
 *
 * The trap the first reversal was written to avoid has NOT reopened,
 * because the trial gap it would otherwise create is closed structurally,
 * not by trusting anyone to remember: migration 0094 gives every new org a
 * real `trial` plan the moment it is created (`org.service.ts`'s
 * `createOrg`, never `plan_id = NULL`), so "no plan" — the state that used
 * to mean "give them everything" — no longer exists as a reachable state
 * for a real org, trialing or otherwise. What DOES require deliberate,
 * ongoing attention is the one thing that reversal could not fix by
 * construction: every plan's stored `features` row must actually list what
 * it is meant to grant. `free`'s row was seeded empty on purpose
 * (migration 0063's own comment: "the seeded plans preserve the status quo
 * — they do not design the pricing") specifically so an operator would fill
 * it in deliberately, through the console, rather than a migration guessing
 * at pricing. That is a real, standing gap this file cannot close on its
 * own — checked by hand once, in the operator console's Plans tab, for
 * every plan that exists.
 */

/** Development stage of a flagged module, for reporting and cleanup sweeps. */
export type FlagStage = 'planned' | 'in-progress' | 'beta' | 'launched';

export interface FlagDefinition {
  /** Why this flag exists. Shown in the admin UI and flag report. */
  readonly description: string;
  /** Roadmap phase that introduces it (§13). */
  readonly phase: number;
  readonly stage: FlagStage;
  /** Value when nothing overrides it. New work is always `false`. */
  readonly defaultValue: boolean;
  /**
   * When true, an org admin may toggle this per-organization.
   * When false, it is release plumbing only and is controlled by env/config.
   */
  readonly perOrg: boolean;
}

export const FLAGS = {
  /* --- Phase 5 ----------------------------------------------------------- */
  chat: {
    /* `defaultValue: false` — an org gets Chat because its plan lists it
       (every seeded tier does; migration 0094's `trial` plan does too), not
       because the registry hands it out for free. See this file's header on
       why the registry default had to invert back to match `analytics`. */
    description: 'Chat module: channels, DMs, threads',
    phase: 5,
    stage: 'launched',
    defaultValue: false,
    perOrg: true,
  },

  /* --- Phase 6 ----------------------------------------------------------- */
  docs: {
    description: 'Docs module: spaces, collaborative page editing',
    phase: 6,
    stage: 'launched',
    defaultValue: false,
    perOrg: true,
  },

  /* --- Phase 7 ----------------------------------------------------------- */
  telephony: {
    description: 'Voice & Messaging: calls, SMS, recordings',
    phase: 7,
    // Wave 1 shipped: the provider interface, the outbound spend/geo/velocity
    // gate, subaccount provisioning, and webhook signature verification. No
    // product surface is behind this flag yet — Wave 1 deliberately ships
    // nothing a user would call a feature (ai/phase-7-voice.md §5).
    stage: 'launched',
    defaultValue: false,
    perOrg: true,
  },
  telephonyLiveCredentials: {
    // Separate from `telephony` on purpose. The module can be exercised end to
    // end against Twilio test credentials at zero cost; this flag is the switch
    // that starts spending real money, and it is not an org-level toggle (§8.5).
    description: 'Use live Twilio credentials instead of test credentials',
    phase: 7,
    stage: 'planned',
    defaultValue: false,
    perOrg: false,
  },

  /* --- Phase 8 ----------------------------------------------------------- */
  tqlTextSyntax: {
    // The filter AST ships in Phase 3; only the text parser is gated here.
    description: 'TQL text query syntax (the AST and visual builder are not gated)',
    phase: 8,
    stage: 'launched',
    defaultValue: false,
    perOrg: true,
  },

  /* --- Phase 10 ---------------------------------------------------------- */
  automation: {
    description: 'Cross-product automation rules engine',
    phase: 10,
    stage: 'launched',
    defaultValue: false,
    perOrg: true,
  },
  publicApi: {
    description: 'Public REST API and scoped API tokens',
    phase: 10,
    stage: 'launched',
    defaultValue: false,
    perOrg: true,
  },

  /* --- Phase 11 ---------------------------------------------------------- */
  analytics: {
    /* Launched: `apps/api/src/analytics` (router, dashboards, refresh,
       backfill) is real, wired into the app router, and every one of its
       routes carries `feature: { flag: 'analytics', ... }`.

       `defaultValue: false` was always the answer here, and every other
       launched, perOrg flag above has now joined it — see this file's own
       header on why. `business` grants analytics explicitly via
       `packages/seed/src/modules/billing.catalog.ts`'s catalog; nothing
       else does, which is the point of a plan being a decision. */
    description: 'Analytics dashboards',
    phase: 11,
    stage: 'launched',
    defaultValue: false,
    perOrg: true,
  },

  /* --- Phase 15 --------------------------------------------------------- */
  aiAssistant: {
    /* "Does this org's plan include AI at all" (§2.4) — the product-surface
       half of the two-gate split; `ai:use` (packages/policy) is the other
       half, answering which specific members may open it. `in-progress`,
       matching this flag's own state: §2 (the AiProvider abstraction) and §3
       (the budget gate and usage ledger) exist; nothing a user would call a
       feature is behind this flag yet — the identical build order Phase 7
       Wave 1 and Phase 13 Wave 1 both used (ship the gate before the thing
       it gates). No route checks this flag today; it is registered ahead of
       its first caller so the plan catalog (Phase 12 Wave 4) has a name to
       grant the day §4 ships one. */
    description: 'AI Copilot: the tool-calling assistant, standups, PR review',
    phase: 15,
    stage: 'in-progress',
    defaultValue: false,
    perOrg: true,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagName = keyof typeof FLAGS;

export const FLAG_NAMES = Object.keys(FLAGS) as FlagName[];
