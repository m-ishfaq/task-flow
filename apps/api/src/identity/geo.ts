import { COUNTRY_CENTROIDS } from './country-centroids.data.js';

/**
 * IP geolocation and the impossible-travel decision (Phase 12 Wave 2 §3.4).
 *
 * ## Two halves, each deliberately small
 *
 * The country lookup is `geoip-lite` — a bundled, pure-JS snapshot of
 * MaxMind's GeoLite2 data (CC BY-SA 4.0), country-level only, fully offline.
 * The spec's controlling constraints were "free, offline, no per-login
 * network call" (§3.4); geoip-lite@1.4.10 is pinned because the 2.x line
 * requires Node ≥ 24 and this stack runs Node 22. A stale data snapshot only
 * means a country lookup returns null for ranges allocated since it shipped
 * — the check degrades, it never misfires — and `pnpm updatedb` refreshes it
 * when an operator cares to (it needs a free MaxMind license key).
 *
 * The distance half is the embedded centroid table in
 * `country-centroids.data.ts` — the same closed-table-reviewable-in-a-diff
 * shape as `packages/telephony/src/geo.ts` — because "could one person
 * physically have been in both places in that time" needs a distance, and
 * country-level centroids are the honest resolution this feature's precision
 * allows.
 *
 * ## Fail-open on purpose
 *
 * `countryOfIp` never throws: a failed geo load returns null, which turns the
 * check off for that login. This is an INFORMATIONAL control that must never
 * sit in the path that completes a sign-in — a login is not something to
 * fail because the geo database is missing or corrupt. The cost of the check
 * being off is "no signal", never "no login".
 */

/** km/h. Roughly commercial jet cruise — a login pair implying a faster
 *  journey genuinely could not be one person moving between the two
 *  countries. Generous by design (§3.4): a false positive costs a "looked
 *  unusual" note, and a false negative costs nothing, because this control
 *  never blocks. */
export const TRAVEL_SPEED_THRESHOLD_KMH = 900;

type GeoLookup = (ip: string) => { country: string } | null;

/** The geo database is loaded once, on first use, never at module load — so
 *  a process that never looks anything up (no login with a routable IP ever
 *  happens) never pays for it, and the ~1–2 MB snapshot is held in memory
 *  for the process lifetime instead of per request. */
let lookupPromise: Promise<GeoLookup> | null = null;

function loadLookup(): Promise<GeoLookup> {
  lookupPromise ??= import('geoip-lite').then((mod) => {
    if (typeof mod.lookup !== 'function') {
      throw new Error('geoip-lite loaded without a lookup function');
    }
    return mod.lookup as GeoLookup;
  });
  return lookupPromise;
}

/**
 * The ISO 3166-1 alpha-2 country of an IP address, or null when there is
 * none — a private/reserved/documentation range (GeoLite2 has no entries for
 * those), an IPv6 address the snapshot does not cover, or a geo database
 * that failed to load. Never throws; see the file header.
 */
export async function countryOfIp(ip: string | null): Promise<string | null> {
  if (ip === null) return null;
  try {
    const lookup = await loadLookup();
    return lookup(ip)?.country ?? null;
  } catch {
    return null;
  }
}

/** Great-circle distance between two [lat, lon] points, in km (haversine). */
export function haversineKm(a: readonly [number, number], b: readonly [number, number]): number {
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const halfChordSquared =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(halfChordSquared));
}

/** Distance between two countries' centroids, or null when either is unknown. */
export function countryDistanceKm(a: string, b: string): number | null {
  const ca = COUNTRY_CENTROIDS[a];
  const cb = COUNTRY_CENTROIDS[b];
  if (ca === undefined || cb === undefined) return null;
  return haversineKm(ca, cb);
}

export interface TravelAssessment {
  /** The account's most recent active session at the time of the new login. */
  readonly previous: { readonly country: string; readonly authenticatedAt: Date };
  /** The new login's country. */
  readonly newCountry: string;
  readonly now: Date;
}

/**
 * The pure impossible-travel decision: would this login pair imply a journey
 * faster than anyone can actually travel?
 *
 * Never flags when either country is unknown (no centroid — the lookup could
 * not answer), when both are the same, or when the clock looks wrong
 * (elapsed ≤ 0). The distance is between country CENTROIDS, which
 * understates how close two countries can be at their borders — that
 * understatement is the "generous" part, and the accepted direction (§3.4).
 */
export function assessImpossibleTravel(input: TravelAssessment): boolean {
  const { previous, newCountry, now } = input;
  if (previous.country === newCountry) return false;

  const distance = countryDistanceKm(previous.country, newCountry);
  if (distance === null) return false;

  const elapsedHours = (now.getTime() - previous.authenticatedAt.getTime()) / 3_600_000;
  if (elapsedHours <= 0) return false;

  return distance / elapsedHours > TRAVEL_SPEED_THRESHOLD_KMH;
}
