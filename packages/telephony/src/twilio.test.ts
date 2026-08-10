import { describe, expect, it } from 'vitest';
import { PhoneNumberSchema } from '@taskflow/contracts';
import { describeTelephonyProviderContract } from './contract-test.js';
import {
  TwilioApiError,
  TwilioTelephonyProvider,
  priceToCents,
  type TwilioConfig,
} from './twilio.js';

/**
 * `TwilioTelephonyProvider` against a stub carrier.
 *
 * The stub answers with Twilio's real response SHAPES — `price` as a null-able
 * decimal string, `num_segments` as a string, `auth_token` on subaccount
 * creation — because every bug this file has caught was a shape bug, not a
 * logic bug. A stub returning tidy numbers would let `priceToCents` be wrong in
 * both directions and still pass.
 *
 * What this cannot prove is that Twilio behaves as the stub does. That is what
 * Twilio's free TEST CREDENTIALS are for, and Wave 2 runs against them when
 * there is a real action to run. Until then, asserting against a stub of a
 * carrier we have not called yet would be asserting our own assumptions.
 */

interface StubCall {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
  readonly form: Record<string, string>;
}

function stubCarrier(overrides: Record<string, unknown> = {}): {
  fetch: typeof globalThis.fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const purchased: { sid: string; phone_number: string }[] = [];
  let counter = 0;

  const handle = (input: string | URL | Request, init?: RequestInit): Response => {
    /* `input.toString()` on a `Request` yields '[object Object]', so the stub
       would route every request to the fallback branch and every assertion
       about which endpoint was called would pass vacuously. */
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const form = Object.fromEntries(new URLSearchParams((init?.body as string | undefined) ?? ''));

    calls.push({ method, url, authorization: headers['Authorization'] ?? '', form });
    counter += 1;

    const ok = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    for (const [fragment, payload] of Object.entries(overrides)) {
      if (url.includes(fragment)) {
        if (payload instanceof Response) return payload.clone();
        return ok(payload);
      }
    }

    if (url.includes('/AvailablePhoneNumbers/')) {
      return ok({
        available_phone_numbers: [
          {
            phone_number: '+14155550100',
            locality: 'San Francisco',
            region: 'CA',
            iso_country: 'US',
          },
          { phone_number: '+14155550101', locality: null, region: null, iso_country: 'US' },
        ],
      });
    }
    /* Stateful, unlike every other branch here, because the owned-number
       contract is a statement about state: a number is owned BECAUSE it was
       purchased. A stub that answered the GET from a canned list would let an
       implementation pass while reading from somewhere the purchase never
       reached. DELETE lands on this prefix too and must not be mistaken for a
       purchase, hence the explicit method check rather than "not a GET". */
    if (url.includes('/IncomingPhoneNumbers')) {
      if (method === 'POST') {
        const created = {
          sid: `PN${String(counter)}`,
          phone_number: form['PhoneNumber'] ?? '+14155550100',
        };
        purchased.push(created);
        return ok(created);
      }
      if (method === 'GET') {
        return ok({
          incoming_phone_numbers: purchased.map((entry) => ({
            sid: entry.sid,
            phone_number: entry.phone_number,
            iso_country: 'US',
            capabilities: { voice: true, sms: true },
          })),
        });
      }
      return ok({});
    }
    if (url.includes('/Calls.json')) {
      return ok({ sid: `CA${String(counter)}`, status: 'queued', price: null });
    }
    if (url.includes('/Messages.json')) {
      return ok({ sid: `SM${String(counter)}`, status: 'queued', num_segments: '1', price: null });
    }
    if (url.includes('/VerificationCheck')) {
      return ok({ status: 'pending' });
    }
    if (url.includes('/Verifications')) {
      return ok({ sid: `VE${String(counter)}`, status: 'pending' });
    }
    if (url.includes('/v2/PhoneNumbers/')) {
      return ok({ country_code: 'US', line_type_intelligence: { type: 'mobile' } });
    }
    if (url.includes('/Accounts.json')) {
      return ok({
        sid: `AC${String(counter)}`,
        auth_token: `tok${String(counter)}`,
        friendly_name: 'org',
      });
    }
    // Accounts/{sid}.json — the status update.
    return ok({ sid: 'AC', status: 'suspended' });
  };

  const fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handle(input, init))) as typeof globalThis.fetch;

  return { fetch, calls };
}

