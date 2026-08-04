/**
 * @taskflow/contracts — the shared vocabulary of the system.
 *
 * Imported by the API, the web app, workers, and tests. Anything defined here is
 * a contract between two or more of them, so a change is a change to all of
 * them — which is the point: drift becomes a type error rather than a runtime
 * surprise (PLAN.md §2.1 guardrail 5).
 */

export * from './ids.js';
export * from './errors.js';
export * from './rank.js';
export * from './work.js';
export * from './providers/index.js';
