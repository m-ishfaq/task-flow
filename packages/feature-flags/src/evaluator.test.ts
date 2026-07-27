import { describe, expect, it } from 'vitest';
import { FeatureFlags, envVarNameFor } from './evaluator.js';
import { FLAGS, FLAG_NAMES, type FlagDefinition, type FlagName } from './flags.js';

describe('FeatureFlags precedence', () => {
  it('falls back to the registry default', () => {
    const flags = new FeatureFlags();
    expect(flags.evaluate('chat')).toEqual({ value: false, source: 'default' });
  });

  it('lets environment override the default', () => {
    const flags = new FeatureFlags({ chat: true });
    expect(flags.evaluate('chat')).toEqual({ value: true, source: 'environment' });
  });

  it('lets a per-org override beat the environment', () => {
    const flags = new FeatureFlags({ chat: true });
    const result = flags.evaluate('chat', { orgOverrides: { chat: false } });
    expect(result).toEqual({ value: false, source: 'org-override' });
  });

  it('ignores org overrides for flags that are not per-org', () => {
    // telephonyLiveCredentials controls real spend (§8.5). An org admin must not
    // be able to switch their own workspace onto live Twilio credentials.
    const flags = new FeatureFlags();
    const result = flags.evaluate('telephonyLiveCredentials', {
      orgOverrides: { telephonyLiveCredentials: true },
    });
    expect(result).toEqual({ value: false, source: 'default' });
  });
});

describe('flag registry invariants', () => {
  it('defaults every unlaunched flag to off', () => {
    // Checked through a function taking the WIDE FlagDefinition type on purpose.
    // `as const` in flags.ts narrows every current stage to the literal
    // 'planned', so an inline `flag.stage !== 'launched'` is a type error today
    // — and would silently become an always-true assertion later. Passing
    // through a widening boundary keeps the invariant real as stages change.
    const check = (name: string, flag: FlagDefinition): void => {
      if (flag.stage === 'launched') return;
      expect(flag.defaultValue, `${name} must default to false until launched`).toBe(false);
    };

    for (const name of FLAG_NAMES) {
      check(name, FLAGS[name]);
    }
  });

  it('keeps spend-bearing flags out of org control', () => {
    expect(FLAGS.telephonyLiveCredentials.perOrg).toBe(false);
  });

  it('assigns every flag to a roadmap phase after the shared foundation', () => {
    for (const name of FLAG_NAMES) {
      expect(FLAGS[name].phase, `${name} phase`).toBeGreaterThan(4);
    }
  });
});

describe('envVarNameFor', () => {
  it.each<[FlagName, string]>([
    ['chat', 'TASKFLOW_FLAG_CHAT'],
    ['tqlTextSyntax', 'TASKFLOW_FLAG_TQL_TEXT_SYNTAX'],
    ['telephonyLiveCredentials', 'TASKFLOW_FLAG_TELEPHONY_LIVE_CREDENTIALS'],
    ['publicApi', 'TASKFLOW_FLAG_PUBLIC_API'],
  ])('maps %s to %s', (flag, expected) => {
    expect(envVarNameFor(flag)).toBe(expected);
  });
});

describe('snapshot', () => {
  it('resolves every registered flag', () => {
    const snapshot = new FeatureFlags({ chat: true }).snapshot();
    expect(Object.keys(snapshot).sort()).toEqual([...FLAG_NAMES].sort());
    expect(snapshot.chat).toBe(true);
    expect(snapshot.docs).toBe(false);
  });
});
