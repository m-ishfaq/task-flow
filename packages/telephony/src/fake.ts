import { verifyTwilioSignature } from '@taskflow/security';
import type {
  AvailableNumber,
  CallResult,
  MessageResult,
  NumberLookup,
  OutboundKind,
  OwnedNumber,
  PhoneNumber,
  PurchasedNumber,
  SubaccountStatus,
  TelephonyProvider,
  TelephonySubaccount,
  VerificationCheck,
  VerificationStart,
} from '@taskflow/contracts';
import { checkDestination } from './geo.js';

/**
 * An in-memory `TelephonyProvider` (ai/phase-7-voice.md Wave 1).
 *
 * ## What this is for, and what it must never become
 *
 * Two callers: the contract test suite (`contract-test.ts`), and every test in
 * `apps/api` that needs to prove the outbound gate refused **before** a provider
 * was reached. That second one is Wave 1's entire acceptance bar, and it needs
 * something that RECORDS being called rather than something that works — hence
 * `calls`, `messages`, and the rest below.
 *
 * This is not a Twilio simulator and must not grow into one. It does not
 * implement TwiML, does not model call progress, and answers `estimateCostCents`
 * from a flat table. The moment a test needs more fidelity than this, the thing
 * it actually needs is Twilio's own test credentials against the real provider.
 *
 * The one behaviour it does share with the real provider is the geo refusal: a
 * fake that happily "places" a call to `+1809...` would let a test assert the
 * gate is wired when it is not.
 */

export interface FakeCall {
  readonly subaccountSid: string;
  readonly from: PhoneNumber;
  readonly to: PhoneNumber;
}

export interface FakeMessage {
  readonly subaccountSid: string;
  readonly from: PhoneNumber;
  readonly to: PhoneNumber;
  readonly body: string;
}

/**
 * Flat per-action prices, in cents.
 *
 * Rounded UP against real Twilio US rates, per the interface's own rule that an
 * estimate must over-state when uncertain: an estimate that under-states is a
 * spend cap that lets more through than it was configured to.
 */
const PRICES: Readonly<Record<OutboundKind, number>> = {
  call: 2,
  sms: 1,
  number_purchase: 115,
  verification: 5,
};

export class FakeTelephonyProvider implements TelephonyProvider {
  readonly isLive = false;

  readonly subaccounts = new Map<string, { status: SubaccountStatus; friendlyName: string }>();
  readonly calls: FakeCall[] = [];
  readonly messages: FakeMessage[] = [];
  readonly purchasedNumbers: PurchasedNumber[] = [];
  /**
   * Numbers the account is to be treated as ALREADY holding, before any
   * purchase — the state a real account is in on day one, which
   * `purchasedNumbers` alone cannot express.
   */
  readonly ownedNumbers: OwnedNumber[] = [];
  readonly verifications = new Map<string, string>();

  /** Set by a test to make the next provider call throw, for fail-path cases. */
  failNext: Error | undefined;

  #counter = 0;

