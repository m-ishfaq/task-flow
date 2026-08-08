import { describe, expect, it } from 'vitest';
import { PhoneNumberSchema } from '@taskflow/contracts';
import { checkDestination, GEO_RULES } from './geo.js';

const number = (value: string) => PhoneNumberSchema.parse(value);

describe('checkDestination', () => {
  it('allows an ordinary US number', () => {
    expect(checkDestination(number('+14155550100')).allowed).toBe(true);
  });

  it('allows the allowlisted European destinations', () => {
    expect(checkDestination(number('+442071234567')).allowed).toBe(true);
    expect(checkDestination(number('+4915112345678')).allowed).toBe(true);
    expect(checkDestination(number('+353871234567')).allowed).toBe(true);
  });

  it('DENIES a country absent from the table, which is the default', () => {
    // Not a judgement about these destinations — the point is that anything the
    // table does not name is refused rather than passed through.
    expect(checkDestination(number('+8613800138000')).allowed).toBe(false);
    expect(checkDestination(number('+552199999999')).allowed).toBe(false);
    expect(checkDestination(number('+2348012345678')).allowed).toBe(false);
  });

  /**
   * The case this module's prefix matching exists for.
   *
   * `+1809...` is a Dominican Republic premium destination that presents as an
   * ordinary North American number. A geo check that resolved "+1" to a country
   * and then asked whether that country is allowed would permit every one of
   * these, and the resulting bill is the failure mode PLAN.md §8.5 calls the
   * most expensive in the system.
   */
  describe('NANP carve-outs — a +1 number that is not the US or Canada', () => {
    const premium = [
      '+18095550100', // Dominican Republic
      '+18295550100',
      '+18495550100',
      '+18765550100', // Jamaica
      '+12425550100', // Bahamas
      '+18685550100', // Trinidad
      '+16495550100', // Turks and Caicos
      '+13455550100', // Cayman
    ];

    for (const value of premium) {
      it(`denies ${value}`, () => {
        const verdict = checkDestination(number(value));
        expect(verdict.allowed).toBe(false);
        // Denied by a rule that names it, not by falling off the end of the
        // table — those two are the same answer for different reasons, and only
        // one of them survives someone adding a broader allow rule later.
        expect(verdict.rule?.allow).toBe(false);
      });
    }

    it('denies US pay-per-call ranges', () => {
      expect(checkDestination(number('+19005550100')).allowed).toBe(false);
      expect(checkDestination(number('+19765550100')).allowed).toBe(false);
    });
  });

  it('denies UK premium ranges carved out of the allowed +44', () => {
    expect(checkDestination(number('+442071234567')).allowed).toBe(true);
    expect(checkDestination(number('+449012345678')).allowed).toBe(false);
    expect(checkDestination(number('+447012345678')).allowed).toBe(false);
  });

  it('denies satellite and international-network ranges', () => {
    expect(checkDestination(number('+8811234567890')).allowed).toBe(false);
    expect(checkDestination(number('+8821234567')).allowed).toBe(false);
    expect(checkDestination(number('+8701234567')).allowed).toBe(false);
  });

  it('resolves by longest prefix, not by table order', () => {
    /* Reversing the table must not change a single verdict. If it does, the
       carve-outs are working by accident — they would then silently invert the
       day someone sorts this file alphabetically. */
    const reversed = [...GEO_RULES].reverse();
    for (const value of ['+14155550100', '+18095550100', '+442071234567', '+449012345678']) {
      expect(checkDestination(number(value), reversed).allowed).toBe(
        checkDestination(number(value)).allowed,
      );
    }
  });

  it('denies a number matching no rule at all, with no rule to show for it', () => {
    const verdict = checkDestination(number('+9995550100'));
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBeUndefined();
  });
});

describe('GEO_RULES', () => {
  it('has no duplicate prefixes', () => {
    // Two rules on one prefix means the verdict depends on iteration order,
    // which `checkDestination`'s longest-match tie-break cannot resolve.
    const seen = new Set<string>();
    for (const rule of GEO_RULES) {
      expect(seen.has(rule.prefix), `duplicate prefix ${rule.prefix}`).toBe(false);
      seen.add(rule.prefix);
    }
  });

  it('contains only digits in prefixes', () => {
    // A prefix written as '+44' would never match, because `checkDestination`
    // strips the leading '+' before comparing — and it would fail silently, as
    // a destination that is simply denied.
    for (const rule of GEO_RULES) {
      expect(rule.prefix, `${rule.prefix} is not bare digits`).toMatch(/^[0-9]+$/);
    }
  });
});
