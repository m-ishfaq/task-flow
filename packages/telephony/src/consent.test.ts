import { describe, expect, it } from 'vitest';
import { PhoneNumberSchema } from '@taskflow/contracts';
import { consentRequirementFor } from './consent.js';

const number = (value: string) => PhoneNumberSchema.parse(value);

describe('consentRequirementFor', () => {
  describe('the default is STRICT, which is the opposite of the geo allowlist', () => {
    it('requires an announcement when the jurisdiction is unknown', () => {
      /* geo.ts defaults to DENY because an unknown destination is possible
         fraud. Here an unknown jurisdiction defaults to requiring consent,
         because the failure modes are wildly asymmetric: a needless
         announcement costs three seconds, a missing one is an illegal
         recording. */
      const verdict = consentRequirementFor(number('+4915112345678'));
      expect(verdict.rule).toBe('all_party');
      expect(verdict.announcementRequired).toBe(true);
    });

    it('requires an announcement for a country not on the one-party list', () => {
      const verdict = consentRequirementFor(number('+4915112345678'), 'DE');
      expect(verdict.announcementRequired).toBe(true);
    });
  });

  describe('US consent is decided by AREA CODE, because the law is state-level', () => {
    it('requires an announcement for all-party states', () => {
      // California, Illinois, Florida, Pennsylvania, Washington, Massachusetts.
      for (const value of [
        '+14155550100',
        '+13125550100',
        '+13055550100',
        '+12155550100',
        '+12065550100',
        '+16175550100',
      ]) {
        expect(consentRequirementFor(number(value), 'US').announcementRequired, value).toBe(true);
      }
    });

    it('does NOT assume one-party for an unrecognised US area code', () => {
      /* Area codes are split and overlaid constantly, so an unlisted one is at
         least as likely to be a new California code as a one-party state. Being
         wrong in the permissive direction here means recording illegally. */
      const verdict = consentRequirementFor(number('+19995550100'), 'US');
      expect(verdict.announcementRequired).toBe(true);
      expect(verdict.basis).toContain('us_unlisted_npa');
    });

    it('treats a +1 number as strict when the country is unknown', () => {
      // Could be a US all-party state; nothing has said otherwise.
      expect(consentRequirementFor(number('+18885550100')).announcementRequired).toBe(true);
    });
  });

  describe('one-party jurisdictions', () => {
    it('does not require an announcement for Canada', () => {
      const verdict = consentRequirementFor(number('+16475550100'), 'CA');
      expect(verdict.rule).toBe('one_party');
      expect(verdict.announcementRequired).toBe(false);
    });

    it('does not require an announcement for the UK or Ireland', () => {
      expect(consentRequirementFor(number('+442071234567'), 'GB').announcementRequired).toBe(false);
      expect(consentRequirementFor(number('+353871234567'), 'IE').announcementRequired).toBe(false);
    });

    it('still applies the US area-code rule to a +1 number claimed as Canadian', () => {
      /* A California area code with an isoCountry of CA is a contradiction —
         Lookup being wrong, or a spoofed input. The stricter of the two answers
         wins, because the cost of being wrong is asymmetric. */
      const verdict = consentRequirementFor(number('+14155550100'), 'CA');
      expect(verdict.announcementRequired).toBe(true);
    });
  });

  it('records a basis for the audit entry without inventing a legal claim', () => {
    const verdict = consentRequirementFor(number('+14155550100'), 'US');
    expect(verdict.basis).toMatch(/^us_all_party_npa:415$/);
  });

  it('is case-insensitive about the ISO country', () => {
    expect(consentRequirementFor(number('+442071234567'), 'gb').announcementRequired).toBe(false);
  });
});
