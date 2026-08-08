/**
 * @taskflow/telephony — the carrier boundary (PLAN.md §3.4, §5, §8.5).
 *
 * Everything in this package is either a `TelephonyProvider` implementation or
 * a PURE decision about a destination. Two things are deliberately absent:
 *
 *   - **The outbound gate.** `checkOutboundAllowed` lives in
 *     `apps/api/src/telephony/spend-gate.ts`, because it reads the spend ledger
 *     and the org's suspension status — both database questions. The geo half
 *     of the decision is here (`checkDestination`) precisely because it is the
 *     half that needs no database and can therefore be exhaustively tested.
 *   - **Cryptography.** The webhook signature is `@taskflow/security`'s
 *     `verifyTwilioSignature`; this package cannot import `node:crypto` at all
 *     (guardrail 5), and the providers here delegate to it.
 */

export { GEO_RULES, checkDestination, type GeoRule, type GeoVerdict } from './geo.js';

export {
  consentRequirementFor,
  RECORDING_ANNOUNCEMENT,
  type ConsentRule,
  type ConsentRequirement,
} from './consent.js';

export { redactTranscript, passesLuhn, type RedactionResult } from './redact.js';

export {
  InboundRoute,
  escapeXml,
  routeToTwiml,
  menuChoiceToTwiml,
  outboundTwiml,
  type InboundRouteConfig,
  type LeafRouteAction,
  type TwimlContext,
} from './twiml.js';

export {
  TwilioTelephonyProvider,
  TwilioApiError,
  priceToCents,
  type TwilioConfig,
} from './twilio.js';

export { FakeTelephonyProvider, type FakeCall, type FakeMessage } from './fake.js';

/**
 * The shared contract suite (§5).
 *
 * Exported from the package index on purpose: a future `TelephonyProvider` in
 * another package must be able to run it, and a suite that only the package
 * defining it can reach is one a second implementation quietly does not run.
 */
export { describeTelephonyProviderContract } from './contract-test.js';