const config = (extra: Partial<TwilioConfig> = {}): TwilioConfig => ({
  accountSid: 'ACmaster',
  authToken: 'master-token',
  verifyServiceSid: 'VAservice',
  isLive: false,
  apiBaseUrl: 'https://api.test',
  lookupsBaseUrl: 'https://lookups.test',
  verifyBaseUrl: 'https://verify.test',
  fetch: stubCarrier().fetch,
  ...extra,
});

describeTelephonyProviderContract(
  'TwilioTelephonyProvider (stub carrier)',
  () => new TwilioTelephonyProvider(config()),
);

describe('TwilioTelephonyProvider', () => {
  it('refuses to construct without credentials', () => {
    /* An empty credential produces a Basic header that authenticates as nobody.
       Twilio answers 401, and the resulting failure reads as "the carrier is
       down" rather than "this instance was never configured". */
    expect(() => new TwilioTelephonyProvider(config({ accountSid: '' }))).toThrow(/non-empty/);
    expect(() => new TwilioTelephonyProvider(config({ authToken: '' }))).toThrow(/non-empty/);
  });

  /**
   * The subaccount is addressed by the URL PATH; the CREDENTIAL is always the
   * parent's own pair.
   *
   * This test previously asserted the opposite — `subaccountSid:master-token` —
   * and that is why the bug it describes survived a green suite. Twilio's Basic
   * username and password must belong to the SAME account, so pairing a
   * subaccount SID with the parent's token names no account at all: every
   * number search, purchase, release, call and SMS came back 401/20003 against
   * real Twilio, while subaccount creation, Lookup and Verify kept working
   * because those three passed the parent SID. A stub that records the header
   * without judging it will agree with whatever the code does, so the assertion
   * is the only thing standing between this and a carrier that refuses
   * everything the product exists to do.
   */
  it('authenticates as the PARENT account, addressing the subaccount by URL', async () => {
    const stub = stubCarrier();
    const provider = new TwilioTelephonyProvider(config({ fetch: stub.fetch }));
    const account = await provider.createSubaccount({ friendlyName: 'org' });

    await provider.sendSms({
      subaccountSid: account.sid,
      from: PhoneNumberSchema.parse('+14155550199'),
      to: PhoneNumberSchema.parse('+14155550100'),
      body: 'hi',
      statusCallbackUrl: 'https://example.test/status',
    });

    const send = stub.calls.at(-1);
    const decoded = Buffer.from((send?.authorization ?? '').replace('Basic ', ''), 'base64')
      .toString('utf8')
      .split(':');

    expect(decoded[0]).toBe('ACmaster');
    expect(decoded[1]).toBe('master-token');
    /* The subaccount is still what is being acted on — asserted here so a
       "fix" that authenticated correctly by dropping the subaccount from the
       path (sending every org's SMS from the parent account) fails too. */
    expect(send?.url).toContain(`/Accounts/${account.sid}/Messages.json`);
  });

  it('uses the parent credential on every subaccount-scoped endpoint', async () => {
    /* sendSms above is one endpoint; the bug was in all of them. Anything that
       reintroduces a per-call username will pass the single-endpoint test and
       fail this one. */
    const stub = stubCarrier();
    const provider = new TwilioTelephonyProvider(config({ fetch: stub.fetch }));

    await provider.searchAvailableNumbers({
      subaccountSid: 'ACsub',
      isoCountry: 'US',
      areaCode: '415',
      limit: 10,
    });
    await provider.purchaseNumber({
      subaccountSid: 'ACsub',
      phoneNumber: PhoneNumberSchema.parse('+14155550100'),
      voiceUrl: 'https://example.test/voice',
      smsUrl: 'https://example.test/sms',
    });
    await provider.releaseNumber({ subaccountSid: 'ACsub', numberSid: 'PNnumber' });
    await provider.placeCall({
      subaccountSid: 'ACsub',
      from: PhoneNumberSchema.parse('+14155550199'),
      to: PhoneNumberSchema.parse('+14155550100'),
      instructionsUrl: 'https://example.test/voice',
      statusCallbackUrl: 'https://example.test/status',
    });

    const expected = `Basic ${Buffer.from('ACmaster:master-token', 'utf8').toString('base64')}`;
    expect(stub.calls).toHaveLength(4);
    for (const call of stub.calls) {
      expect(call.authorization).toBe(expected);
      expect(call.url).toContain('/Accounts/ACsub/');
    }
  });

  it('posts the status callback URL so cost correction can arrive later', async () => {
    const stub = stubCarrier();
    const provider = new TwilioTelephonyProvider(config({ fetch: stub.fetch }));

    await provider.placeCall({
      subaccountSid: 'ACsub',
      from: PhoneNumberSchema.parse('+14155550199'),
      to: PhoneNumberSchema.parse('+14155550100'),
      instructionsUrl: 'https://example.test/voice',
      statusCallbackUrl: 'https://example.test/status',
    });

    expect(stub.calls.at(-1)?.form['StatusCallback']).toBe('https://example.test/status');
  });

  it('prices a multi-segment SMS PER SEGMENT when the carrier has not priced it', async () => {
    /* The under-estimate an attacker controls directly: a 900-character body is
       six billable messages, and charging the ledger for one lets six times the
       configured spend through the cap. */
    const stub = stubCarrier({
      '/Messages.json': { sid: 'SM1', status: 'queued', num_segments: '6', price: null },
    });
    const provider = new TwilioTelephonyProvider(config({ fetch: stub.fetch }));

    const result = await provider.sendSms({
      subaccountSid: 'ACsub',
      from: PhoneNumberSchema.parse('+14155550199'),
      to: PhoneNumberSchema.parse('+14155550100'),
      body: 'x'.repeat(900),
      statusCallbackUrl: 'https://example.test/status',
    });

    expect(result.segments).toBe(6);
    const single = await new TwilioTelephonyProvider(config()).estimateCostCents({
      kind: 'sms',
      to: PhoneNumberSchema.parse('+14155550100'),
    });
    expect(result.costCents).toBe(single * 6);
  });

  it('prefers the carrier price over the fallback when one is reported', async () => {
    const stub = stubCarrier({
      '/Messages.json': { sid: 'SM1', status: 'sent', num_segments: '1', price: '-0.00750' },
    });
    const provider = new TwilioTelephonyProvider(config({ fetch: stub.fetch }));

    const result = await provider.sendSms({
      subaccountSid: 'ACsub',
      from: PhoneNumberSchema.parse('+14155550199'),
      to: PhoneNumberSchema.parse('+14155550100'),
      body: 'hi',
      statusCallbackUrl: 'https://example.test/status',
    });

    expect(result.costCents).toBe(1);
  });

  it('parses E.164 out of a search rather than trusting the carrier', async () => {
    const stub = stubCarrier({
      '/AvailablePhoneNumbers/': {
        available_phone_numbers: [
          { phone_number: '415-555-0100', locality: null, region: null, iso_country: 'US' },
        ],
      },
    });
    const provider = new TwilioTelephonyProvider(config({ fetch: stub.fetch }));

    /* A non-E.164 value would reach the geo allowlist, match no prefix, and be
       denied — the right answer for the wrong reason, which hides the real
       problem until a legitimate destination is refused too. */
    await expect(
      provider.searchAvailableNumbers({ subaccountSid: 'ACsub', isoCountry: 'US', limit: 1 }),
    ).rejects.toThrow();
  });

  it('lists owned numbers with a GET against the account, spending nothing', async () => {
    /* The seeder's entire use of this provider. Two things are asserted that
       a "does it return numbers" test would not: the verb is GET (a POST to
       this same path BUYS a number, so a wrong verb here is a real charge on
       a real account), and the account defaults to the configured one, since
       a tool holding only master credentials has no subaccount sid to pass. */
    const stub = stubCarrier();
    const provider = new TwilioTelephonyProvider(config({ fetch: stub.fetch }));

    await provider.purchaseNumber({
      subaccountSid: 'ACmaster',
      phoneNumber: PhoneNumberSchema.parse('+14155550123'),
      voiceUrl: 'https://example.test/voice',
      smsUrl: 'https://example.test/sms',
    });

    const owned = await provider.listOwnedNumbers();

    const listCall = stub.calls.at(-1);
    expect(listCall?.method).toBe('GET');
    expect(listCall?.url).toContain('/Accounts/ACmaster/IncomingPhoneNumbers.json');
    expect(owned).toHaveLength(1);
    expect(owned[0]?.phoneNumber).toBe('+14155550123');
    expect(owned[0]?.capabilities.voice).toBe(true);
  });

  it('falls back to ZZ rather than guessing a country Twilio did not report', async () => {
    /* A legacy number can come back with no iso_country. Defaulting to 'US'
       would put a wrong two-letter code into comms.phone_numbers, where the
       CHECK accepts it and the geo rules then reason about the wrong
       jurisdiction. */
    const stub = stubCarrier({
      '/IncomingPhoneNumbers': {
        incoming_phone_numbers: [{ sid: 'PNlegacy', phone_number: '+14155550199' }],
      },
    });
    const provider = new TwilioTelephonyProvider(config({ fetch: stub.fetch }));

    const owned = await provider.listOwnedNumbers();

    expect(owned[0]?.isoCountry).toBe('ZZ');
    expect(owned[0]?.capabilities).toEqual({ voice: false, sms: false });
  });

  describe('errors', () => {
    it('never puts the carrier response body in the error message', async () => {
      const stub = stubCarrier({
        '/Messages.json': new Response(
          JSON.stringify({ message: 'Invalid To +14155550100', code: 21211 }),
          { status: 400 },
        ),
      });
      const provider = new TwilioTelephonyProvider(config({ fetch: stub.fetch }));

      /* Twilio echoes request parameters into its error payloads, and those
         parameters are phone numbers and message bodies. REDACTION_PATHS
         redacts FIELDS, never text inside a message string — so a thrown error
         carrying the body is a phone number in the logs by a route redaction
         cannot see. */
      const error = await provider
        .sendSms({
          subaccountSid: 'ACsub',
          from: PhoneNumberSchema.parse('+14155550199'),
          to: PhoneNumberSchema.parse('+14155550100'),
          body: 'hi',
          statusCallbackUrl: 'https://example.test/status',
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(TwilioApiError);
      expect((error as Error).message).not.toContain('4155550100');
      expect((error as TwilioApiError).status).toBe(400);
      /* The code IS carried, from the same body whose `message` is withheld —
         an integer cannot quote a phone number back, and without it a carrier
         refusal is undiagnosable from the log alone. */
      expect((error as TwilioApiError).code).toBe(21211);
    });

    it('redacts a phone number embedded in the URL path', async () => {
      // Lookups puts the number IN the path, so the URL itself is PII.
      const stub = stubCarrier({
        '/v2/PhoneNumbers/': new Response('{}', { status: 404 }),
      });
      const provider = new TwilioTelephonyProvider(config({ fetch: stub.fetch }));

      const error = await provider
        .lookupNumber(PhoneNumberSchema.parse('+14155550100'))
        .catch((caught: unknown) => caught);

      expect((error as Error).message).not.toContain('4155550100');
      expect((error as Error).message).toContain('[redacted]');
    });
  });

  describe('verification', () => {
    it('fails loudly when no Verify service is configured', async () => {
      const provider = new TwilioTelephonyProvider(config({ verifyServiceSid: undefined }));
      await expect(
        provider.startVerification({ to: PhoneNumberSchema.parse('+14155550100'), channel: 'sms' }),
      ).rejects.toThrow(/TWILIO_VERIFY_SERVICE_SID/);
    });

    it('treats only "approved" as approved', async () => {
      const stub = stubCarrier({ '/VerificationCheck': { status: 'approved' } });
      const provider = new TwilioTelephonyProvider(config({ fetch: stub.fetch }));
      const check = await provider.checkVerification({
        to: PhoneNumberSchema.parse('+14155550100'),
        code: '123456',
      });
      expect(check.approved).toBe(true);
    });
  });
});

describe('priceToCents', () => {
  it('reads Twilio negative decimal strings as a positive cost', () => {
    expect(priceToCents('-0.00750')).toBe(1);
    expect(priceToCents('-0.0140')).toBe(2);
  });

  it('rounds UP, so a sub-cent charge is never free', () => {
    // Flooring here writes a ledger row saying a call cost nothing, and a cap
    // fed by that ledger never trips no matter how many are placed.
    expect(priceToCents('-0.001')).toBe(1);
  });

  it('returns undefined for an unpriced request rather than zero', () => {
    /* Zero and "not yet priced" must not collapse: the caller substitutes a
       conservative fallback for undefined, and would substitute nothing for 0. */
    expect(priceToCents(null)).toBeUndefined();
    expect(priceToCents(undefined)).toBeUndefined();
    expect(priceToCents('')).toBeUndefined();
    expect(priceToCents('not-a-number')).toBeUndefined();
  });
});
