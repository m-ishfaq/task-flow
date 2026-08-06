import { describe, expect, it } from 'vitest';
import { isAllowedUrl, isBlockedAddress, isIpAddress } from './outbound-url.js';

/**
 * The SSRF control (PLAN.md §8.7).
 *
 * Every case below is something an attacker actually types. The reason this
 * file is long is that the failure mode of a partial implementation is not "the
 * feature is broken" — it is "the feature works, and also fetches the cloud
 * metadata endpoint on request". A blocklist with a hole in it looks exactly
 * like a blocklist without one.
 *
 * The bypasses worth knowing, all covered here:
 *
 *   ::ffff:127.0.0.1     IPv4-mapped IPv6 — the v6 branch sees a colon, the v4
 *                        rules never run, loopback sails through
 *   169.254.169.254      link-local; the AWS/GCP metadata endpoint
 *   http://a:b@host/     credentials, and a host that reads as another host
 *   0.0.0.0              routes to localhost on Linux
 *   127.1                a short form of loopback (refused as malformed)
 */

describe('isAllowedUrl — shape', () => {
  it('allows an ordinary public URL', () => {
    expect(isAllowedUrl('https://example.com/post').allowed).toBe(true);
    expect(isAllowedUrl('http://example.com:8080/x').allowed).toBe(true);
  });

  it('refuses a scheme that is not http(s)', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'gopher://example.com/x',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      expect(isAllowedUrl(url).allowed, url).toBe(false);
    }
  });

  it('refuses credentials in the URL', () => {
    /* Two problems in one: the fetcher would send them to a host the user
       chose, and `http://expected.test@evil.test/` reads as a link to
       expected.test to anyone skimming it. */
    expect(isAllowedUrl('http://user:pass@example.com/').allowed).toBe(false);
    expect(isAllowedUrl('http://expected.test@evil.test/').allowed).toBe(false);
  });

  it('refuses a port that is not a normal web port', () => {
    // Not a boundary on its own — an attacker can host on 443 — but it removes
    // "fetch my internal service on its own port", which is where the
    // interesting internal services live.
    for (const url of [
      'http://example.com:22/',
      'http://example.com:5432/',
      'http://example.com:6379/',
      'http://example.com:11211/',
    ]) {
      expect(isAllowedUrl(url).allowed, url).toBe(false);
    }
  });

  it('refuses something that is not a URL at all', () => {
    expect(isAllowedUrl('not a url').allowed).toBe(false);
    expect(isAllowedUrl('').allowed).toBe(false);
  });

  it('refuses a literal private address without needing DNS', () => {
    // The cheapest attack, refused before any lookup happens.
    for (const url of [
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/admin',
      'http://[::1]/',
    ]) {
      expect(isAllowedUrl(url).allowed, url).toBe(false);
    }
  });

  it('allows a HOSTNAME that may yet resolve somewhere private', () => {
    /* Deliberate, and the most important assertion in this file. This function
       checks SHAPE; `evil.test` resolving to 127.0.0.1 is caught by
       `isBlockedAddress` after resolution. A caller that runs only this half
       has an SSRF hole, which is why the module ships both and why this test
       records that the split is intended rather than an oversight. */
    expect(isAllowedUrl('http://localhost.evil.test/').allowed).toBe(true);
  });
});

describe('isBlockedAddress — IPv4', () => {
  it('blocks loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.255.255.254')).toBe(true);
  });

  it('blocks 0.0.0.0, which routes to localhost on Linux', () => {
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
  });

  it('blocks the cloud metadata endpoint', () => {
    // The single most valuable SSRF target: it answers with instance
    // credentials, over plain HTTP, with no authentication.
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
  });

  it('blocks every private range', () => {
    for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('does NOT block the public addresses adjacent to those ranges', () => {
    // An over-broad blocklist is its own bug: it silently stops previewing
    // legitimate sites, which nobody reports as a security problem.
    for (const address of ['172.15.255.255', '172.32.0.1', '11.0.0.1', '192.167.1.1']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('blocks carrier-grade NAT and multicast', () => {
    expect(isBlockedAddress('100.64.0.1')).toBe(true);
    expect(isBlockedAddress('224.0.0.1')).toBe(true);
    expect(isBlockedAddress('255.255.255.255')).toBe(true);
  });

  it('blocks a malformed address rather than letting it through', () => {
    /* `127.1` is a real shorthand for loopback that some resolvers accept. This
       does not try to parse every shorthand — it refuses anything that is not
       four plain octets, which fails CLOSED. */
    for (const address of ['127.1', '1.2.3', '1.2.3.4.5', '999.1.1.1', 'nonsense']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows an ordinary public address', () => {
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
  });
});

describe('isBlockedAddress — IPv6', () => {
  it('blocks loopback and unspecified', () => {
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('::')).toBe(true);
  });

  it('blocks an IPv4-mapped loopback — the classic bypass', () => {
    /* THE test. `::ffff:127.0.0.1` is loopback wearing a v6 spelling. A
       implementation that branches on "contains a colon" and then applies only
       v6 rules never runs the v4 check, and this reaches localhost. */
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::FFFF:169.254.169.254')).toBe(true);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('does not block an IPv4-mapped PUBLIC address', () => {
    // The mapped form is decided by the v4 rules, both ways.
    expect(isBlockedAddress('::ffff:93.184.216.34')).toBe(false);
  });

  it('blocks link-local and unique-local', () => {
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('fc00::1')).toBe(true);
    expect(isBlockedAddress('fd12:3456::1')).toBe(true);
  });

  it('blocks multicast', () => {
    expect(isBlockedAddress('ff02::1')).toBe(true);
  });

  it('blocks anything it cannot classify', () => {
    // Fails closed: an address this function does not recognize is not one to
    // open a connection to.
    expect(isBlockedAddress('not:an:address:!')).toBe(true);
  });

  it('allows an ordinary public v6 address', () => {
    expect(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });
});

describe('isIpAddress', () => {
  it('recognizes literals and not names', () => {
    expect(isIpAddress('127.0.0.1')).toBe(true);
    expect(isIpAddress('::1')).toBe(true);
    expect(isIpAddress('example.com')).toBe(false);
  });
});
