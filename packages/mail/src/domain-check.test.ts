import { describe, expect, it, vi } from 'vitest';
import {
  checkMailDomain,
  createCachedDomainCheck,
  domainOf,
  type DnsResolvers,
} from './domain-check.js';

/** A resolver error shaped like Node's `dns` module — `code`, not `.message`, is what matters. */
function dnsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`dns lookup failed: ${code}`), { code });
}

const NEVER_CALLED = vi.fn(() => Promise.reject(new Error('should not have been called')));

describe('checkMailDomain', () => {
  it('accepts a domain with MX records', async () => {
    const resolvers: DnsResolvers = {
      resolveMx: vi.fn().mockResolvedValue([{ exchange: 'mail.example.com', priority: 10 }]),
      resolve4: NEVER_CALLED,
      resolve6: NEVER_CALLED,
    };

    const result = await checkMailDomain('example.com', resolvers);

    expect(result.ok).toBe(true);
    // Never falls through to the A/AAAA fallback once MX answers.
    expect(resolvers.resolve4).not.toHaveBeenCalled();
  });

  it('falls back to an A record when there is no MX (RFC 5321 implicit MX)', async () => {
    const resolvers: DnsResolvers = {
      resolveMx: vi.fn().mockRejectedValue(dnsError('ENODATA')),
      resolve4: vi.fn().mockResolvedValue(['203.0.113.1']),
      resolve6: NEVER_CALLED,
    };

    const result = await checkMailDomain('example.com', resolvers);

    expect(result.ok).toBe(true);
  });

  it('falls back to an AAAA record when there is neither MX nor A', async () => {
    const resolvers: DnsResolvers = {
      resolveMx: vi.fn().mockRejectedValue(dnsError('ENOTFOUND')),
      resolve4: vi.fn().mockRejectedValue(dnsError('ENOTFOUND')),
      resolve6: vi.fn().mockResolvedValue(['2001:db8::1']),
    };

    const result = await checkMailDomain('example.com', resolvers);

    expect(result.ok).toBe(true);
  });

  it('refuses a domain with no MX, A, or AAAA records', async () => {
    // The rinavai.seed.test motivating case: a domain on a reserved,
    // never-resolving TLD (RFC 2606).
    const resolvers: DnsResolvers = {
      resolveMx: vi.fn().mockRejectedValue(dnsError('ENOTFOUND')),
      resolve4: vi.fn().mockRejectedValue(dnsError('ENOTFOUND')),
      resolve6: vi.fn().mockRejectedValue(dnsError('ENOTFOUND')),
    };

    const result = await checkMailDomain('rinavai.seed.test', resolvers);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('rinavai.seed.test');
  });

  it('fails OPEN when the MX lookup itself is inconclusive rather than a definitive refusal', async () => {
    // A resolver timeout or SERVFAIL must not be treated the same as "no
    // such domain" — that would turn a flaky resolver into "stop sending
    // mail entirely" for every recipient.
    const resolvers: DnsResolvers = {
      resolveMx: vi.fn().mockRejectedValue(dnsError('ETIMEOUT')),
      resolve4: NEVER_CALLED,
      resolve6: NEVER_CALLED,
    };

    const result = await checkMailDomain('example.com', resolvers);

    expect(result.ok).toBe(true);
    expect(resolvers.resolve4).not.toHaveBeenCalled();
  });

  it('fails OPEN when the A/AAAA fallback lookup is inconclusive', async () => {
    const resolvers: DnsResolvers = {
      resolveMx: vi.fn().mockRejectedValue(dnsError('ENODATA')),
      resolve4: vi.fn().mockRejectedValue(dnsError('ESERVFAIL')),
      resolve6: NEVER_CALLED,
    };

    const result = await checkMailDomain('example.com', resolvers);

    expect(result.ok).toBe(true);
    expect(resolvers.resolve6).not.toHaveBeenCalled();
  });
});

describe('domainOf', () => {
  it('extracts the domain after the last @', () => {
    expect(domainOf('user@example.com')).toBe('example.com');
  });

  it('lowercases the domain', () => {
    expect(domainOf('user@Example.COM')).toBe('example.com');
  });

  it('returns null for an address with no @', () => {
    expect(domainOf('not-an-email')).toBeNull();
  });

  it('returns null for an address ending in @', () => {
    expect(domainOf('user@')).toBeNull();
  });
});

describe('createCachedDomainCheck', () => {
  it('reuses a cached result within the TTL instead of calling through again', async () => {
    const check = vi.fn().mockResolvedValue({ ok: true, reason: 'cached path' });
    const cached = createCachedDomainCheck(check, 60_000);

    await cached('example.com');
    await cached('example.com');

    expect(check).toHaveBeenCalledTimes(1);
  });

  it('calls through again once the TTL has elapsed', async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn().mockResolvedValue({ ok: true, reason: 'fresh' });
      const cached = createCachedDomainCheck(check, 1_000);

      await cached('example.com');
      vi.advanceTimersByTime(1_001);
      await cached('example.com');

      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats domains case-insensitively', async () => {
    const check = vi.fn().mockResolvedValue({ ok: true, reason: 'same domain' });
    const cached = createCachedDomainCheck(check, 60_000);

    await cached('Example.com');
    await cached('example.COM');

    expect(check).toHaveBeenCalledTimes(1);
  });
});
