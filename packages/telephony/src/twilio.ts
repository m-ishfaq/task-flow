import { verifyTwilioSignature } from '@taskflow/security';
import {
  PhoneNumberSchema,
  type AvailableNumber,
  type CallResult,
  type MessageResult,
  type NumberLookup,
  type OutboundKind,
  type OwnedNumber,
  type PhoneNumber,
  type PurchasedNumber,
  type SubaccountStatus,
  type TelephonyProvider,
  type TelephonySubaccount,
  type VerificationCheck,
  type VerificationStart,
} from '@taskflow/contracts';

/**
 * `TelephonyProvider` over Twilio's REST API (ai/phase-7-voice.md §3.1).
 *
 * ## No vendor SDK, deliberately
 *
 * Twilio's own Node SDK is a large dependency tree that reaches for
 * `node:crypto` and brings its own HTTP client, retry policy, and logging. What
 * this codebase needs from it is form-encoded POSTs with HTTP Basic auth over
 * `fetch`, which Node 22 has built in. The one genuinely subtle piece — the
 * webhook signature — is in `packages/security` where guardrail 5 puts it, and
 * is pinned to Twilio's own published test vector so an algorithm change fails a
 * test rather than a request.
 *
 * ## Subaccount authentication
 *
 * Requests on behalf of an org authenticate as `subaccountSid:masterAuthToken`
 * — Twilio accepts the parent token for its children, so this class holds ONE
 * secret rather than one per tenant.
 *
 * The subaccount's own auth token is still stored (encrypted, §3.1), because
 * webhooks from a subaccount are signed with THAT token and nothing else can
 * verify them. That is the whole reason `comms.subaccounts` has an encrypted
 * column at all, and it is worth stating plainly: the stored token is a
 * verification key, not an access credential this class uses.
 */

export interface TwilioConfig {
  readonly accountSid: string;
  readonly authToken: string;
  /** Verify service SID. Absent means verification is unavailable, not free. */
  readonly verifyServiceSid?: string | undefined;
  /** Whether these credentials spend real money. */
  readonly isLive: boolean;
  /** Overridable for tests. Defaults to Twilio's production hosts. */
  readonly apiBaseUrl?: string | undefined;
  readonly lookupsBaseUrl?: string | undefined;
  readonly verifyBaseUrl?: string | undefined;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

const DEFAULT_API = 'https://api.twilio.com';
const DEFAULT_LOOKUPS = 'https://lookups.twilio.com';
const DEFAULT_VERIFY = 'https://verify.twilio.com';

/**
 * Conservative per-action fallback prices, in cents.
 *
 * Used when Twilio has not yet priced a request — which is the NORMAL case for
 * a call or message, since `price` is null in the creation response and arrives
 * later on the status callback. `estimateCostCents` must over-state (the
 * interface says so): an estimate rounded down to zero is a spend cap that
 * never sees the spend coming.
 */
const FALLBACK_PRICE_CENTS: Readonly<Record<OutboundKind, number>> = {
  call: 5,
  sms: 2,
  number_purchase: 200,
  verification: 10,
  /* Phase 10 Wave 4 (§5.5): the union is total, so a call priced under an
     automation kind costs what a call costs. The services never ask for one
     — they price with the base kind — but `undefined` here would be NaN in
     the gate's estimate, which is the one direction a spend control must
     never fail in. */
  automation_call: 5,
  automation_sms: 2,
};

export class TwilioTelephonyProvider implements TelephonyProvider {
  readonly isLive: boolean;

  readonly #config: TwilioConfig;
  readonly #fetch: typeof globalThis.fetch;
  readonly #api: string;
  readonly #lookups: string;
  readonly #verify: string;

  constructor(config: TwilioConfig) {
    if (config.accountSid.length === 0 || config.authToken.length === 0) {
      // An empty credential produces a Basic header that authenticates as
      // nobody; Twilio answers 401 and the failure reads as "the API is down".
      throw new Error('TwilioTelephonyProvider requires a non-empty accountSid and authToken.');
    }
    this.#config = config;
    this.isLive = config.isLive;
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#api = config.apiBaseUrl ?? DEFAULT_API;
    this.#lookups = config.lookupsBaseUrl ?? DEFAULT_LOOKUPS;
    this.#verify = config.verifyBaseUrl ?? DEFAULT_VERIFY;
  }

