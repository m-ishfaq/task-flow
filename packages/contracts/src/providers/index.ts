/**
 * Provider interfaces (PLAN.md §5).
 *
 * Every service with a free implementation now and a paid one later sits behind
 * an interface here. Outgrowing a free tier must never require a rewrite — it
 * should be a config change plus a green contract-test run.
 *
 * | Interface        | Free now              | Paid later            | Switch when |
 * | ---------------- | --------------------- | --------------------- | ----------- |
 * | KeyProvider      | software master key   | AWS/GCP KMS           | real user data |
 * | StorageProvider  | MinIO / Cloudflare R2 | S3                    | past 10 GB |
 * | MailProvider     | Mailpit / Resend free | Resend paid / SES     | past 3k/month |
 * | TelephonyProvider| Twilio test creds     | Twilio live / Telnyx  | live demo |
 *
 * Deferred until their phase has a real consumer, because an interface designed
 * without one is a guess:
 *   QueueProvider      Phase 4  (pg-boss, then BullMQ + Redis)
 *   SearchProvider     Phase 8  (Postgres FTS, then Meilisearch)
 *   IdentityProvider   Phase 12 (own auth, then + WorkOS SAML/SCIM)
 *
 * `TelephonyProvider` moved out of that list in Phase 7 Wave 1 — the rule it
 * was waiting on is satisfied twice over: this phase's own outbound gate, and
 * Phase 9's `sms` notification channel, which has been reporting `no_provider`
 * since it shipped (ai/phase-9-notifications.md §3.7).
 */

export type { KeyProvider, WrappedDataKey, DataKey } from './key-provider.js';

export type { MailProvider, MailMessage, MailAddress, MailResult } from './mail-provider.js';

export type {
  StorageProvider,
  PresignedUpload,
  PresignUploadOptions,
  ObjectMetadata,
} from './storage-provider.js';

export type {
  TelephonyProvider,
  TelephonySubaccount,
  SubaccountStatus,
  AvailableNumber,
  PurchasedNumber,
  OutboundKind,
  PlaceCallOptions,
  CallResult,
  SendSmsOptions,
  MessageResult,
  NumberLookup,
  VerificationChannel,
  VerificationStart,
  VerificationCheck,
} from './telephony-provider.js';
