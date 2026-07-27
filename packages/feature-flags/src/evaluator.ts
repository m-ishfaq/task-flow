import { FLAGS, type FlagDefinition, type FlagName } from './flags.js';

/**
 * Flag resolution, highest precedence first:
 *
 *   1. Per-org override   — set by an admin, only for flags with perOrg: true
 *   2. Environment        — TASKFLOW_FLAG_<UPPER_SNAKE>=true|false
 *   3. Registry default   — flags.ts
 *
 * Resolution is deliberately synchronous and side-effect free. A flag check must
 * never perform I/O: it appears in render paths and hot request paths, and an
 * await there is how flags become a latency problem.
 */

export interface FlagContext {
  /** Per-org overrides, loaded once per request by the caller. */
  readonly orgOverrides?: Readonly<Partial<Record<FlagName, boolean>>>;
}

export interface FlagEvaluation {
  readonly value: boolean;
  readonly source: 'org-override' | 'environment' | 'default';
}

/** `chat` -> `TASKFLOW_FLAG_CHAT`, `tqlTextSyntax` -> `TASKFLOW_FLAG_TQL_TEXT_SYNTAX` */
export function envVarNameFor(flag: FlagName): string {
  const snake = flag.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  return `TASKFLOW_FLAG_${snake}`;
}

export class FeatureFlags {
  readonly #env: Readonly<Partial<Record<FlagName, boolean>>>;

  /**
   * @param env Environment-sourced values, already parsed and validated by the
   *   service's env schema. This class never reads process.env itself — that
   *   keeps it usable in the browser and testable without global state.
   */
  constructor(env: Readonly<Partial<Record<FlagName, boolean>>> = {}) {
    this.#env = env;
  }

  /** Resolves a flag, with the reason it resolved that way. */
  evaluate(flag: FlagName, context: FlagContext = {}): FlagEvaluation {
    const definition: FlagDefinition = FLAGS[flag];

    const orgValue = context.orgOverrides?.[flag];
    if (orgValue !== undefined && definition.perOrg) {
      return { value: orgValue, source: 'org-override' };
    }

    const envValue = this.#env[flag];
    if (envValue !== undefined) {
      return { value: envValue, source: 'environment' };
    }

    return { value: definition.defaultValue, source: 'default' };
  }

  /** Convenience wrapper — `if (flags.isEnabled('chat', ctx))`. */
  isEnabled(flag: FlagName, context: FlagContext = {}): boolean {
    return this.evaluate(flag, context).value;
  }

  /** Every flag resolved at once, for the client bootstrap payload. */
  snapshot(context: FlagContext = {}): Record<FlagName, boolean> {
    const out = {} as Record<FlagName, boolean>;
    for (const flag of Object.keys(FLAGS) as FlagName[]) {
      out[flag] = this.isEnabled(flag, context);
    }
    return out;
  }
}
