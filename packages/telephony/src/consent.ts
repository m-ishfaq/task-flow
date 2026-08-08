import type { PhoneNumber } from '@taskflow/contracts';

/**
 * Recording-consent jurisdiction detection (PLAN.md §8.5 — "Consent gate before
 * recording begins · jurisdiction detected via Twilio Lookup · two-party-consent
 * regions get an enforced announcement · consent event written to the audit
 * log"; ai/phase-7-voice.md §3.5).
 *
 * ## What "two-party consent" means here, and what this file is not
 *
 * In a one-party-consent jurisdiction, one participant knowing the call is
 * recorded is enough. In an ALL-PARTY (commonly "two-party") jurisdiction every
 * participant must consent, and recording without it is a criminal offence in
 * several of the places listed below — not a compliance finding, an offence.
 *
 * **This is not legal advice and this table is not a legal authority.** It is a
 * conservative engineering approximation whose only job is to decide when the
 * server must play an announcement before it will start recording. It errs
 * toward requiring the announcement, and the practical consequence of erring is
 * that a caller hears a sentence they did not strictly need to hear.
 *
 * ## The default is ALL-PARTY, which is the opposite of the geo allowlist
 *
 * `geo.ts` defaults to DENY because an unknown destination is a possible fraud.
 * Here an unknown jurisdiction defaults to requiring consent, because the
 * failure modes are wildly asymmetric: a needless announcement costs three
 * seconds, and a missing one is an illegal recording. Anything this table
 * cannot place gets the strictest treatment available.
 *
 * ## Why a table and not a Twilio Lookup call for the rule itself
 *
 * Lookup tells us the COUNTRY (and, for +1, nothing about which state). It does
 * not know consent law. So Lookup provides the input — an ISO country — and
 * this table provides the rule, with the US handled by area code because US
 * consent law is state-level and a country-level answer for +1 would be wrong
 * for roughly a quarter of the country.
 */

export type ConsentRule = 'all_party' | 'one_party';

export interface ConsentRequirement {
  readonly rule: ConsentRule;
  /** Whether the server must play audio before recording may start. */
  readonly announcementRequired: boolean;
  /** What decided it. Written to the audit entry, never used in a decision. */
  readonly basis: string;
}

/**
 * US area codes in states that require ALL-party consent.
 *
 * State-level, not country-level, and this is the reason `checkDestination` and
 * this function do not share a table: for fraud, +1 is one namespace with
 * carve-outs; for consent, +1 is fifty jurisdictions with different laws.
 *
 * Covers the states commonly treated as all-party: California, Connecticut,
 * Delaware, Florida, Illinois, Maryland, Massachusetts, Michigan, Montana,
 * Nevada, New Hampshire, Oregon, Pennsylvania, Washington. An area code absent
 * from this set is NOT assumed one-party — see `usConsent` below, which only
 * grants one-party status to area codes it positively recognises.
 */
const US_ALL_PARTY_AREA_CODES = new Set([
  // California
  '209', '213', '279', '310', '323', '341', '350', '408', '415', '424', '442',
  '510', '530', '559', '562', '619', '626', '628', '650', '657', '661', '669',
  '707', '714', '747', '760', '805', '818', '820', '831', '840', '858', '909',
  '916', '925', '949', '951',
  // Connecticut
  '203', '475', '860', '959',
  // Delaware
  '302',
  // Florida
  '239', '305', '321', '324', '352', '386', '407', '448', '561', '656', '689',
  '727', '754', '772', '786', '813', '850', '863', '904', '941', '954',
  // Illinois
  '217', '224', '309', '312', '331', '447', '464', '618', '630', '708', '730',
  '773', '779', '815', '847', '872',
  // Maryland
  '227', '240', '301', '410', '443', '667',
  // Massachusetts
  '339', '351', '413', '508', '617', '774', '781', '857', '978',
  // Michigan
  '231', '248', '269', '313', '517', '586', '616', '679', '734', '810', '906',
  '947', '989',
  // Montana
  '406',
  // Nevada
  '702', '725', '775',
  // New Hampshire
  '603',
  // Oregon
  '458', '503', '541', '971',
  // Pennsylvania
  '215', '223', '267', '272', '412', '445', '484', '570', '582', '610', '717',
  '724', '814', '835', '878',
  // Washington
  '206', '253', '360', '425', '509', '564',
]);

