import type { PhoneNumber } from '../telephony.js';

/**
 * TelephonyProvider — voice and messaging carrier (PLAN.md §5, §8.5).
 *
 * Implementations:
 *   TwilioTelephonyProvider   Twilio test credentials   (free tier, now)
 *   TwilioTelephonyProvider   Twilio live credentials   (live demo, ~$2/mo)
 *   Telnyx / SignalWire       —                         (never built; see below)
 *
 * Unlike `StorageProvider`, where three implementations speak one API and the
 * interface exists to pin SECURITY behaviour, this interface exists to pin
 * something narrower and more expensive: **every method here can spend the
 * org's money, and none of them may be called without passing the gate first.**
 *
 * Two properties are load-bearing:
 *
 *   - **Every spending method returns what it cost.** Not "success/failure" —
 *     `costCents`, so the caller can write the ledger row in the same
 *     transaction as the record of what happened (ai/phase-7-voice.md §3.4).
 *     An implementation that cannot report a cost must return its conservative
 *     ESTIMATE rather than zero: a ledger that under-reports is a spend cap
 *     that never trips.
 *   - **`estimateCost` is separate from doing the thing.** The gate needs a
 *     price BEFORE committing to a call, because a cap checked afterwards is a
 *     report rather than a control (§3.3). Pricing knowledge lives here, in the
 *     provider that knows its own rate card, and not in the gate.
 *
 * Nothing in this interface performs an authorization or fraud check. That is
 * deliberate and is the reason `checkOutboundAllowed` exists as a separate
 * function every caller routes through — a provider that policed its own
 * callers would put the control on the far side of the boundary it is meant to
 * defend, and a second implementation could then quietly not have it.
 */

/* -------------------------------------------------------------------------- *
 * Subaccounts — the tenancy boundary (§3.1)
 * -------------------------------------------------------------------------- */

/**
 * A newly created carrier subaccount.
 *
 * `authToken` is a live credential in plaintext and exists in memory for
 * exactly as long as it takes to wrap it with the org's data key. It is never
 * logged (`REDACTION_PATHS` covers `*.authToken`), never returned from a route,
 * and never stored unwrapped.
 */
export interface TelephonySubaccount {
  readonly sid: string;
  readonly authToken: string;
  readonly friendlyName: string;
}

export type SubaccountStatus = 'active' | 'suspended' | 'closed';

/* -------------------------------------------------------------------------- *
 * Numbers
 * -------------------------------------------------------------------------- */

export interface AvailableNumber {
  readonly phoneNumber: PhoneNumber;
  readonly locality: string | undefined;
  readonly region: string | undefined;
  /** ISO 3166-1 alpha-2, as the carrier reports it. */
  readonly isoCountry: string;
  readonly monthlyCostCents: number;
}

export interface PurchasedNumber {
  readonly sid: string;
  readonly phoneNumber: PhoneNumber;
  readonly monthlyCostCents: number;
}

/**
 * A number the account ALREADY OWNS.
 *
 * Deliberately a separate type from `AvailableNumber`, which describes a
 * number on sale that nobody holds yet. Conflating them is how a caller ends
 * up passing a for-sale number where an owned one belongs — and the only way
 * to turn the first into the second is `purchaseNumber`, which spends money.
 */
export interface OwnedNumber {
  readonly sid: string;
  readonly phoneNumber: PhoneNumber;
  /** ISO 3166-1 alpha-2, as the carrier reports it. */
  readonly isoCountry: string;
  readonly capabilities: {
    readonly voice: boolean;
    readonly sms: boolean;
  };
}

/* -------------------------------------------------------------------------- *
 * Outbound actions
 * -------------------------------------------------------------------------- */

/** What an outbound action can be. Keyed by this in the gate and the ledger. */
export type OutboundKind = 'call' | 'sms' | 'number_purchase' | 'verification';

export interface PlaceCallOptions {
  readonly from: PhoneNumber;
  readonly to: PhoneNumber;
  /** Absolute URL the carrier fetches call instructions from. */
  readonly instructionsUrl: string;
  /** Absolute URL the carrier POSTs status changes to. Signature-verified. */
  readonly statusCallbackUrl: string;
}

export interface CallResult {
  readonly sid: string;
  readonly status: string;
  /** Estimate at placement time; corrected by the carrier's own billing hook. */
  readonly costCents: number;
}

export interface SendSmsOptions {
  readonly from: PhoneNumber;
  readonly to: PhoneNumber;
  readonly body: string;
  readonly statusCallbackUrl: string;
}

export interface MessageResult {
  readonly sid: string;
  readonly status: string;
  readonly segments: number;
  readonly costCents: number;
}

/* -------------------------------------------------------------------------- *
 * Lookup — jurisdiction detection for the consent gate (§3.5)
 * -------------------------------------------------------------------------- */

export interface NumberLookup {
  readonly phoneNumber: PhoneNumber;
  /** ISO 3166-1 alpha-2. `undefined` when the carrier cannot determine it. */
  readonly isoCountry: string | undefined;
  readonly lineType: 'mobile' | 'landline' | 'voip' | 'unknown';
}

