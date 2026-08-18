/**
 * Deciding whether the server may fetch a URL a user typed (PLAN.md §8.7).
 *
 * ⚠ This is a security control, not a helper. Read the whole file before
 * changing any of it.
 *
 * ## The attack this exists for
 *
 * A link unfurl is the preview card chat shows when someone pastes a URL. To
 * build it, the SERVER fetches that URL — so an attacker does not need access
 * to your network, they only need you to make a request on their behalf. That
 * is SSRF, and the canonical payloads are boring:
 *
 *     http://169.254.169.254/latest/meta-data/    cloud instance credentials
 *     http://localhost:5432/                      a database that trusts localhost
 *     http://10.0.0.5/admin                       anything behind the perimeter
 *
 * The result is then rendered into a message, which turns a blind request into
 * an exfiltration channel.
 *
 * ## What this module does and does not do
 *
 * It decides whether ONE already-resolved address is allowed to be contacted.
 * It is deliberately NOT a fetcher: the caller performs the request, because
 * the check has to be re-applied to every hop and only the caller knows what
 * its HTTP client did. See `fetchUnfurl` in the API for the other half.
 *
 * ## Why DNS resolution is the caller's job, and why that matters
 *
 * `evil.test` can resolve to `127.0.0.1`. Checking the HOSTNAME against a
 * blocklist is therefore worthless on its own — the check that counts is on the
 * IP the connection actually goes to, after resolution and before (or during)
 * connect. This module provides both halves so a caller cannot do only the easy
 * one: `isAllowedUrl` rejects the obviously-bad URL shapes, and
 * `isBlockedAddress` rejects the addresses, and the caller must call both.
 */

/** Schemes an outbound fetch may use. Everything else is refused. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Ports an outbound fetch may reach. */
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

export interface UrlVerdict {
  readonly allowed: boolean;
  /** Why not. Never shown to the person who typed the URL — see the API side. */
  readonly reason?: string;
}

const REFUSED = (reason: string): UrlVerdict => ({ allowed: false, reason });

/**
 * Whether a URL is one this server may attempt to fetch at all.
 *
 * Shape only: scheme, port, credentials, and literal-IP hosts. A hostname that
 * resolves to a private address passes here and is caught by
 * `isBlockedAddress` — that split is deliberate, see the file header.
 */
export function isAllowedUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return REFUSED('Not a URL.');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    /* `file:`, `gopher:`, `ftp:` and friends. `data:` is the one worth naming:
       it carries its payload inline, so a fetcher that accepted it would render
       attacker-authored content as though a real site had served it. */
    return REFUSED('Only http and https URLs can be previewed.');
  }

  if (url.username !== '' || url.password !== '') {
    /* `http://user:pass@host/`. Credentials in a URL would be sent by the
       fetcher to a host the user chose, and `http://expected.test@evil.test/`
       reads as a link to expected.test to a person skimming it. */
    return REFUSED('URLs with credentials are not previewed.');
  }

  if (!ALLOWED_PORTS.has(url.port)) {
    /* Not a security boundary on its own — an attacker can host on 443 — but it
       removes the whole class of "fetch my internal service on its own port",
       which is where the interesting internal services live. */
    return REFUSED('That port is not previewed.');
  }

  /* A literal IP host is checked here as well as after resolution, so the
     cheapest attack is refused without a DNS lookup at all. */
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIpAddress(host) && isBlockedAddress(host)) {
    return REFUSED('That address is not reachable for previews.');
  }

  return { allowed: true };
}

/**
 * Whether a resolved IP address is one the server must not connect to.
 *
 * A DENY list rather than an allow list, which is the one place this design
 * differs from the rest of the codebase's "closed list" habit — and the reason
 * is that the allowable set is "the public internet", which cannot be
 * enumerated. So every non-public range is named explicitly, and the ranges are
 * the ones that actually appear in SSRF write-ups rather than a tidy subset.
 */
export function isBlockedAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();

  if (normalized.includes(':')) return isBlockedIpv6(normalized);
  return isBlockedIpv4(normalized);
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return true;

  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) return true;

  const [a = 0, b = 0] = octets;

  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, and the cloud metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF, 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast, reserved, broadcast

  return false;
}

