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

function isBlockedIpv6(address: string): boolean {
  const plain = address.replace(/^\[|\]$/g, '');

  if (plain === '::' || plain === '::1') return true; // unspecified, loopback

  /* An IPv4-mapped address (`::ffff:127.0.0.1`) is a v6 spelling of a v4
     address, and the v4 rules are what decide it. Missing this is the classic
     bypass: the v6 branch sees a colon, the v4 branch never runs, and loopback
     sails through. */
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain);
  if (mapped?.[1] !== undefined) return isBlockedIpv4(mapped[1]);

  /* Link-local is fe80::/10 — the first hextet ranges fe80-febf, not just
     fe80. A check that only matched the fe80 spelling let fe9f::1 or
     febf::1 through, which are as link-local as fe80::1 and unreachable
     from the public internet. */
  if (/^fe[89ab]/i.test(plain)) return true; // link-local (fe80::/10)
  if (/^f[cd]/i.test(plain)) return true; // unique local (fc00::/7)
  if (plain.startsWith('ff')) return true; // multicast

  /* Anything this function does not recognize is REFUSED rather than allowed.
     IPv6 has more spellings than this handles, and the safe default for an
     address we cannot classify is not to connect to it. */
  return !/^[0-9a-f:]+$/i.test(plain);
}

/** True when a host is a literal address rather than a name needing resolution. */
export function isIpAddress(host: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  return host.includes(':');
}
