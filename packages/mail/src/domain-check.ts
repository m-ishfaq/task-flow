import { resolve4, resolve6, resolveMx } from 'node:dns/promises';

/**
 * Whether a recipient's domain can plausibly receive mail, checked with DNS
 * before `MailQueue` ever opens an SMTP connection for it.
 *
 * ## Why this exists
 *
 * `packages/seed`'s users all live on `rinavai.seed.test`
 * (`SEED_EMAIL_DOMAIN`) — a domain on the IANA-reserved `.test` TLD, which by
 * RFC 2606 will never resolve. Nothing stops a chat DM notification from
 * being generated for one of those users. Sent through Mailpit that is
 * harmless — Mailpit does not care what the recipient domain is, it just
 * captures the message. Sent through a real relay, every one of those is
 * doomed before it starts, and `MailQueue` could not previously tell "this
 * will never work" from "the server hiccuped" — see queue.ts's
 * `isPermanentFailure` comment for the SMTP-level half of that same problem.
 * A DNS check turns four wasted SMTP round trips and ~21s of backoff into one
 * lookup and an immediate, clearly-reasoned abandonment, through the exact
 * same `onFailure` path a real bounce takes — so it reaches the same log line
 * and the same operations-dashboard row an admin already knows to look at.
 *
 * ## MX, then A/AAAA — never MX alone
 *
 * RFC 5321 §5.1: a domain with no MX record still accepts mail at its own
 * address if it has an A or AAAA record ("implicit MX"). Stopping at "no MX"
 * would refuse real domains that route mail straight to a host with no MX
 * published — unusual, valid, and not this feature's problem to make illegal.
 *
 * ## Fails OPEN on anything but a definitive answer
 *
 * `ENOTFOUND`/`ENODATA` are the resolver's authoritative "no such record" —
 * the domain genuinely does not exist, or genuinely has neither kind of
 * record. Anything else (`ESERVFAIL`, `ETIMEOUT`, the resolver itself being
 * unreachable) is inconclusive, and inconclusive must never be treated as
 * invalid: a flaky resolver would otherwise turn into "no notification mail
 * sends today" for every recipient, a strictly worse outage than the wasted
 * retries this exists to avoid. An inconclusive result lets the message
 * through to the transport, where the existing SMTP-level classification
 * still applies.
 */

export interface DomainCheckResult {
  readonly ok: boolean;
  readonly reason: string;
}

/** Injected in tests so a domain check needs no real network access. */
export interface DnsResolvers {
  readonly resolveMx: typeof resolveMx;
  readonly resolve4: typeof resolve4;
  readonly resolve6: typeof resolve6;
}

const defaultResolvers: DnsResolvers = { resolveMx, resolve4, resolve6 };

/** Resolver error codes meaning "no such record" — anything else is inconclusive. */
const NO_RECORD_CODES = new Set(['ENOTFOUND', 'ENODATA']);

function isNoRecordError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && NO_RECORD_CODES.has(code);
}

type LookupOutcome = 'present' | 'absent' | 'unknown';

async function lookupOutcome<T>(lookup: Promise<T[]>): Promise<LookupOutcome> {
  try {
    const records = await lookup;
    return records.length > 0 ? 'present' : 'absent';
  } catch (error) {
    return isNoRecordError(error) ? 'absent' : 'unknown';
  }
}

/** Checks a bare domain (not a full address) for mail-acceptance DNS records. */
export async function checkMailDomain(
  domain: string,
  resolvers: DnsResolvers = defaultResolvers,
): Promise<DomainCheckResult> {
  const mx = await lookupOutcome(resolvers.resolveMx(domain));
  if (mx === 'present') return { ok: true, reason: 'has MX records' };
  if (mx === 'unknown') return { ok: true, reason: 'MX lookup inconclusive, not blocking' };

  const a = await lookupOutcome(resolvers.resolve4(domain));
  if (a === 'present') return { ok: true, reason: 'no MX, has an A record fallback' };
  if (a === 'unknown') return { ok: true, reason: 'A lookup inconclusive, not blocking' };

  const aaaa = await lookupOutcome(resolvers.resolve6(domain));
  if (aaaa === 'present') return { ok: true, reason: 'no MX, has an AAAA record fallback' };
  if (aaaa === 'unknown') return { ok: true, reason: 'AAAA lookup inconclusive, not blocking' };

  return { ok: false, reason: `no MX, A, or AAAA records for domain "${domain}"` };
}

/** The part after the last `@` in an address, lowercased. Null when there is none. */
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at === -1 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Bounds how many distinct domains stay cached.
 *
 * Every domain here came from an address a request created — same reasoning
 * as `MAX_QUEUED` on the queue itself. Bounded so a process fed enough
 * distinct domains cannot grow this map forever; the oldest entry is evicted
 * to make room; worst case a hot domain gets one avoidable re-check instead
 * of an already-cold one.
 */
const MAX_CACHED_DOMAINS = 1_000;

interface CacheEntry {
  readonly result: DomainCheckResult;
  readonly expiresAt: number;
}

/**
 * Wraps a domain check with a bounded, TTL'd cache.
 *
 * `MailQueue` checks a message's domain on every send attempt, and the same
 * handful of domains recur constantly — every seeded account shares
 * `rinavai.seed.test`, every real org's members cluster on a handful of
 * corporate domains. Without this, a busy channel full of seeded users would
 * cost one DNS round trip per notification per retry.
 */
export function createCachedDomainCheck(
  check: (domain: string) => Promise<DomainCheckResult> = checkMailDomain,
  ttlMs = DEFAULT_CACHE_TTL_MS,
): (domain: string) => Promise<DomainCheckResult> {
  const cache = new Map<string, CacheEntry>();

  return async (domain: string): Promise<DomainCheckResult> => {
    const key = domain.toLowerCase();
    const cached = cache.get(key);
    const now = Date.now();
    if (cached !== undefined && cached.expiresAt > now) return cached.result;

    const result = await check(key);

    if (cache.size >= MAX_CACHED_DOMAINS && !cache.has(key)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { result, expiresAt: now + ttlMs });
    return result;
  };
}
