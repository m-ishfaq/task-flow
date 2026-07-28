import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPasswordBreached } from './breach.js';

/**
 * The k-anonymity split of SHA-1('password'), computed rather than pasted.
 *
 * Two reasons it is derived here. It documents the split HIBP actually uses —
 * five characters go over the wire, thirty-five stay local — instead of leaving
 * a reader to trust that someone typed a forty-character constant correctly.
 * And a hardcoded hash is a high-entropy hex literal, which every secret scanner
 * reports as a leaked credential: the pasted version failed CI on
 * `generic-api-key`, and the fix for a false positive should be to stop
 * producing it rather than to teach the scanner to look away.
 *
 * `node:crypto` is legal here; this IS packages/security.
 */
const PASSWORD_SHA1 = createHash('sha1').update('password').digest('hex').toUpperCase();
const PASSWORD_PREFIX = PASSWORD_SHA1.slice(0, 5);
const PASSWORD_SUFFIX = PASSWORD_SHA1.slice(5);

interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * A `fetch` stand-in that records what was requested.
 *
 * Written by hand rather than with `vi.fn` so the recorded url is a plain
 * string: `RequestInfo` is `string | URL | Request`, and stringifying that union
 * is exactly the kind of `[object Object]` assertion that passes while testing
 * nothing.
 */
function stubFetch(body: string, init: { status?: number } = {}) {
  const calls: Recorded[] = [];

  const impl = (input: string | URL | Request, requestInit?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: { ...(requestInit?.headers as Record<string, string>) } });
    return Promise.resolve(new Response(body, { status: init.status ?? 200 }));
  };

  return { fetch: impl satisfies typeof globalThis.fetch, calls };
}

describe('checkPasswordBreached', () => {
  it('reports a breached password with its count', async () => {
    const stub = stubFetch(`${PASSWORD_SUFFIX}:23547453\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1`);
    await expect(checkPasswordBreached('password', { fetch: stub.fetch })).resolves.toEqual({
      status: 'breached',
      count: 23_547_453,
    });
  });

  it('reports a clean password', async () => {
    const stub = stubFetch(
      '0000000000000000000000000000000000A:3\n1111111111111111111111111111111111B:7',
    );
    await expect(checkPasswordBreached('password', { fetch: stub.fetch })).resolves.toEqual({
      status: 'ok',
    });
  });

  it('sends only the first five hash characters', async () => {
    // The k-anonymity property. If the full hash ever left this process, the
    // service would learn every password our users choose.
    const stub = stubFetch('');
    await checkPasswordBreached('password', { fetch: stub.fetch });

    expect(stub.calls[0]?.url).toBe(`https://api.pwnedpasswords.com/range/${PASSWORD_PREFIX}`);
    expect(stub.calls[0]?.url).not.toContain(PASSWORD_SUFFIX);
  });

  it('requests response padding', async () => {
    // Without padding, the response SIZE narrows down which bucket was asked
    // for, partly undoing the k-anonymity even over TLS.
    const stub = stubFetch('');
    await checkPasswordBreached('password', { fetch: stub.fetch });

    expect(stub.calls[0]?.headers['Add-Padding']).toBe('true');
  });

  it('ignores padding entries, which carry a count of zero', async () => {
    // Decoys are returned with count 0. Treating one as a hit would reject a
    // perfectly good password for reasons nobody could reproduce.
    const stub = stubFetch(`${PASSWORD_SUFFIX}:0`);
    await expect(checkPasswordBreached('password', { fetch: stub.fetch })).resolves.toEqual({
      status: 'ok',
    });
  });

  it('tolerates the CRLF line endings the API actually returns', async () => {
    const stub = stubFetch(`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:2\r\n${PASSWORD_SUFFIX}:9\r\n`);
    await expect(checkPasswordBreached('password', { fetch: stub.fetch })).resolves.toEqual({
      status: 'breached',
      count: 9,
    });
  });

  it('matches case-insensitively', async () => {
    const stub = stubFetch(`${PASSWORD_SUFFIX.toLowerCase()}:5`);
    await expect(checkPasswordBreached('password', { fetch: stub.fetch })).resolves.toEqual({
      status: 'breached',
      count: 5,
    });
  });

  it('normalizes unicode the same way hashing does', async () => {
    // Otherwise a password could pass the breach check in one normalization and
    // be stored in another.
    const composed = 'passw' + String.fromCharCode(0x00e9) + 'rd';
    const stub = stubFetch('');

    await checkPasswordBreached(composed, { fetch: stub.fetch });
    await checkPasswordBreached(composed.normalize('NFD'), { fetch: stub.fetch });

    expect(stub.calls[0]?.url).toBe(stub.calls[1]?.url);
  });
});

describe('failure handling', () => {
  it('reports unavailable on an HTTP error', async () => {
    const stub = stubFetch('rate limited', { status: 429 });
    await expect(checkPasswordBreached('password', { fetch: stub.fetch })).resolves.toEqual({
      status: 'unavailable',
      reason: 'HTTP 429',
    });
  });

  it('reports unavailable when the request throws', async () => {
    const failing = (): Promise<Response> => Promise.reject(new Error('ENOTFOUND'));

    await expect(
      checkPasswordBreached('password', { fetch: failing as unknown as typeof globalThis.fetch }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'ENOTFOUND' });
  });

  it('never collapses unavailable into ok', async () => {
    // The three-state result is the contract. Whether an unreachable HIBP blocks
    // registration is a policy decision that belongs at the identity layer,
    // where it can be logged and alerted on — not defaulted to silently here.
    const stub = stubFetch('', { status: 503 });
    const result = await checkPasswordBreached('password', { fetch: stub.fetch });

    expect(result.status).toBe('unavailable');
  });
});