  /* --- Subaccounts ------------------------------------------------------- */

  async createSubaccount(options: { readonly friendlyName: string }): Promise<TelephonySubaccount> {
    const body = await this.#post<{ sid: string; auth_token: string; friendly_name: string }>(
      `${this.#api}/2010-04-01/Accounts.json`,
      { FriendlyName: options.friendlyName },
    );
    return {
      sid: body.sid,
      authToken: body.auth_token,
      friendlyName: body.friendly_name,
    };
  }

  async setSubaccountStatus(sid: string, status: SubaccountStatus): Promise<void> {
    await this.#post(`${this.#api}/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`, {
      Status: status,
    });
  }

  /* --- Numbers ----------------------------------------------------------- */

  async searchAvailableNumbers(options: {
    readonly subaccountSid: string;
    readonly isoCountry: string;
    readonly areaCode?: string | undefined;
    readonly limit: number;
  }): Promise<readonly AvailableNumber[]> {
    const query = new URLSearchParams({ PageSize: String(options.limit) });
    if (options.areaCode !== undefined) query.set('AreaCode', options.areaCode);

    const url =
      `${this.#api}/2010-04-01/Accounts/${encodeURIComponent(options.subaccountSid)}` +
      `/AvailablePhoneNumbers/${encodeURIComponent(options.isoCountry)}/Local.json?${query.toString()}`;

    const body = await this.#get<{
      available_phone_numbers: {
        phone_number: string;
        locality: string | null;
        region: string | null;
        iso_country: string;
      }[];
    }>(url);

    return body.available_phone_numbers.map((entry) => ({
      /* Parsed, not cast. Twilio is trusted to be Twilio, not to be
         well-formed: a value that fails E.164 here would otherwise reach the
         geo allowlist, match no prefix, and be denied for the wrong reason. */
      phoneNumber: PhoneNumberSchema.parse(entry.phone_number),
      locality: entry.locality ?? undefined,
      region: entry.region ?? undefined,
      isoCountry: entry.iso_country,
      monthlyCostCents: FALLBACK_PRICE_CENTS.number_purchase,
    }));
  }

  async listOwnedNumbers(
    options: { readonly accountSid?: string | undefined } = {},
  ): Promise<readonly OwnedNumber[]> {
    /* Defaults to the account these credentials belong to. A caller holding
       only master credentials (the seeder) has no subaccount sid to pass and
       wants exactly this; the org-scoped services pass one explicitly. */
    const accountSid = options.accountSid ?? this.#config.accountSid;

    const body = await this.#get<{
      incoming_phone_numbers: {
        sid: string;
        phone_number: string;
        /* Twilio omits iso_country on some legacy numbers rather than
           sending null, hence optional rather than nullable. */
        iso_country?: string | null;
        capabilities?: { voice?: boolean; sms?: boolean } | null;
      }[];
    }>(
      `${this.#api}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}` +
        `/IncomingPhoneNumbers.json?PageSize=50`,
    );

    return body.incoming_phone_numbers.map((entry) => ({
      sid: entry.sid,
      /* Parsed, not cast — the same reasoning as searchAvailableNumbers
         above: Twilio is trusted to be Twilio, not to be well-formed. */
      phoneNumber: PhoneNumberSchema.parse(entry.phone_number),
      /* A number with no country reported is still a usable number; 'US' is
         wrong to assume, so the empty answer is passed through as the
         two-letter unknown and callers that care re-look it up. */
      isoCountry: entry.iso_country ?? 'ZZ',
      capabilities: {
        voice: entry.capabilities?.voice ?? false,
        sms: entry.capabilities?.sms ?? false,
      },
    }));
  }

  async purchaseNumber(options: {
    readonly subaccountSid: string;
    readonly phoneNumber: PhoneNumber;
    readonly voiceUrl: string;
    readonly smsUrl: string;
  }): Promise<PurchasedNumber> {
    const body = await this.#post<{ sid: string; phone_number: string }>(
      `${this.#api}/2010-04-01/Accounts/${encodeURIComponent(options.subaccountSid)}/IncomingPhoneNumbers.json`,
      {
        PhoneNumber: options.phoneNumber,
        VoiceUrl: options.voiceUrl,
        VoiceMethod: 'POST',
        SmsUrl: options.smsUrl,
        SmsMethod: 'POST',
      },
    );

    return {
      sid: body.sid,
      phoneNumber: PhoneNumberSchema.parse(body.phone_number),
      monthlyCostCents: FALLBACK_PRICE_CENTS.number_purchase,
    };
  }

  async releaseNumber(options: {
    readonly subaccountSid: string;
    readonly numberSid: string;
  }): Promise<void> {
    await this.#request(
      'DELETE',
      `${this.#api}/2010-04-01/Accounts/${encodeURIComponent(options.subaccountSid)}` +
        `/IncomingPhoneNumbers/${encodeURIComponent(options.numberSid)}.json`,
      undefined,
    );
  }

  /* --- Outbound ---------------------------------------------------------- */

  async placeCall(options: {
    readonly subaccountSid: string;
    readonly from: PhoneNumber;
    readonly to: PhoneNumber;
    readonly instructionsUrl: string;
    readonly statusCallbackUrl: string;
  }): Promise<CallResult> {
    const body = await this.#post<{ sid: string; status: string; price: string | null }>(
      `${this.#api}/2010-04-01/Accounts/${encodeURIComponent(options.subaccountSid)}/Calls.json`,
      {
        From: options.from,
        To: options.to,
        Url: options.instructionsUrl,
        StatusCallback: options.statusCallbackUrl,
        StatusCallbackMethod: 'POST',
      },
    );

    return {
      sid: body.sid,
      status: body.status,
      costCents: priceToCents(body.price) ?? FALLBACK_PRICE_CENTS.call,
    };
  }

  async sendSms(options: {
    readonly subaccountSid: string;
    readonly from: PhoneNumber;
    readonly to: PhoneNumber;
    readonly body: string;
    readonly statusCallbackUrl: string;
  }): Promise<MessageResult> {
    const body = await this.#post<{
      sid: string;
      status: string;
      num_segments: string | null;
      price: string | null;
    }>(
      `${this.#api}/2010-04-01/Accounts/${encodeURIComponent(options.subaccountSid)}/Messages.json`,
      {
        From: options.from,
        To: options.to,
        Body: options.body,
        StatusCallback: options.statusCallbackUrl,
      },
    );

    const segments = Number.parseInt(body.num_segments ?? '1', 10);
    const safeSegments = Number.isFinite(segments) && segments > 0 ? segments : 1;

    return {
      sid: body.sid,
      status: body.status,
      segments: safeSegments,
      /* Per SEGMENT, not per message. A 900-character SMS is six billable
         messages, and pricing it as one is an under-estimate an attacker
         controls the size of directly. */
      costCents: priceToCents(body.price) ?? FALLBACK_PRICE_CENTS.sms * safeSegments,
    };
  }

  /* --- Lookup ------------------------------------------------------------ */

  async lookupNumber(phoneNumber: PhoneNumber): Promise<NumberLookup> {
    const body = await this.#get<{
      country_code: string | null;
      line_type_intelligence?: { type?: string | null } | null;
    }>(`${this.#lookups}/v2/PhoneNumbers/${encodeURIComponent(phoneNumber)}`);

    return {
      phoneNumber,
      isoCountry: body.country_code ?? undefined,
      lineType: normalizeLineType(body.line_type_intelligence?.type ?? undefined),
    };
  }

  /* --- Verification ------------------------------------------------------ */

  async startVerification(options: {
    readonly to: PhoneNumber;
    readonly channel: 'sms' | 'call';
  }): Promise<VerificationStart> {
    const serviceSid = this.#requireVerifyService();
    const body = await this.#post<{ sid: string; status: string }>(
      `${this.#verify}/v2/Services/${encodeURIComponent(serviceSid)}/Verifications`,
      { To: options.to, Channel: options.channel },
    );
    return { sid: body.sid, status: body.status, costCents: FALLBACK_PRICE_CENTS.verification };
  }

  async checkVerification(options: {
    readonly to: PhoneNumber;
    readonly code: string;
  }): Promise<VerificationCheck> {
    const serviceSid = this.#requireVerifyService();
    const body = await this.#post<{ status: string }>(
      `${this.#verify}/v2/Services/${encodeURIComponent(serviceSid)}/VerificationCheck`,
      { To: options.to, Code: options.code },
    );
    return { approved: body.status === 'approved' };
  }

  /* --- Pricing and signatures -------------------------------------------- */

  estimateCostCents(options: {
    readonly kind: OutboundKind;
    readonly to: PhoneNumber;
  }): Promise<number> {
    /* Deliberately does NOT call Twilio's pricing API.
     *
     * This runs inside the outbound gate, before every call and message. A
     * network round trip there would put a third party on the critical path of
     * a control that must answer — and the honest failure mode of "pricing is
     * unreachable" would be to refuse, which turns a Twilio hiccup into an
     * outage. A conservative local table is worth more than an accurate remote
     * one here; the ledger is corrected from the status callback afterwards
     * (§3.4), which is where accuracy belongs. */
    return Promise.resolve(FALLBACK_PRICE_CENTS[options.kind]);
  }

  verifyWebhookSignature(options: {
    readonly url: string;
    readonly signature: string;
    readonly params: Readonly<Record<string, string>>;
    readonly authToken: string;
  }): boolean {
    return verifyTwilioSignature(options);
  }

  /* --- HTTP -------------------------------------------------------------- */

  #requireVerifyService(): string {
    const sid = this.#config.verifyServiceSid;
    if (sid === undefined || sid.length === 0) {
      throw new Error(
        'TWILIO_VERIFY_SERVICE_SID is not configured; verification is unavailable on this instance.',
      );
    }
    return sid;
  }

  /**
   * The Basic credential, ALWAYS the configured parent account's own pair.
   *
   * This took no username argument for a while, then took one, and the argument
   * is what broke every subaccount-scoped call against real Twilio. The
   * password half is fixed — `#config.authToken`, the parent's — so passing a
   * subaccount SID as the username built `subaccountSid:PARENT_TOKEN`, a pair
   * belonging to no account, and Twilio answered 401/20003 on number search,
   * purchase, release, calls and SMS alike. Subaccount creation and the Lookup
   * and Verify endpoints kept working, because those were the three that passed
   * the parent SID, which is why the failure looked like a credentials problem
   * in the operator's Twilio console rather than a bug in this file.
   *
   * A subaccount is addressed by its position in the URL PATH, and the parent's
   * credentials are authorized for its own subaccounts' resources. So there is
   * no caller for whom a different username is correct, and the parameter is
   * gone rather than merely fixed at its call sites — a per-subaccount token
   * would have to arrive with a matching password to mean anything, and this
   * class holds exactly one.
   *
   * (`comms.subaccounts.auth_token_ciphertext` stores each subaccount's own
   * token, and that is not this. It exists so an INBOUND webhook can be
   * signature-verified against the credential of the subaccount that sent it.)
   */
  #authorization(): string {
    const basic = Buffer.from(
      `${this.#config.accountSid}:${this.#config.authToken}`,
      'utf8',
    ).toString('base64');
    return `Basic ${basic}`;
  }

  async #get<T>(url: string): Promise<T> {
    return this.#request<T>('GET', url, undefined);
  }

  async #post<T>(url: string, form: Record<string, string>): Promise<T> {
    return this.#request<T>('POST', url, form);
  }

  async #request<T>(
    method: string,
    url: string,
    form: Record<string, string> | undefined,
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: this.#authorization() };
    let body: string | undefined;

    if (form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }

    const response = await this.#fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });

    if (!response.ok) {
      /* The response body is NOT included in the thrown message.
       *
       * Twilio echoes request parameters back in its error payloads, and those
       * parameters are phone numbers and message bodies — the exact fields
       * REDACTION_PATHS exists to keep out of logs. An error that carries them
       * in a plain `message` string defeats that: pino redacts paths it can
       * see, never text inside a message. Status and URL are enough to
       * diagnose, and the request id correlates the rest.
       *
       * The one exception is `code`: an integer from Twilio's published table,
       * which echoes no request parameter and so cannot carry PII. Without it
       * every carrier refusal reads as a bare status, and the failures that
       * bare status hides are configuration, not defects — a 403 on
       * `createSubaccount` is 20008 ("not available to Test Credentials") or an
       * account-level restriction, and the two need opposite fixes. Diagnosing
       * that from `status: 403` alone means guessing. */
      throw new TwilioApiError(method, url, response.status, await readErrorCode(response));
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

export class TwilioApiError extends Error {
  readonly status: number;
  /**
   * Twilio's own numeric error code, when the body carried one — the thing that
   * says WHICH refusal this is. Looked up at twilio.com/docs/api/errors/<code>.
   */
  readonly code: number | undefined;

  constructor(method: string, url: string, status: number, code?: number) {
    super(
      `Twilio ${method} ${redactUrl(url)} failed with status ${String(status)}` +
        (code === undefined
          ? ''
          : ` (Twilio error ${String(code)} — twilio.com/docs/api/errors/${String(code)})`),
    );
    this.name = 'TwilioApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Twilio's numeric error code from a failed response, or undefined.
 *
 * Reads ONLY `code`. Pulling the whole body — or even `message`, which is the
 * tempting one — would undo the redaction the thrown error exists to preserve:
 * Twilio's `message` is where the phone number it objected to is quoted back.
 */
async function readErrorCode(response: Response): Promise<number | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'code' in body) {
      const code = (body as { readonly code: unknown }).code;
      if (typeof code === 'number') return code;
    }
  } catch {
    /* A non-JSON error body — a proxy's HTML 502, a truncated response — is not
       itself worth reporting. The status is already in the message. */
  }
  return undefined;
}

