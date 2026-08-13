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
 * ## Why every shipped module's `defaultValue` had to change to `true`
 *
 * Six of these said `stage: 'planned'`, `defaultValue: false` while the module
 * had been shipped for months. That was harmless for exactly as long as
 * nothing consulted them — and the day the resolver started reading plan
 * features, a stale `false` became a paying customer's module going dark with
 * nothing in any log to explain it.
 *
 * The direction of the correction is the safe one. `true` means "this module
 * exists and works unless something says otherwise", and the somethings are
 * an explicit env value, a global operator override, or a plan that does not
 * include it — each of which is a deliberate act with a record. `false` would
 * have meant "off until someone remembers", which is the state that shipped
 * for six months without anyone noticing.
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
    description: 'Chat module: channels, DMs, threads',
    phase: 5,
    stage: 'launched',
    defaultValue: true,
    perOrg: true,
  },

  /* --- Phase 6 ----------------------------------------------------------- */
  docs: {
    description: 'Docs module: spaces, collaborative page editing',
    phase: 6,
    stage: 'launched',
    defaultValue: true,
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
    defaultValue: true,
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
    defaultValue: true,
    perOrg: true,
  },

  /* --- Phase 10 ---------------------------------------------------------- */
  automation: {
    description: 'Cross-product automation rules engine',
    phase: 10,
    stage: 'launched',
    defaultValue: true,
    perOrg: true,
  },
  publicApi: {
    description: 'Public REST API and scoped API tokens',
    phase: 10,
    stage: 'launched',
    defaultValue: true,
    perOrg: true,
  },

  /* --- Phase 11 ---------------------------------------------------------- */
  analytics: {
    /* NOT launched, and the only flag in this registry that is still honestly
       scaffolding. Phase 11 has not shipped — there is no `apps/api/src/
       analytics`, no route, and nothing for a plan to grant.

       This one was flipped to `launched`/`true` alongside the six genuinely
       shipped modules during Wave 4's registry correction, which was wrong:
       the correction's whole argument was that a stale `false` on a SHIPPED
       module goes dark for a paying customer, and that argument says nothing
       about a module that does not exist. A plan listing `analytics` would
       promise a customer a surface with nothing behind it. */
    description: 'Analytics dashboards',
    phase: 11,
    stage: 'planned',
    defaultValue: false,
    perOrg: true,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagName = keyof typeof FLAGS;

export const FLAG_NAMES = Object.keys(FLAGS) as FlagName[];
