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

  it('blocks the same addresses in the spelling a URL parser ACTUALLY produces', () => {
    /* The test above passed for a year against an implementation that was
       bypassed in production, because it hand-writes a string no caller ever
       passes. Every caller reads `new URL(raw).hostname`, and the WHATWG URL
       parser serializes an IPv6 host in HEX — `::ffff:127.0.0.1` comes back
       out as `::ffff:7f00:1`, which matched no branch and was ALLOWED.

       So this goes through the parser rather than around it. Asserting the
       hostnames literally as well would be the same mistake one layer down:
       the point is that the value under test is produced the way production
       produces it, not that it equals a string written here. */
    const hostOf = (url: string): string => new URL(url).hostname.replace(/^\[|\]$/g, '');

    for (const url of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:10.0.0.5]/',
      'http://[::ffff:192.168.1.1]/',
      /* IPv4-compatible (`::127.0.0.1`), deprecated and still resolvable. */
      'http://[::127.0.0.1]/',
      /* 6to4 and NAT64 carry a v4 address behind a routable-looking prefix. */
      'http://[2002:7f00:1::]/',
      'http://[64:ff9b::7f00:1]/',
    ]) {
      expect(isBlockedAddress(hostOf(url))).toBe(true);
    }

    // The parser round trip must not start blocking legitimate public v6.
    expect(isBlockedAddress(hostOf('http://[2606:4700:4700::1111]/'))).toBe(false);
    expect(isBlockedAddress(hostOf('http://[::ffff:93.184.216.34]/'))).toBe(false);
  });

  it('refuses anything it cannot parse, rather than allowing it', () => {
    /* Fail-closed is the whole posture of this module: an address we cannot
       classify is one we must not connect to. A zone index is included
       because it names an interface on this host. */
    for (const address of [
      'not-an-address',
      '::ffff:999.1.1.1',
      'fe80::1%eth0',
      '1:2:3:4:5:6:7:8:9',
      ':::1',
      'gggg::1',
    ]) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });

  it('blocks site-local, discard and documentation ranges', () => {
    expect(isBlockedAddress('fec0::1')).toBe(true); // fec0::/10, deprecated
    expect(isBlockedAddress('100::1')).toBe(true); // 100::/64 discard
    expect(isBlockedAddress('2001:db8::1')).toBe(true); // documentation
  });

  it('does not block an IPv4-mapped PUBLIC address', () => {
    // The mapped form is decided by the v4 rules, both ways.
    expect(isBlockedAddress('::ffff:93.184.216.34')).toBe(false);
  });

  it('blocks the WHOLE link-local range (fe80::/10), not just the fe80 spelling', () => {
    /* Link-local spans first-hextet fe80-febf. A check that only matched the
       canonical fe80 spelling let fe9f::1 and febf::1 through — both as
       link-local as fe80::1, and both unreachable from the public internet.
       These are the boundary cases that keep that from regressing. */
    for (const address of ['fe80::1', 'fe89::1', 'fe90::1', 'fe9f::1', 'fea0::1', 'febf::1']) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('does NOT block the public v6 range adjacent to link-local', () => {
    /* fe80::/10 is not the whole fe8x world — first hextet fe80-febf is
       link-local, but fec0-feff (the rest of fe80::/9) is routable address
       space. An over-broad blocklist is its own bug — see the IPv4 comment
       about public addresses adjacent to private ranges. */
    expect(isBlockedAddress('fe70::1')).toBe(false);
    expect(isBlockedAddress('fec0::1')).toBe(false);
    expect(isBlockedAddress('feff::1')).toBe(false);
  });

  it('blocks unique-local', () => {
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
