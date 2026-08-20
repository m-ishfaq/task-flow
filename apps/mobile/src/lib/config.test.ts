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

  it('rejects unknown keys (schema is strict)', () => {
    expect(() => parseConfig({ apiBaseUrl: 'https://a.co', unexpected: true })).toThrow();
  });
});
