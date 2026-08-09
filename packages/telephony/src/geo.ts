import type { PhoneNumber } from '@taskflow/contracts';

/**
 * The destination geo allowlist (PLAN.md §8.5 — "destination geo-allowlist
 * (high-risk countries blocked by default)"; ai/phase-7-voice.md §3.3, §7.6).
 *
 * ## Default DENY, and the table is closed
 *
 * A destination not matched by an `allow` rule below is refused. This is the
 * same shape as `verifyMagicBytes`' closed table, and the security property is
 * the same one: the value of the list is that it is **closed and reviewable in
 * a diff**, not that it is exhaustive. Adding a country is a one-line change
 * that a human reads. That friction is the feature.
 *
 * The alternative considered and rejected (§7.6) was sourcing a high-risk
 * jurisdiction list from an external feed. More current, but it puts a network
 * fetch inside a control that must fail closed — and "the feed is unreachable"
 * would then have to mean "refuse every destination", which is a second failure
 * mode to design, test, and page someone about.
 *
 * ## Longest prefix wins, so `deny` rules can carve holes inside `allow` rules
 *
 * This is not decoration. E.164 country code **+1 is not a country** — it is the
 * North American Numbering Plan, shared by the US and Canada with roughly twenty
 * Caribbean territories that bill at premium international rates while looking
 * like an ordinary domestic number to anyone reading `+1...`.
 *
 * That is the classic toll-fraud vector, and a naive "allow +1" is exactly how
 * it succeeds: a compromised account dials `+1-809-...`, the number passes every
 * check that reasons about country codes, and the org is billed at several
 * dollars a minute to a destination whose operator shares revenue with whoever
 * placed the call. The NANP `deny` rules below are the reason this module
 * matches on prefixes rather than on a country code.
 */

export interface GeoRule {
  /** Digits after the `+`. Longest match wins. */
  readonly prefix: string;
  /** ISO 3166-1 alpha-2, or a label for a non-geographic range. */
  readonly region: string;
  readonly allow: boolean;
  /** Why this rule exists. Read during review; never used in a decision. */
  readonly note?: string;
}

/**
 * The table.
 *
 * Deliberately short. This is the list a solo operator can actually attest to,
 * not an attempt to enumerate the world — every legitimate destination outside
 * it is one reviewed line away, and every fraudulent one is refused by default
 * in the meantime.
 */
