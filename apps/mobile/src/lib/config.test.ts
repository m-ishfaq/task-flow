import { describe, it, expect } from 'vitest';
import { parseConfig } from './config.js';

describe('parseConfig', () => {
  it('normalizes the base url and derives the tRPC url', () => {
    const c = parseConfig({ apiBaseUrl: 'https://api.example.com/' });
    expect(c.apiBaseUrl).toBe('https://api.example.com');
    expect(c.trpcUrl).toBe('https://api.example.com/trpc');
  });

  it('rejects a missing url — a bad channel config fails at boot, not on first request', () => {
    expect(() => parseConfig({})).toThrow();
  });

  it('rejects a malformed url', () => {
    expect(() => parseConfig({ apiBaseUrl: 'not-a-url' })).toThrow();
  });

  it('ignores unknown keys instead of rejecting them — the real Constants.expoConfig.extra always carries some', () => {
    // Reproduces the actual object Expo hands this function at boot: `eas`
    // (app.config.ts's own EAS project linkage) and `router` (expo-router's
    // own auto-injected config) sit right alongside `apiBaseUrl` on every
    // real launch. A `.strict()` schema rejected this outright — see
    // config.ts's own header for why that was fatal on every boot, not a
    // theoretical case.
    const c = parseConfig({
      apiBaseUrl: 'https://a.co',
      eas: { projectId: 'b3129211-ec7b-4cca-ab67-6c39a32095cf' },
      router: { origin: false },
    });
    expect(c.apiBaseUrl).toBe('https://a.co');
  });
});