/**
 * Expands an IPv6 address to its eight hextets, or null if it is not one.
 *
 * ## Why this exists rather than a set of string patterns
 *
 * The version this replaced matched IPv4-mapped addresses with the regex
 * `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/` and its comment correctly called missing
 * that case "the classic bypass". The regex never fired, because no caller
 * ever passes that spelling: every one of them reads `new URL(raw).hostname`,
 * and the WHATWG URL parser serializes an IPv6 host in HEX. So
 * `http://[::ffff:169.254.169.254]/` arrives here as `::ffff:a9fe:a9fe`,
 * matches no branch, reaches the final "anything unrecognized is refused"
 * line — which recognizes it as valid IPv6 characters and returns FALSE —
 * and the server connects to the cloud metadata endpoint.
 *
 * The lesson generalizes past that one regex: an address has many textual
 * spellings and exactly one numeric value, so classification belongs on the
 * value. Everything below compares numbers.
 *
 * A zone index (`fe80::1%eth0`) returns null, and therefore blocks: it names
 * an interface on this host, which is never something to fetch from.
 */
function expandIpv6(address: string): readonly number[] | null {
  if (address.includes('%')) return null;

  const halves = address.split('::');
  if (halves.length > 2) return null;

  const toHextets = (side: string): number[] | null => {
    if (side === '') return [];

    const out: number[] = [];
    const tokens = side.split(':');

    for (const [index, token] of tokens.entries()) {
      /* A dotted-quad tail (`::ffff:127.0.0.1`) is legal only as the final
         token, and occupies the last TWO hextets. */
      if (token.includes('.')) {
        if (index !== tokens.length - 1) return null;

        const octets = token.split('.');
        if (octets.length !== 4) return null;

        const nums = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : Number.NaN));
        if (nums.some((num) => Number.isNaN(num) || num > 255)) return null;

        const [a = 0, b = 0, c = 0, d = 0] = nums;
        out.push((a << 8) | b, (c << 8) | d);
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/i.test(token)) return null;
      out.push(Number.parseInt(token, 16));
    }

    return out;
  };

  const head = toHextets(halves[0] ?? '');
  const tail = halves.length === 2 ? toHextets(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;

  if (halves.length === 2) {
    /* `::` stands for one or more all-zero groups, so a run that leaves no
       gap is malformed rather than merely redundant. */
    const gap = 8 - head.length - tail.length;
    if (gap < 1) return null;
    return [...head, ...Array<number>(gap).fill(0), ...tail];
  }

  return head.length === 8 ? head : null;
}

/** The dotted-quad an embedded-IPv4 hextet pair spells. */
function embeddedIpv4(high: number, low: number): string {
  return `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`;
}

function isBlockedIpv6(address: string): boolean {
  const plain = address.replace(/^\[|\]$/g, '');
  const h = expandIpv6(plain);

  /* Unparseable is REFUSED, not allowed. IPv6 has more spellings than this
     handles, and the safe default for an address we cannot classify is not to
     connect to it. */
  if (h === null) return true;

  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = h;
  const topSixZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0;

  if (topSixZero && h6 === 0 && h7 === 0) return true; // :: unspecified
  if (topSixZero && h6 === 0 && h7 === 1) return true; // ::1 loopback

  /* The three ways an IPv4 address rides inside a v6 one. All three resolve to
     a v4 address on the wire, so all three are decided by the v4 rules — which
     is the whole point of the rewrite above. */
  const mappedV4 = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff;
  const nat64 = h0 === 0x0064 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0;
  if (mappedV4 || nat64 || topSixZero) return isBlockedIpv4(embeddedIpv4(h6, h7));

  /* 6to4 carries its v4 address in the two hextets after the prefix, so
     2002:7f00:0001:: is loopback wearing a routable-looking prefix. */
  if (h0 === 0x2002) return isBlockedIpv4(embeddedIpv4(h1, h2));

  if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return true; // 100::/64 discard
  if (h0 === 0x2001 && h1 === 0x0db8) return true; // 2001:db8::/32 documentation

  return false;
}

/** True when a host is a literal address rather than a name needing resolution. */
export function isIpAddress(host: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  return host.includes(':');
}
