import { describe, expect, it } from 'vitest';
import {
  TRAVEL_SPEED_THRESHOLD_KMH,
  assessImpossibleTravel,
  countryDistanceKm,
  countryOfIp,
  haversineKm,
} from './geo.js';

/**
 * The decision half of impossible-travel detection (Phase 12 Wave 2 §3.4).
 *
 * These tests pin the BOUNDARY MATH, not the data: a wrong centroid is a
 * one-line, reviewable fix in `country-centroids.data.ts`, and the two cases
 * that matter are (a) a genuinely impossible login pair flags, and (b) every
 * defensible pair does not — the check must never be so tight that a real
 * VPN or a real fast flight sets it off.
 */

const NOW = new Date('2026-08-10T12:00:00Z');

function previous(
  country: string,
  hoursAgo: number,
): {
  country: string;
  authenticatedAt: Date;
} {
  return { country, authenticatedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000) };
}

describe('haversineKm', () => {
  it('computes a known distance', () => {
    // Paris (48.86, 2.35) to Berlin (52.52, 13.40) is ~880 km as the crow flies.
    const distance = haversineKm([48.86, 2.35], [52.52, 13.4]);
    expect(distance).toBeGreaterThan(850);
    expect(distance).toBeLessThan(910);
  });
});

describe('countryDistanceKm', () => {
  it('returns null when either country has no centroid', () => {
    expect(countryDistanceKm('US', 'ZZ')).toBeNull();
    expect(countryDistanceKm('ZZ', 'US')).toBeNull();
  });
});

describe('assessImpossibleTravel', () => {
  it('flags a US→FR pair one hour apart', () => {
    // The centroids are ~8,600 km apart — 8,600 km/h is no way to travel.
    expect(
      assessImpossibleTravel({ previous: previous('US', 1), newCountry: 'FR', now: NOW }),
    ).toBe(true);
  });

  it('does not flag the same country', () => {
    expect(
      assessImpossibleTravel({ previous: previous('US', 1), newCountry: 'US', now: NOW }),
    ).toBe(false);
  });

  it('does not flag the same distance over a long elapsed time', () => {
    // Same pair, 12 hours apart — an ordinary overnight flight.
    expect(
      assessImpossibleTravel({ previous: previous('US', 12), newCountry: 'FR', now: NOW }),
    ).toBe(false);
  });

  it('does not flag a country with no centroid', () => {
    expect(
      assessImpossibleTravel({ previous: previous('US', 1), newCountry: 'XX', now: NOW }),
    ).toBe(false);
  });

  it('does not flag when the clock looks wrong (elapsed ≤ 0)', () => {
    expect(
      assessImpossibleTravel({
        previous: { country: 'US', authenticatedAt: NOW },
        newCountry: 'FR',
        now: NOW,
      }),
    ).toBe(false);
  });

  it('flags exactly when implied speed exceeds the threshold', () => {
    const distance = countryDistanceKm('US', 'FR');
    expect(distance).not.toBeNull();

    // At exactly threshold-speed (distance / threshold hours) it must NOT flag —
    // the comparison is strict. Just above (0.9 × that time) it must.
    const hoursAtThreshold = (distance ?? 0) / TRAVEL_SPEED_THRESHOLD_KMH;
    expect(
      assessImpossibleTravel({
        previous: previous('US', hoursAtThreshold),
        newCountry: 'FR',
        now: NOW,
      }),
    ).toBe(false);
    expect(
      assessImpossibleTravel({
        previous: previous('US', hoursAtThreshold * 0.9),
        newCountry: 'FR',
        now: NOW,
      }),
    ).toBe(true);
  });
});

describe('countryOfIp — the real geoip-lite lookup', () => {
  it('resolves a public IP to its country', async () => {
    expect(await countryOfIp('8.8.8.8')).toBe('US');
  });

  it('returns null for private, reserved, and documentation ranges', async () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '192.0.2.10',
      '198.51.100.10',
      '203.0.113.5',
      '::1',
    ]) {
      expect(await countryOfIp(ip), ip).toBeNull();
    }
  });

  it('returns null for a null input', async () => {
    expect(await countryOfIp(null)).toBeNull();
  });
});
