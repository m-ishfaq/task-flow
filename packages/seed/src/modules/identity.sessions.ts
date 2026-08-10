import { assessImpossibleTravel } from '@taskflow/api/identity/geo';
import { defineSeedModule } from '../registry.js';
import { daysBefore, minutesAfter } from '../support.js';
import type { Rng } from '../rng.js';
import { usersModule, type SeededUser } from './identity.users.js';

/**
 * Device/session inventory and impossible-travel flags (migration 0043,
 * Phase 12 Wave 2 §3.4, ai/pre-launch-hardening.md Priority 3).
 *
 * ## No `orgScope`, on purpose
 *
 * `identity.sessions`/`identity.refresh_tokens` carry no `org_id` and have no
 * RLS policy at all — the identity module reaches them through
 * `withGlobalScope`, not `withOrgScope` (`repository.ts`'s own comment on
 * `createSession`). `identity.users` (this module's own dependency) already
 * establishes the precedent of writing with no scoping call whatsoever; this
 * module follows it rather than wrapping every insert in a no-op `orgScope`.
 *
 * ## The flag is COMPUTED, not faked
 *
 * A seeded row claiming `impossible_travel_at` without actually satisfying
 * the real check would be exactly the "a lie that looks like data" this
 * package's other modules refuse to write. So this module imports the real
 * `assessImpossibleTravel` from `apps/api/src/identity/geo.ts` — the same
 * function `issueSession` calls — and evaluates it against each user's own
 * chronological session list as it is built, mirroring
 * `mostRecentActiveSession`'s exact semantics: the most recent, by
 * `authenticatedAt`, of the sessions so far that are not revoked and whose
 * `expiresAt` is after the new session's `authenticatedAt`. A flagged row
 * here is flagged for the identical reason a real one would be.
 *
 * ## One flagged session is guaranteed, not merely likely
 *
 * The demo profile's country/device draws would probably produce at least
 * one qualifying pair on their own, but "probably" is not what a console
 * meant to demonstrate this feature can ship on. The first user in the pool
 * (when there is one) always gets an explicit two-country, twenty-minute
 * pair — trivially over the 900 km/h threshold between any two distinct
 * countries — so `impossible_travel_at` is never empty across a run. Every
 * other user's sessions are drawn normally, and some of those legitimately
 * flag too.
 */

const DEVICE_USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
  'Mozilla/5.0 (X11; Linux x86_64) Firefox/125.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edge/124.0',
  'Mozilla/5.0 (Linux; Android 14) Chrome/124.0 Mobile',
] as const;

/** A handful of countries with real centroids, spread across continents so a
 *  changed country is usually also a far one. */
const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'CA', 'AU', 'IN', 'BR', 'JP', 'NG'] as const;

/** Mirrors `deps.ts`'s `REFRESH_TOKEN_TTL_MS` (30 days, §8.1) — not imported
 *  because it is wiring-local to `apps/api`, not part of any public surface. */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface SessionDraft {
  readonly id: string;
  readonly userId: string;
  readonly authenticatedAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  readonly userAgent: string;
  readonly ip: string;
  readonly country: string | null;
  readonly impossibleTravelAt: Date | null;
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly tokenRotatedAt: Date | null;
}

/** A public-looking IPv4 — never `10.*`, `172.16-31.*`, `127.*` or `192.168.*`,
 *  the ranges GeoLite2 (and this feature) never assigns a country to. */
function publicIp(rng: Rng): string {
  const first = rng.pick([1, 3, 24, 45, 66, 82, 104, 138, 151, 178, 203, 210]);
  return `${String(first)}.${String(rng.int(1, 254))}.${String(rng.int(0, 255))}.${String(rng.int(1, 254))}`;
}

const HEX = '0123456789abcdef';

/** A SHA-256-hex-SHAPED string — the real value never exists outside the
 *  response that issued it (`repository.ts`'s own comment on `tokenHash`),
 *  so a seed can only ever produce something that looks like one. */
function fakeTokenHash(rng: Rng): string {
  let out = '';
  for (let i = 0; i < 64; i += 1) {
    out += HEX.charAt(rng.int(0, HEX.length - 1));
  }
  return out;
}

/** The earlier of two dates — `support.ts`'s `latest` has no counterpart, and
 *  clamping a candidate login time to `ctx.now` needs exactly this. */