/* -------------------------------------------------------------------------- *
 * Verification — the MFA fallback (§3.12)
 * -------------------------------------------------------------------------- */

export type VerificationChannel = 'sms' | 'call';

export interface VerificationStart {
  readonly sid: string;
  readonly status: string;
  readonly costCents: number;
}

export interface VerificationCheck {
  /**
   * Whether the submitted code was correct.
   *
   * A boolean, not a status string, because every caller reduces it to one
   * anyway and a provider whose "approved" spelling differs would otherwise be
   * compared with `=== 'approved'` at a call site in `apps/api/src/identity`.
   */
  readonly approved: boolean;
}

/* -------------------------------------------------------------------------- *
 * The interface
 * -------------------------------------------------------------------------- */

export interface TelephonyProvider {
  /**
   * Whether this instance is wired to credentials that spend real money.
   *
   * Not cosmetic: the gate refuses to be bypassed in either mode, but a test
   * fixture asserting "no real spend occurred" needs to be able to prove it was
   * talking to test credentials, rather than trusting that it was.
   */
  readonly isLive: boolean;

  /* --- Subaccounts ------------------------------------------------------- */

  createSubaccount(options: { readonly friendlyName: string }): Promise<TelephonySubaccount>;

  /**
   * Suspends a subaccount AT THE CARRIER.
   *
   * The org-freeze check in the gate stops this application from spending, and
   * a leaked subaccount credential is not bound by it — the carrier's API
   * answers to whoever holds the token, not to us. This is the second half of
   * that control (ai/phase-12-admin.md §9's stretch goal, made a real method
   * because an interface that cannot express it guarantees it never happens).
   */
  setSubaccountStatus(sid: string, status: SubaccountStatus): Promise<void>;

  /* --- Numbers ----------------------------------------------------------- */

  searchAvailableNumbers(options: {
    readonly subaccountSid: string;
    /** ISO 3166-1 alpha-2. */
    readonly isoCountry: string;
    readonly areaCode?: string | undefined;
    readonly limit: number;
  }): Promise<readonly AvailableNumber[]>;

  /**
   * The numbers an account ALREADY HOLDS. Read-only; spends nothing.
   *
   * Distinct from `searchAvailableNumbers`, which lists numbers for sale that
   * the account does not own. The distinction matters more than it looks:
   * "give me a number I can send from" is answered by this method, and
   * answering it with the search method instead would return a number that
   * only becomes usable by BUYING it.
   *
   * `accountSid` defaults to the account the provider was constructed with.
   * Passing a subaccount's sid lists that subaccount's numbers instead —
   * which is the form the org-scoped services want, while the default form is
   * what a tool holding only the master credentials (the seeder) can use.
   */
  listOwnedNumbers(options?: {
    readonly accountSid?: string | undefined;
  }): Promise<readonly OwnedNumber[]>;

  purchaseNumber(options: {
    readonly subaccountSid: string;
    readonly phoneNumber: PhoneNumber;
    readonly voiceUrl: string;
    readonly smsUrl: string;
  }): Promise<PurchasedNumber>;

  releaseNumber(options: {
    readonly subaccountSid: string;
    readonly numberSid: string;
  }): Promise<void>;

  /* --- Outbound ---------------------------------------------------------- */

  placeCall(options: PlaceCallOptions & { readonly subaccountSid: string }): Promise<CallResult>;

  sendSms(options: SendSmsOptions & { readonly subaccountSid: string }): Promise<MessageResult>;

  /* --- Lookup ------------------------------------------------------------ */

  lookupNumber(phoneNumber: PhoneNumber): Promise<NumberLookup>;

  /* --- Verification ------------------------------------------------------ */

  startVerification(options: {
    readonly to: PhoneNumber;
    readonly channel: VerificationChannel;
  }): Promise<VerificationStart>;

  checkVerification(options: {
    readonly to: PhoneNumber;
    readonly code: string;
  }): Promise<VerificationCheck>;

  /* --- Pricing ----------------------------------------------------------- */

  /**
   * The gate's input (§3.3). Must be an OVER-estimate when uncertain.
   *
   * Rounding an unknown price down to zero would let an unlimited number of
   * unpriced actions through a cap that never sees them coming; rounding up
   * refuses a legitimate call near the ceiling, which is the direction a spend
   * control is supposed to fail in.
   */
  estimateCostCents(options: {
    readonly kind: OutboundKind;
    readonly to: PhoneNumber;
  }): Promise<number>;

  /**
   * Verifies an inbound webhook's signature against the exact URL and body the
   * carrier signed.
   *
   * On the provider because the algorithm is the carrier's, not ours — but note
   * that this is the ONLY method here that is a security control rather than an
   * action, and it is the one an implementation must not "improve".
   */
  verifyWebhookSignature(options: {
    readonly url: string;
    readonly signature: string;
    readonly params: Readonly<Record<string, string>>;
    readonly authToken: string;
  }): boolean;
}
