import { SoftwareKeyProvider } from '@taskflow/security';
import { S3StorageProvider } from '@taskflow/storage';
import { TwilioTelephonyProvider } from '@taskflow/telephony';
import type { KeyProvider, StorageProvider, TelephonyProvider } from '@taskflow/contracts';
import type { Env } from '../config/env.js';

/**
 * Wiring for the telephony module (ai/phase-7-voice.md §6.4).
 *
 * Built from the validated environment rather than `process.env` (guardrail 3),
 * and constructed once at boot.
 *
 * ## Returns undefined when the carrier is not configured, and that is the point
 *
 * An API instance serving Work and Chat with no Twilio credentials is a
 * completely valid deployment — and a developer running this app must not need
 * a Twilio account. So the credentials are optional in the env schema, and this
 * returns `undefined` rather than constructing a half-configured provider.
 *
 * The consequence is deliberately shaped to fail CLOSED: a caller with no deps
 * has nothing to call, so telephony routes are UNREGISTERED rather than
 * registered-and-broken. The alternative — a provider built with empty strings
 * — produces a Basic auth header that authenticates as nobody, and the failure
 * arrives as a 401 from the carrier at the first click-to-call, which reads as
 * "Twilio is down" rather than "this instance was never configured".
 */

export interface TelephonyDeps {
  readonly telephony: TelephonyProvider;
  readonly keys: KeyProvider;
  /**
   * Blind-index key for counterparty phone numbers (Wave 2).
   *
   * Separate from the master key so one compromise does not both decrypt the
   * column and let an attacker generate indexes to confirm guesses against it.
   */
  readonly indexKey: Uint8Array;
  readonly storage: StorageProvider | undefined;
  readonly recordingsBucket: string | undefined;
  /** §7.2's resolved default, for orgs with no explicit spend policy row. */
  readonly defaultSpendCapCents: number;
  /** The ceiling no self-service cap raise may exceed (§7.2). */
  readonly maxSpendCapCents: number;
  /** Absolute origin the carrier signs webhook URLs against (§3.11). */
  readonly webhookOrigin: string | undefined;
}

export function buildTelephonyDeps(env: Env): TelephonyDeps | undefined {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;

  if (accountSid === undefined || authToken === undefined) return undefined;

  /* The index key is REQUIRED once a carrier is configured, and this refuses at
     boot rather than at the first call.

     There is no safe default. Falling back to the master key would defeat the
     separation the key exists for; generating one per process would make every
     restart produce indexes that no longer match the rows already stored, and
     the symptom would be inbound messages silently starting new threads rather
     than anything that looks like a failure. */
  if (env.TELEPHONY_INDEX_KEY === undefined) {
    throw new Error(
      'TELEPHONY_INDEX_KEY is required when TWILIO_ACCOUNT_SID is set — it keys the ' +
        'blind index for counterparty phone numbers. Generate 32 random bytes, base64.',
    );
  }

  const telephony = new TwilioTelephonyProvider({
    accountSid,
    authToken,
    verifyServiceSid: env.TWILIO_VERIFY_SERVICE_SID,
    /* Test credentials are the ONLY thing Wave 1 is exercised against
       (ai/phase-7-voice.md §8, PLAN.md §14 — the whole phase is budgeted at ~$2
       precisely because the rails are built and tested before a real number is
       ever purchased). Twilio's test credentials carry a distinct SID prefix,
       so this is derived rather than configured: a separate boolean could
       disagree with the credentials actually in use, and the direction it would
       disagree in is "we thought we were in test mode". */
    isLive: !accountSid.startsWith('ACtest') && !isTestCredential(accountSid),
  });

  return {
    telephony,
    keys: new SoftwareKeyProvider({
      currentMasterKeyId: env.MASTER_KEY_ID,
      masterKeys: [
        {
          id: env.MASTER_KEY_ID,
          key: new Uint8Array(Buffer.from(env.MASTER_KEY_BASE64, 'base64')),
        },
      ],
    }),
    indexKey: new Uint8Array(Buffer.from(env.TELEPHONY_INDEX_KEY, 'base64')),
    /* Recordings go to their OWN bucket, not the attachments one. Different
       retention, different access rules, and a bucket-level lifecycle policy on
       recordings must not touch a card's attachments. */
    storage:
      env.STORAGE_BUCKET_RECORDINGS === undefined
        ? undefined
        : new S3StorageProvider({
            endpoint: env.STORAGE_ENDPOINT,
            region: env.STORAGE_REGION,
            bucket: env.STORAGE_BUCKET_RECORDINGS,
            accessKeyId: env.STORAGE_ACCESS_KEY_ID,
            secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
            forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
          }),
    recordingsBucket: env.STORAGE_BUCKET_RECORDINGS,
    defaultSpendCapCents: env.TELEPHONY_DEFAULT_SPEND_CAP_CENTS,
    maxSpendCapCents: env.TELEPHONY_MAX_SPEND_CAP_CENTS,
    webhookOrigin: env.TELEPHONY_WEBHOOK_ORIGIN,
  };
}

/**
 * Whether a Twilio account SID belongs to the test credential set.
 *
 * Twilio's test credentials are a separate SID/token pair on the same account,
 * documented as producing no charges and reaching no real handsets. There is no
 * field in the SID that marks them, so this is a configured convention rather
 * than a derived fact — which is why `isLive` defaults to TRUE for anything
 * unrecognised. Guessing "test" for an unknown credential is guessing that
 * spending is free, and that is the wrong way for this to be wrong.
 */
function isTestCredential(accountSid: string): boolean {
  return accountSid.startsWith('ACtest') || accountSid === 'AC00000000000000000000000000000000';
}
