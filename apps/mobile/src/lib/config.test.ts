import { describe, it, expect } from 'vitest';
import { parseConfig } from './config.js';

describe('parseConfig', () => {
  it('normalizes the base url and derives the tRPC url', () => {
    const c = parseConfig({ apiBaseUrl: 'https://api.example.com/' });
    expect(c.apiBaseUrl).toBe('https://api.example.com');
    expect(c.trpcUrl).toBe('https://api.example.com/trpc');
  });

  it('defaults realtimeBaseUrl to apiBaseUrl when unset — the real-deployment case', () => {
    const c = parseConfig({ apiBaseUrl: 'https://api.example.com' });
    expect(c.realtimeBaseUrl).toBe('https://api.example.com');
  });

  it('honors an explicit realtimeBaseUrl, independently of apiBaseUrl — the local-dev case', () => {
    const c = parseConfig({
      apiBaseUrl: 'http://192.168.1.10:3000',
      realtimeBaseUrl: 'http://192.168.1.10:3001/',
    });
    expect(c.apiBaseUrl).toBe('http://192.168.1.10:3000');
    expect(c.realtimeBaseUrl).toBe('http://192.168.1.10:3001');
  });

  it('rejects a malformed realtimeBaseUrl', () => {
    expect(() =>
      parseConfig({ apiBaseUrl: 'https://a.co', realtimeBaseUrl: 'not-a-url' }),
    ).toThrow();
  });

  it('defaults collabBaseUrl to apiBaseUrl when unset — the real-deployment case', () => {
    const c = parseConfig({ apiBaseUrl: 'https://api.example.com' });
    expect(c.collabBaseUrl).toBe('https://api.example.com');
  });

  it('honors an explicit collabBaseUrl, independently of the other two — the local-dev case', () => {
    const c = parseConfig({
      apiBaseUrl: 'http://192.168.1.10:3000',
      realtimeBaseUrl: 'http://192.168.1.10:3001',
      collabBaseUrl: 'http://192.168.1.10:3002/',
    });
    expect(c.collabBaseUrl).toBe('http://192.168.1.10:3002');
    expect(c.realtimeBaseUrl).toBe('http://192.168.1.10:3001');
  });

  it('rejects a malformed collabBaseUrl', () => {
    expect(() => parseConfig({ apiBaseUrl: 'https://a.co', collabBaseUrl: 'not-a-url' })).toThrow();
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
