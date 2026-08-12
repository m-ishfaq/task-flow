import { z } from 'zod';
import type { Id } from './ids.js';

/**
 * Telephony value types (PLAN.md §3.4, §8.5; ai/phase-7-voice.md Wave 1).
 *
 * These live in `contracts` rather than in `packages/telephony` because three
 * separate modules have to agree on them and none of them may disagree: the
 * provider interface, the outbound spend/geo gate in `apps/api`, and the
 * inbound webhook handler that resolves an org from a number it was handed by
 * a third party. A second definition of "what a phone number is" is a second
 * chance for a destination to pass one check and fail another.
 */

/* -------------------------------------------------------------------------- *
 * Phone numbers
 * -------------------------------------------------------------------------- */

/**
 * An E.164 phone number — `+` followed by 1-15 digits, no separators.
 *
 * Branded for the same reason ids are (guardrail 1): the geo allowlist and the
 * spend gate both key off the country code parsed from the LEADING digits, so a
 * value that reached them as `(555) 123-4567` or `00441234...` would either
 * parse to the wrong country or to none — and "no country" must never be the
 * quiet path through a default-deny list.
 */
export type PhoneNumber = Id<'PhoneNumber'>;

/**
 * E.164 in its strictest reading: a leading `+`, a first digit of 1-9, and at
 * most 15 digits total.
 *
 * The leading zero is excluded deliberately. `+0...` is not assignable in E.164,
 * but it IS what a naive "prefix the international access code" conversion
 * produces from `0044 20 ...`, and accepting it would make `parseCountryCode`
 * answer for a country that does not exist.
 */
const E164_PATTERN = /^\+[1-9][0-9]{1,14}$/;

export const PhoneNumberSchema = z
  .string()
  .regex(E164_PATTERN, 'must be an E.164 phone number, e.g. +14155550100')
  .transform((value) => value as PhoneNumber);

/**
 * E.164 validation with a PLAIN-STRING output — no brand.
 *
 * The `UuidSchema` pattern from `ids.ts`, applied to phone numbers: a schema
 * whose inferred output is branded cannot have its type emitted by
 * `tsc --declaration`, because the brand symbol is intentionally not exported.
 * That matters for `buildAutomationActionSchema`, whose return type is public
 * and would otherwise name the private symbol. It is also the honest shape for
 * a RULE: `automations.actions` is a jsonb column, so a `to` read back from
 * storage is a plain string anyway, and the executor re-brands it with
 * `unsafeAsPhoneNumber` at the boundary — the same place `UuidSchema`'s
 * consumers brand theirs.
 */
export const PhoneNumberTextSchema = z
  .string()
  .regex(E164_PATTERN, 'must be an E.164 phone number, e.g. +14155550100');

/** Brands an already-validated number. Never call this on external input. */
export function unsafeAsPhoneNumber(value: string): PhoneNumber {
  return value as PhoneNumber;
}

/* -------------------------------------------------------------------------- *
 * Money
 * -------------------------------------------------------------------------- */

/**
 * Every monetary amount in this phase is an INTEGER of cents (USD).
 *
 * Never a float. A spend cap compared with `0.1 + 0.2 > 0.3` is a control that
 * is wrong by a rounding error in the direction of allowing the call, and the
 * ledger that feeds it (§3.4) sums thousands of tiny amounts — precisely the
 * shape that accumulates float error. Postgres `bigint`, TypeScript `number`
 * (safe to 2^53 cents, which is more money than exists).
 */
export const CentsSchema = z.number().int().nonnegative();

/* -------------------------------------------------------------------------- *
 * Why an outbound action was refused
 * -------------------------------------------------------------------------- */

/**
 * The reasons the single outbound gate (ai/phase-7-voice.md §3.3) can refuse.
 *
 * A closed union rather than a free-text string, because these are the values a
 * `SpendLimitExceeded` event carries and an operator alerts on. "Refused" with
 * no machine-readable reason is a log line; this is a control someone can build
 * a page on top of.
 */
export const TELEPHONY_REFUSALS = [
  /** Rolling-window spend would exceed the org's cap (§3.3). */
  'spend_cap_exceeded',
  /** Destination country is not on the allowlist (§3.3, default-deny). */
  'destination_not_allowed',
  /** Too many calls/messages in the velocity window (§3.3). */
  'velocity_exceeded',
  /**
   * The org itself is frozen — `identity.orgs.status <> 'active'`.
   *
   * Distinct from every other reason on purpose: the others say "not this
   * action, right now", this one says "nothing, until an operator says
   * otherwise" (ai/phase-12-admin.md §9).
   */
  'org_suspended',
  /** No Twilio subaccount has been provisioned for this org yet (§3.1). */
  'no_subaccount',
  /**
   * The org's automation SUB-budget is exhausted (Phase 10 Wave 4 §5.5).
   *
   * Distinct from `spend_cap_exceeded`: that one says the ORG is over its
   * cap, this one says the org is fine and the unattended allowance a rule
   * burns against is gone. An operator alerting on one must not be woken by
   * the other, and a rule's run history should be able to say which.
   */
  'automation_budget_exceeded',
] as const;

export type TelephonyRefusal = (typeof TELEPHONY_REFUSALS)[number];
