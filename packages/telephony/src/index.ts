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

/* `describeTelephonyProviderContract` is DELIBERATELY not re-exported from
   this entry, even though a future `TelephonyProvider` in another package must
   be able to run the suite: `contract-test.ts` imports vitest at its top level,
   and re-exporting it would drag vitest into the runtime graph of every
   consumer. apps/api boots through `@taskflow/telephony` and crashed outside a
   test worker with "Vitest failed to access its internal state." (the eager
   `createExpect` in vitest's `vi` chunk throws when no worker state exists).
   The suite stays reachable to other packages through the
   `@taskflow/telephony/contract-test` subpath export (package.json) — import
   that only from test code, never from a runtime module. */
