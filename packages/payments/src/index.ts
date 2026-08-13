/**
 * @taskflow/payments — the billing carrier boundary (Phase 12 Wave 3,
 * ai/phase-12-wave3.md §3.3).
 *
 * Everything here is a `PaymentProvider` implementation. No pricing policy,
 * no trial logic, no enforcement — those read `identity.orgs` and the outbox,
 * both database questions, and live in `apps/api/src/billing` for the same
 * reason `checkOutboundAllowed` lives in `apps/api/src/telephony` rather than
 * in `@taskflow/telephony`.
 */

export { FakePaymentProvider } from './fake.js';

export { StripePaymentProvider, UnrecognizedBillingEvent, type StripeConfig } from './stripe.js';
