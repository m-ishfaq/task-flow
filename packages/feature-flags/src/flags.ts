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
    stage: 'planned',
    defaultValue: false,
    perOrg: true,
  },

  /* --- Phase 6 ----------------------------------------------------------- */
  docs: {
    description: 'Docs module: spaces, collaborative page editing',
    phase: 6,
    stage: 'planned',
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
    stage: 'in-progress',
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
    stage: 'planned',
    defaultValue: false,
    perOrg: true,
  },

  /* --- Phase 10 ---------------------------------------------------------- */
  automation: {
    description: 'Cross-product automation rules engine',
    phase: 10,
    stage: 'planned',
    defaultValue: false,
    perOrg: true,
  },
  publicApi: {
    description: 'Public REST API and scoped API tokens',
    phase: 10,
    stage: 'planned',
    defaultValue: false,
    perOrg: true,
  },

  /* --- Phase 11 ---------------------------------------------------------- */
  analytics: {
    description: 'Analytics dashboards',
    phase: 11,
    stage: 'planned',
    defaultValue: false,
    perOrg: true,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagName = keyof typeof FLAGS;

export const FLAG_NAMES = Object.keys(FLAGS) as FlagName[];
