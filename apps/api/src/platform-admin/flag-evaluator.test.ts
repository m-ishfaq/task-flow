import { describe, expect, it } from 'vitest';
import { FLAGS } from '@taskflow/feature-flags';
import { buildFlags } from './flag-evaluator.js';

/**
 * `buildFlags` — the pure half of the §3.8 wiring (ai/phase-12-admin.md).
 *
 * The store read (withGlobalScope, real database) is exercised by the
 * platform-admin service suite; this file tests the resolution decision,
 * which is the part with judgment in it: an override row must beat the
 * registry default, apply to global (`perOrg: false`) flags too, and a row
 * naming a flag the registry no longer defines must not crash the snapshot.
 */
describe('buildFlags (§3.8)', () => {
  it('an override row beats the registry default, via the env tier', () => {
    const evaluator = buildFlags([{ flagName: 'automation', value: true }]);

    expect(evaluator.isEnabled('automation')).toBe(true);
    /* The store merges into the constructor's env-shaped input — so the
       evaluator reports source 'environment', the global tier, not
       'org-override'. The per-org tier is unused until per-org targeting
       exists (§3.8). */
    expect(evaluator.evaluate('automation').source).toBe('environment');
  });

  it('falls back to the registry default when no override row exists', () => {
    /* Asserted against the registry's OWN value, not a hardcoded `false`.
       This test was written when every flag was unlaunched, so `false` and
       "the default" were the same string — and correcting the shipped modules
       to `defaultValue: true` (Phase 12 Wave 4) broke a test of the FALLBACK
       over a change to the data it falls back to. What matters here is that
       an empty override set resolves to the registry and reports `default`. */
    const evaluator = buildFlags([]);

    expect(evaluator.isEnabled('automation')).toBe(FLAGS.automation.defaultValue);
    expect(evaluator.evaluate('automation').source).toBe('default');
  });

  it('applies to a perOrg=false flag — the env tier is global', () => {
    /* telephonyLiveCredentials is release plumbing, not an org toggle — the
       global store must still be able to flip it. */
    const evaluator = buildFlags([{ flagName: 'telephonyLiveCredentials', value: true }]);
    expect(evaluator.isEnabled('telephonyLiveCredentials')).toBe(true);
  });

  it('ignores a row naming a flag the registry no longer defines', () => {
    /* A deleted flag's leftover row must not crash resolution, and must not
       disturb the flags that DO exist — asserted against the registry's own
       default for the same reason as above. */
    const evaluator = buildFlags([{ flagName: 'deleted_feature', value: true }]);
    expect(evaluator.snapshot().automation).toBe(FLAGS.automation.defaultValue);
  });

  it('an explicit false override resolves false, not the default', () => {
    /* `?? `-style handling would treat `false` as "not set"; the env tier
       must distinguish "off" from "absent". */
    const evaluator = buildFlags([{ flagName: 'chat', value: false }]);
    expect(evaluator.isEnabled('chat')).toBe(false);
  });

  it('snapshot resolves every registered flag', () => {
    const evaluator = buildFlags([]);
    const snapshot = evaluator.snapshot();
    expect(Object.keys(snapshot).length).toBeGreaterThan(0);
  });
});