/**
 * Strips a phone number out of a URL path before it reaches an error message.
 *
 * The Lookups endpoint puts the number IN the path, so an unredacted URL in a
 * thrown error is a phone number in a log line by a different route than the
 * one `REDACTION_PATHS` covers.
 *
 * Both `+14155550100` and its percent-encoded form `%2B14155550100` are
 * matched. The encoded form is the one that actually occurs — every caller here
 * builds the path with `encodeURIComponent`, which turns `+` into `%2B` — and a
 * pattern written for the literal `+` alone matches nothing in practice while
 * looking exactly right. A test is what found that.
 */
function redactUrl(url: string): string {
  return url.replace(/(?:\+|%2[Bb])[0-9]{4,15}/g, '[redacted]');
}

/**
 * Twilio prices are decimal strings, negative for charges ("-0.00750"), in the
 * account currency, and null until billing has caught up.
 *
 * Rounded UP in absolute terms — a half-cent charge that floors to zero is a
 * ledger entry that says a call was free.
 */
export function priceToCents(price: string | null | undefined): number | undefined {
  if (price === null || price === undefined || price.length === 0) return undefined;
  const value = Number.parseFloat(price);
  if (!Number.isFinite(value)) return undefined;
  return Math.ceil(Math.abs(value) * 100);
}

function normalizeLineType(type: string | undefined): NumberLookup['lineType'] {
  switch (type) {
    case undefined:
      return 'unknown';
    case 'mobile':
      return 'mobile';
    case 'landline':
      return 'landline';
    case 'nonFixedVoip':
    case 'fixedVoip':
    case 'voip':
      return 'voip';
    default:
      return 'unknown';
  }
}