  #sid(prefix: string): string {
    this.#counter += 1;
    return `${prefix}${String(this.#counter).padStart(32, '0')}`;
  }

  /**
   * Async so that every caller has a real `await`, and so that its throw is a
   * REJECTION rather than a synchronous throw from a `Promise`-returning
   * method — see the note above `createSubaccount` for why that distinction
   * matters. Awaiting it is also what makes each method's `async` genuine
   * rather than something `require-await` would (correctly) flag as decorative.
   */
  async #maybeFail(): Promise<void> {
    await Promise.resolve();
    if (this.failNext !== undefined) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
  }

  /** Total spent through this provider. Tests assert this stayed at zero. */
  get spentCents(): number {
    return (
      this.calls.length * PRICES.call +
      this.messages.length * PRICES.sms +
      this.purchasedNumbers.length * PRICES.number_purchase
    );
  }

  reset(): void {
    this.subaccounts.clear();
    this.calls.length = 0;
    this.messages.length = 0;
    this.purchasedNumbers.length = 0;
    this.verifications.clear();
    this.failNext = undefined;
  }

  /* --- Subaccounts ------------------------------------------------------- */

  /*
   * Every method below is `async`, and none of them may stop being so.
   *
   * These bodies throw — on a disallowed destination, on an injected failure —
   * and a method DECLARED `Promise<T>` that throws synchronously is a different
   * thing from one that rejects. `provider.placeCall(...).catch(handle)` never
   * reaches `.catch`; the throw escapes at the call site instead, past every
   * caller written to handle a rejection. `async` guarantees the throw becomes
   * a rejection. A test caught this, and it would otherwise have shown up as
   * the gate's own error handling being bypassed in exactly the failure cases
   * it exists for.
   */
  async createSubaccount(options: { readonly friendlyName: string }): Promise<TelephonySubaccount> {
    await this.#maybeFail();
    const sid = this.#sid('AC');
    this.subaccounts.set(sid, { status: 'active', friendlyName: options.friendlyName });
    return { sid, authToken: this.#sid('tok'), friendlyName: options.friendlyName };
  }

  async setSubaccountStatus(sid: string, status: SubaccountStatus): Promise<void> {
    await this.#maybeFail();
    const existing = this.subaccounts.get(sid);
    if (existing === undefined) throw new Error(`Unknown subaccount ${sid}`);
    this.subaccounts.set(sid, { ...existing, status });
  }

  /* --- Numbers ----------------------------------------------------------- */

  async searchAvailableNumbers(options: {
    readonly subaccountSid: string;
    readonly isoCountry: string;
    readonly areaCode?: string | undefined;
    readonly limit: number;
  }): Promise<readonly AvailableNumber[]> {
    await this.#maybeFail();
    const area = options.areaCode ?? '415';
    const results: AvailableNumber[] = [];
    for (let index = 0; index < options.limit; index += 1) {
      results.push({
        phoneNumber: `+1${area}555${String(index).padStart(4, '0')}` as PhoneNumber,
        locality: 'Test City',
        region: 'CA',
        isoCountry: options.isoCountry,
        monthlyCostCents: PRICES.number_purchase,
      });
    }
    return results;
  }

  /**
   * Whatever this fake has "bought", plus anything preloaded onto
   * `ownedNumbers`.
   *
   * Answering from `purchasedNumbers` is what makes the fake obey the real
   * contract's central distinction: a number is owned because it was
   * purchased, never because it was merely available. A test that purchases
   * and then lists sees its own number; one that never purchases sees only
   * what it explicitly preloaded.
   */
  async listOwnedNumbers(
    _options: { readonly accountSid?: string | undefined } = {},
  ): Promise<readonly OwnedNumber[]> {
    await this.#maybeFail();
    return [
      ...this.ownedNumbers,
      ...this.purchasedNumbers.map((number) => ({
        sid: number.sid,
        phoneNumber: number.phoneNumber,
        isoCountry: 'US',
        capabilities: { voice: true, sms: true },
      })),
    ];
  }

  async purchaseNumber(options: {
    readonly subaccountSid: string;
    readonly phoneNumber: PhoneNumber;
    readonly voiceUrl: string;
    readonly smsUrl: string;
  }): Promise<PurchasedNumber> {
    await this.#maybeFail();
    const purchased: PurchasedNumber = {
      sid: this.#sid('PN'),
      phoneNumber: options.phoneNumber,
      monthlyCostCents: PRICES.number_purchase,
    };
    this.purchasedNumbers.push(purchased);
    return purchased;
  }

  async releaseNumber(options: {
    readonly subaccountSid: string;
    readonly numberSid: string;
  }): Promise<void> {
    await this.#maybeFail();
    const index = this.purchasedNumbers.findIndex((n) => n.sid === options.numberSid);
    if (index >= 0) this.purchasedNumbers.splice(index, 1);
  }

  /* --- Outbound ---------------------------------------------------------- */

  async placeCall(options: {
    readonly subaccountSid: string;
    readonly from: PhoneNumber;
    readonly to: PhoneNumber;
    readonly instructionsUrl: string;
    readonly statusCallbackUrl: string;
  }): Promise<CallResult> {
    await this.#maybeFail();
    this.#refuseDisallowedDestination(options.to);
    this.calls.push({ subaccountSid: options.subaccountSid, from: options.from, to: options.to });
    return { sid: this.#sid('CA'), status: 'queued', costCents: PRICES.call };
  }

  async sendSms(options: {
    readonly subaccountSid: string;
    readonly from: PhoneNumber;
    readonly to: PhoneNumber;
    readonly body: string;
    readonly statusCallbackUrl: string;
  }): Promise<MessageResult> {
    await this.#maybeFail();
    this.#refuseDisallowedDestination(options.to);
    this.messages.push({
      subaccountSid: options.subaccountSid,
      from: options.from,
      to: options.to,
      body: options.body,
    });
    return {
      sid: this.#sid('SM'),
      status: 'queued',
      segments: Math.max(1, Math.ceil(options.body.length / 160)),
      costCents: PRICES.sms,
    };
  }

  /* --- Lookup ------------------------------------------------------------ */

  async lookupNumber(phoneNumber: PhoneNumber): Promise<NumberLookup> {
    await this.#maybeFail();
    const verdict = checkDestination(phoneNumber);
    return {
      phoneNumber,
      /* The region on a rule is a label, not always an ISO country ('US/CA',
         'GB-PREMIUM'). Only a two-letter value is reported as an ISO country;
         anything else is `undefined`, because a consent gate keying on
         jurisdiction (§3.5) must not be handed 'US-PREMIUM' as a country. */
      isoCountry:
        verdict.rule !== undefined && /^[A-Z]{2}$/.test(verdict.rule.region)
          ? verdict.rule.region
          : undefined,
      lineType: 'unknown',
    };
  }

  /* --- Verification ------------------------------------------------------ */

  async startVerification(options: {
    readonly to: PhoneNumber;
    readonly channel: 'sms' | 'call';
  }): Promise<VerificationStart> {
    await this.#maybeFail();
    this.#refuseDisallowedDestination(options.to);
    /* A fixed code, never a random one. This provider is a test double; a
       random code would need to be read back out of it, which is a seam a
       production code path could learn to use. */
    this.verifications.set(options.to, '123456');
    return { sid: this.#sid('VE'), status: 'pending', costCents: PRICES.verification };
  }

  async checkVerification(options: {
    readonly to: PhoneNumber;
    readonly code: string;
  }): Promise<VerificationCheck> {
    await this.#maybeFail();
    const expected = this.verifications.get(options.to);
    return { approved: expected !== undefined && expected === options.code };
  }

  /* --- Pricing and signatures -------------------------------------------- */

  estimateCostCents(options: {
    readonly kind: OutboundKind;
    readonly to: PhoneNumber;
  }): Promise<number> {
    return Promise.resolve(PRICES[options.kind]);
  }

  verifyWebhookSignature(options: {
    readonly url: string;
    readonly signature: string;
    readonly params: Readonly<Record<string, string>>;
    readonly authToken: string;
  }): boolean {
    /* The REAL algorithm, not a stub that returns true.
     *
     * A fake that waved signatures through would make every webhook test assert
     * that the handler works on trusted input — which is the one case the
     * handler is not defending against. */
    return verifyTwilioSignature(options);
  }

  #refuseDisallowedDestination(to: PhoneNumber): void {
    if (!checkDestination(to).allowed) {
      throw new Error(`FakeTelephonyProvider refused a disallowed destination: ${to}`);
    }
  }
}