/**
 * Countries treated as ONE-party consent.
 *
 * A closed positive list, exactly like `geo.ts`: membership grants the weaker
 * requirement, and absence means the strict default. Adding a country here is a
 * deliberate, reviewable claim that its law permits one-party recording — which
 * is precisely the kind of claim that should require a diff and a human.
 */
const ONE_PARTY_COUNTRIES = new Set(['CA', 'GB', 'IE', 'NZ', 'IN', 'ZA']);

/**
 * The strict default, returned whenever nothing positively establishes
 * otherwise.
 */
const STRICT: ConsentRequirement = {
  rule: 'all_party',
  announcementRequired: true,
  basis: 'unknown_jurisdiction_default',
};

/**
 * Decides the consent requirement for a call to `to`.
 *
 * `isoCountry` comes from Twilio Lookup (§3.5) and is optional: a lookup can
 * fail, and when it does the answer is the strict default rather than an error.
 * A consent check that throws when the carrier is slow would either block the
 * call or — far worse, and the usual outcome — get wrapped in a try/catch that
 * proceeds without recording consent.
 */
export function consentRequirementFor(
  to: PhoneNumber,
  isoCountry?: string,
): ConsentRequirement {
  const digits = to.slice(1);

  /* +1 is resolved by AREA CODE before country, because US consent law is
     state-level. Canada is one-party nationally, so a +1 number is only given
     the weaker rule once it is known to be Canadian — which Lookup can say and
     the area code alone cannot. */
  if (digits.startsWith('1')) return nanpConsent(digits, isoCountry);

  if (isoCountry === undefined) return STRICT;

  if (ONE_PARTY_COUNTRIES.has(isoCountry.toUpperCase())) {
    return {
      rule: 'one_party',
      announcementRequired: false,
      basis: `one_party_country:${isoCountry.toUpperCase()}`,
    };
  }

  return { rule: 'all_party', announcementRequired: true, basis: `all_party_country:${isoCountry}` };
}

function nanpConsent(digits: string, isoCountry: string | undefined): ConsentRequirement {
  const areaCode = digits.slice(1, 4);

  if (US_ALL_PARTY_AREA_CODES.has(areaCode)) {
    return { rule: 'all_party', announcementRequired: true, basis: `us_all_party_npa:${areaCode}` };
  }

  if (isoCountry?.toUpperCase() === 'CA') {
    return { rule: 'one_party', announcementRequired: false, basis: 'one_party_country:CA' };
  }

  /* A US area code not in the all-party set.
   *
   * Deliberately NOT treated as one-party. Area codes are added, split, and
   * overlaid regularly, so an unrecognised one is at least as likely to be a
   * new code in California as it is to be in a one-party state — and the table
   * above cannot be assumed current. Being wrong in the permissive direction
   * here means recording someone illegally. */
  if (isoCountry?.toUpperCase() === 'US') {
    return { rule: 'all_party', announcementRequired: true, basis: `us_unlisted_npa:${areaCode}` };
  }

  return STRICT;
}

/**
 * The announcement played before recording starts in an all-party jurisdiction.
 *
 * Plain, short, and unambiguous. It is spoken by the carrier's TTS into the live
 * call — see `twiml.ts` — BEFORE the recording begins, which is the distinction
 * §3.5 draws between a control and a checkbox in a settings page.
 */
export const RECORDING_ANNOUNCEMENT =
  'This call may be recorded for quality and training purposes.';