function earliest(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

/** The most recent, by `authenticatedAt`, of `drafts` that is not revoked and
 *  has not yet expired as of `asOf` — `mostRecentActiveSession`'s own query,
 *  replayed against the in-memory list instead of a table. */
function mostRecentActive(
  drafts: readonly SessionDraft[],
  asOf: Date,
): { country: string; authenticatedAt: Date } | undefined {
  let best: SessionDraft | undefined;
  for (const draft of drafts) {
    if (draft.revokedAt !== null) continue;
    if (draft.expiresAt.getTime() <= asOf.getTime()) continue;
    if (best === undefined || draft.authenticatedAt.getTime() > best.authenticatedAt.getTime()) {
      best = draft;
    }
  }
  if (best?.country == null) return undefined;
  return { country: best.country, authenticatedAt: best.authenticatedAt };
}

interface BuildOptions {
  /** True for every device but the one still signed in. */
  readonly revoked: boolean;
}

function buildSession(
  rng: Rng,
  now: Date,
  user: SeededUser,
  authenticatedAt: Date,
  country: string | null,
  priorDrafts: readonly SessionDraft[],
  options: BuildOptions,
): SessionDraft {
  const expiresAt = new Date(authenticatedAt.getTime() + REFRESH_TOKEN_TTL_MS);

  let impossibleTravelAt: Date | null = null;
  if (country !== null) {
    const previous = mostRecentActive(priorDrafts, authenticatedAt);
    if (previous !== undefined && previous.country !== country) {
      const flagged = assessImpossibleTravel({
        previous,
        newCountry: country,
        now: authenticatedAt,
      });
      if (flagged) impossibleTravelAt = authenticatedAt;
    }
  }

  /* An active device was seen sometime between signing in and now; a revoked
     one was seen once more, shortly before it logged out — both clamped to
     `now`, since nothing in this fixture happens in the future. */
  const lastSeenAt = options.revoked
    ? earliest(minutesAfter(authenticatedAt, rng.int(5, 600)), now)
    : earliest(minutesAfter(authenticatedAt, rng.int(0, 14 * 24 * 60)), now);

  return {
    id: rng.uuid(authenticatedAt),
    userId: user.id,
    authenticatedAt,
    lastSeenAt,
    expiresAt,
    revokedAt: options.revoked ? lastSeenAt : null,
    revokedReason: options.revoked ? 'logout' : null,
    userAgent: rng.pick(DEVICE_USER_AGENTS),
    ip: publicIp(rng),
    country,
    impossibleTravelAt,
    tokenId: rng.uuid(authenticatedAt),
    tokenHash: fakeTokenHash(rng),
    tokenRotatedAt: null,
  };
}

export interface SessionsOutput {
  readonly sessionCount: number;
  readonly impossibleTravelCount: number;
}

export const sessionsModule = defineSeedModule({
  name: 'identity.sessions',
  requires: [usersModule],
  tables: ['identity.sessions', 'identity.refresh_tokens'],

  async seed(ctx): Promise<SessionsOutput> {
    const rng = ctx.rng.fork('identity.sessions');
    const { users } = ctx.use(usersModule);

    const allDrafts: SessionDraft[] = [];
    const [firstUser, ...restUsers] = users;

    if (firstUser !== undefined) {
      const drafts: SessionDraft[] = [];
      const olderAt = daysBefore(ctx.now, rng.int(5, 60));
      const older = buildSession(rng, ctx.now, firstUser, olderAt, rng.pick(COUNTRIES), drafts, {
        revoked: false,
      });
      drafts.push(older);

      /* A different country twenty minutes later — any two distinct
         countries at that gap clear 900 km/h by a wide margin, so this pair
         flags regardless of which two `COUNTRIES` entries collide. Both
         devices stay unrevoked: this is two logins on two real devices, not
         one device that logged out. */
      const otherCountries = COUNTRIES.filter((code) => code !== older.country);
      const newCountry = otherCountries[rng.int(0, otherCountries.length - 1)] ?? 'GB';
      const newerAt = minutesAfter(olderAt, 20);
      const newer = buildSession(rng, ctx.now, firstUser, newerAt, newCountry, drafts, {
        revoked: false,
      });
      drafts.push(newer);

      allDrafts.push(...drafts);
    }

    for (const user of restUsers) {
      const drafts: SessionDraft[] = [];
      const deviceCount = rng.int(1, 3);

      for (let i = 0; i < deviceCount; i += 1) {
        const previousAt = drafts[drafts.length - 1]?.authenticatedAt;
        const candidateAt =
          previousAt === undefined
            ? daysBefore(ctx.now, rng.int(1, 180))
            : minutesAfter(previousAt, rng.int(30, 60 * 24 * 20));
        const authenticatedAt = earliest(candidateAt, ctx.now);

        const country = rng.chance(0.92) ? rng.pick(COUNTRIES) : null;
        /* Every device but the newest is an old, logged-out-of device — the
           newest is the one still signed in. */
        const revoked = i < deviceCount - 1;
        drafts.push(
          buildSession(rng, ctx.now, user, authenticatedAt, country, drafts, { revoked }),
        );
      }

      allDrafts.push(...drafts);
    }

    await ctx.db.insert(
      'identity.sessions',
      [
        'id',
        'user_id',
        'authenticated_at',
        'last_seen_at',
        'expires_at',
        'revoked_at',
        'revoked_reason',
        'user_agent',
        'ip',
        'country',
        'impossible_travel_at',
        'created_at',
      ],
      allDrafts.map((draft) => [
        draft.id,
        draft.userId,
        draft.authenticatedAt,
        draft.lastSeenAt,
        draft.expiresAt,
        draft.revokedAt,
        draft.revokedReason,
        draft.userAgent,
        draft.ip,
        draft.country,
        draft.impossibleTravelAt,
        draft.authenticatedAt,
      ]),
    );

    await ctx.db.insert(
      'identity.refresh_tokens',
      [
        'id',
        'session_id',
        'user_id',
        'token_hash',
        'issued_at',
        'expires_at',
        'rotated_at',
        'created_at',
      ],
      allDrafts.map((draft) => [
        draft.tokenId,
        draft.id,
        draft.userId,
        draft.tokenHash,
        draft.authenticatedAt,
        draft.expiresAt,
        draft.tokenRotatedAt,
        draft.authenticatedAt,
      ]),
    );

    const impossibleTravelCount = allDrafts.filter((d) => d.impossibleTravelAt !== null).length;

    ctx.log(
      `identity.sessions: ${String(allDrafts.length)} sessions across ${String(users.length)} ` +
        `users (${String(impossibleTravelCount)} flagged for impossible travel)`,
    );

    return { sessionCount: allDrafts.length, impossibleTravelCount };
  },
});
