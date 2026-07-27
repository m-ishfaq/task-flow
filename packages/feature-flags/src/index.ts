/**
 * @taskflow/feature-flags — release plumbing for the phased roadmap (§13).
 *
 * Every product module beyond Phase 4 ships behind a flag, so unfinished work
 * merges to `main` continuously without `main` becoming undeployable.
 *
 * Flags gate product surface only. Never put a security control behind one.
 */

export { FLAGS, FLAG_NAMES, type FlagName, type FlagDefinition, type FlagStage } from './flags.js';

export { FeatureFlags, envVarNameFor, type FlagContext, type FlagEvaluation } from './evaluator.js';