export const GEO_RULES: readonly GeoRule[] = [
  /* --- North America ----------------------------------------------------- */
  { prefix: '1', region: 'US/CA', allow: true, note: 'NANP — carved below' },

  /* NANP ranges that are NOT the US or Canada. Each bills as a premium
     international destination while presenting as a +1 number. This block is
     the single highest-value part of this file. */
  { prefix: '1242', region: 'BS', allow: false, note: 'Bahamas' },
  { prefix: '1246', region: 'BB', allow: false, note: 'Barbados' },
  { prefix: '1264', region: 'AI', allow: false, note: 'Anguilla' },
  { prefix: '1268', region: 'AG', allow: false, note: 'Antigua and Barbuda' },
  { prefix: '1284', region: 'VG', allow: false, note: 'British Virgin Islands' },
  { prefix: '1345', region: 'KY', allow: false, note: 'Cayman Islands' },
  { prefix: '1441', region: 'BM', allow: false, note: 'Bermuda' },
  { prefix: '1473', region: 'GD', allow: false, note: 'Grenada' },
  { prefix: '1649', region: 'TC', allow: false, note: 'Turks and Caicos' },
  { prefix: '1658', region: 'JM', allow: false, note: 'Jamaica (overlay)' },
  { prefix: '1664', region: 'MS', allow: false, note: 'Montserrat' },
  { prefix: '1721', region: 'SX', allow: false, note: 'Sint Maarten' },
  { prefix: '1758', region: 'LC', allow: false, note: 'Saint Lucia' },
  { prefix: '1767', region: 'DM', allow: false, note: 'Dominica' },
  { prefix: '1784', region: 'VC', allow: false, note: 'St Vincent' },
  { prefix: '1809', region: 'DO', allow: false, note: 'Dominican Republic' },
  { prefix: '1829', region: 'DO', allow: false, note: 'Dominican Republic' },
  { prefix: '1849', region: 'DO', allow: false, note: 'Dominican Republic' },
  { prefix: '1868', region: 'TT', allow: false, note: 'Trinidad and Tobago' },
  { prefix: '1869', region: 'KN', allow: false, note: 'St Kitts and Nevis' },
  { prefix: '1876', region: 'JM', allow: false, note: 'Jamaica' },

  /* Premium-rate and pay-per-call ranges inside the US/Canada themselves. */
  { prefix: '1900', region: 'US-PREMIUM', allow: false, note: 'Pay-per-call' },
  { prefix: '1976', region: 'US-PREMIUM', allow: false, note: 'Pay-per-call' },

  /* --- Western Europe ---------------------------------------------------- */
  { prefix: '30', region: 'GR', allow: true },
  { prefix: '31', region: 'NL', allow: true },
  { prefix: '32', region: 'BE', allow: true },
  { prefix: '33', region: 'FR', allow: true },
  { prefix: '34', region: 'ES', allow: true },
  { prefix: '39', region: 'IT', allow: true },
  { prefix: '41', region: 'CH', allow: true },
  { prefix: '43', region: 'AT', allow: true },
  { prefix: '44', region: 'GB', allow: true },
  { prefix: '45', region: 'DK', allow: true },
  { prefix: '46', region: 'SE', allow: true },
  { prefix: '47', region: 'NO', allow: true },
  { prefix: '48', region: 'PL', allow: true },
  { prefix: '49', region: 'DE', allow: true },
  { prefix: '351', region: 'PT', allow: true },
  { prefix: '353', region: 'IE', allow: true },
  { prefix: '354', region: 'IS', allow: true },
  { prefix: '358', region: 'FI', allow: true },
  { prefix: '372', region: 'EE', allow: true },
  { prefix: '420', region: 'CZ', allow: true },

  /* UK premium and personal-numbering ranges, carved out of +44 above for the
     same reason the NANP block exists — they bill far above a normal call. */
  { prefix: '4470', region: 'GB-PERSONAL', allow: false, note: 'Personal numbering' },
  { prefix: '4490', region: 'GB-PREMIUM', allow: false, note: 'Premium rate' },
  { prefix: '4491', region: 'GB-PREMIUM', allow: false, note: 'Premium rate' },

  /* --- Asia-Pacific ------------------------------------------------------ */
  { prefix: '61', region: 'AU', allow: true },
  { prefix: '64', region: 'NZ', allow: true },
  { prefix: '65', region: 'SG', allow: true },
  { prefix: '81', region: 'JP', allow: true },

  /* --- Non-geographic ---------------------------------------------------- */
  /* +882 and +883 are international networks with no home country and a long
     history of revenue-share fraud. Explicitly denied rather than merely absent,
     so that a future "allow everything not obviously bad" refactor has to delete
     a line that says why. */
  { prefix: '882', region: 'INTL-NETWORK', allow: false, note: 'Revenue-share fraud' },
  { prefix: '883', region: 'INTL-NETWORK', allow: false, note: 'Revenue-share fraud' },
  /* +881 Global Mobile Satellite, +870 Inmarsat — legitimate, and billed at
     satellite rates measured in dollars per minute. */
  { prefix: '870', region: 'SATELLITE', allow: false, note: 'Satellite rates' },
  { prefix: '881', region: 'SATELLITE', allow: false, note: 'Satellite rates' },
];

export interface GeoVerdict {
  readonly allowed: boolean;
  /** The rule that decided, or `undefined` when nothing matched (a denial). */
  readonly rule: GeoRule | undefined;
}

/**
 * Decides whether a destination may be dialled or messaged.
 *
 * Takes an already-parsed `PhoneNumber` rather than a string, so a caller
 * cannot reach this with `(809) 555-0100` — which contains no `+`, matches no
 * prefix, and would be refused for the wrong reason while looking like the
 * right answer.
 */
export function checkDestination(
  to: PhoneNumber,
  rules: readonly GeoRule[] = GEO_RULES,
): GeoVerdict {
  const digits = to.slice(1);

  let best: GeoRule | undefined;
  for (const rule of rules) {
    if (!digits.startsWith(rule.prefix)) continue;
    /* Longest prefix wins — that is what lets a `deny` on 1809 override the
       `allow` on 1 rather than depending on the array's order. Ordering this
       table by accident is not allowed to change a verdict. */
    if (best === undefined || rule.prefix.length > best.prefix.length) best = rule;
  }

  return { allowed: best?.allow ?? false, rule: best };
}
