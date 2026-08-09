import { describe, expect, it } from 'vitest';
import { PhoneNumberSchema, type OutboundKind, type TelephonyProvider } from '@taskflow/contracts';

/**
 * The contract every `TelephonyProvider` implementation must satisfy
 * (PLAN.md §5; ai/phase-7-voice.md §3.1).
 *
 * ## Why this is a shared suite rather than a test file per implementation
 *
 * §5's promise is that outgrowing a free tier is "a config change plus a green
 * contract-test run." For storage that promise is cheap — three implementations
 * speak one API. Here it is not: swapping Twilio for Telnyx means a different
 * REST shape, a different signature algorithm, and a different rate card, and
 * the only thing keeping the SWAP honest is a suite that neither implementation
 * was written against specifically.
 *
 * ## What is asserted, and what deliberately is not
 *
 * Asserted: the properties the outbound gate and the webhook handler DEPEND on.
 * A cost estimate that is a positive integer, because a zero-cost estimate is a
 * spend cap that never trips. A signature verifier that really verifies,
 * because a provider that returns `true` turns an unauthenticated POST into a
 * trusted one.
 *
 * Not asserted: anything about call progress, message delivery, or carrier
 * semantics. Those need a real carrier, and a mock asserting them would only
 * prove the mock agrees with itself — the same reasoning `s3.test.ts` gives for
 * running against real MinIO instead of a stubbed S3 client.
 */

/** Twilio's own published signature vector — see `twilio-signature.test.ts`. */
const SIGNATURE_VECTOR = {
  url: 'https://example.com/myapp.php?foo=1&bar=2',
  authToken: '12345',
  params: {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+14158675310',
    Digits: '1234',
    From: '+14158675310',
    To: '+18005551212',
  },
  signature: 'L/OH5YylLD5NRKLltdqwSvS0BnU=',
} as const;

const ALL_KINDS: readonly OutboundKind[] = ['call', 'sms', 'number_purchase', 'verification'];

export function describeTelephonyProviderContract(
  name: string,
  createProvider: () => TelephonyProvider,
): void {
  describe(`TelephonyProvider contract: ${name}`, () => {
    const to = PhoneNumberSchema.parse('+14155550100');
    const from = PhoneNumberSchema.parse('+14155550199');

    describe('subaccounts are the tenancy boundary', () => {
      it('issues a distinct sid and a non-empty auth token per subaccount', async () => {
        const provider = createProvider();
        const first = await provider.createSubaccount({ friendlyName: 'org-one' });
        const second = await provider.createSubaccount({ friendlyName: 'org-two' });

        expect(first.sid).not.toBe(second.sid);
        expect(first.authToken.length).toBeGreaterThan(0);
        /* Two orgs sharing an auth token would mean one org's leaked credential
           verifies the other's webhooks — the exact blast radius §3.1 exists to
           contain. */
        expect(first.authToken).not.toBe(second.authToken);
      });

      it('can suspend a subaccount at the carrier', async () => {
        const provider = createProvider();
        const account = await provider.createSubaccount({ friendlyName: 'org' });
        await expect(
          provider.setSubaccountStatus(account.sid, 'suspended'),
        ).resolves.toBeUndefined();
      });
    });

    describe('failures arrive as rejections, never as synchronous throws', () => {
      it('rejects rather than throwing when handed an unusable subaccount', async () => {
        /* A method declared `Promise<T>` that throws SYNCHRONOUSLY is not the
           same thing as one that rejects: `provider.x(...).catch(handle)` never
           reaches `.catch`, and the throw escapes at the call site past every
           caller written to handle a rejection. The gate's error handling is
           exactly such a caller, so this would bypass it in precisely the
           failure cases it exists for.

           Asserted by CALLING and inspecting, not with `expect().rejects`,
           which would itself be tripped by the synchronous throw. */
        const provider = createProvider();
        let returned: unknown;
        let threw = false;
        try {
          returned = provider.setSubaccountStatus('definitely-not-a-real-sid', 'suspended');
        } catch {
          threw = true;
        }

        expect(threw, 'threw synchronously instead of returning a promise').toBe(false);
        expect(returned).toBeInstanceOf(Promise);
        // Whether it resolves or rejects is the implementation's business; that
        // it produced a promise at all is the contract.
        await (returned as Promise<unknown>).catch(() => undefined);
      });
    });

    describe('cost estimation feeds the spend cap', () => {
      it('returns a POSITIVE INTEGER of cents for every outbound kind', async () => {
        const provider = createProvider();
        for (const kind of ALL_KINDS) {
          const cents = await provider.estimateCostCents({ kind, to });
          /* Zero is the failure this asserts against, not a valid answer. An
             action estimated at zero passes any cap an unlimited number of
             times — the cap is still "enforced", and still never trips. */
          expect(cents, `${kind} estimate`).toBeGreaterThan(0);
          expect(Number.isInteger(cents), `${kind} estimate is an integer`).toBe(true);
        }
      });

      it('does not require a network round trip to answer', async () => {
        /* The estimate runs inside the gate on every outbound action. An
           implementation that called its carrier's pricing API here would put a
           third party on the critical path of a control, and the honest
           handling of "pricing unreachable" is to refuse — turning a carrier
           hiccup into an outage. 50ms is generous for a table lookup and far
           under any real round trip. */
        const provider = createProvider();
        const started = Date.now();
        await provider.estimateCostCents({ kind: 'sms', to });
        expect(Date.now() - started).toBeLessThan(50);
      });
    });

    describe('webhook signature verification is real', () => {
      it("accepts Twilio's published vector", () => {
        expect(createProvider().verifyWebhookSignature({ ...SIGNATURE_VECTOR })).toBe(true);
      });

      it('rejects a tampered destination', () => {
        expect(
          createProvider().verifyWebhookSignature({
            ...SIGNATURE_VECTOR,
            params: { ...SIGNATURE_VECTOR.params, To: '+18095550100' },
          }),
        ).toBe(false);
      });

      it('rejects an empty signature', () => {
        expect(
          createProvider().verifyWebhookSignature({ ...SIGNATURE_VECTOR, signature: '' }),
        ).toBe(false);
      });
    });

    describe('outbound actions report what they cost', () => {
      it('placeCall returns a sid and a non-zero cost', async () => {
        const provider = createProvider();
        const account = await provider.createSubaccount({ friendlyName: 'org' });
        const result = await provider.placeCall({
          subaccountSid: account.sid,
          from,
          to,
          instructionsUrl: 'https://example.test/voice',
          statusCallbackUrl: 'https://example.test/status',
        });

        expect(result.sid.length).toBeGreaterThan(0);
        expect(result.costCents).toBeGreaterThan(0);
      });

      it('sendSms reports at least one segment and a non-zero cost', async () => {
        const provider = createProvider();
        const account = await provider.createSubaccount({ friendlyName: 'org' });
        const result = await provider.sendSms({
          subaccountSid: account.sid,
          from,
          to,
          body: 'hello',
          statusCallbackUrl: 'https://example.test/status',
        });

        expect(result.segments).toBeGreaterThanOrEqual(1);
        expect(result.costCents).toBeGreaterThan(0);
      });
    });

    describe('numbers', () => {
      it('returns E.164 numbers from a search', async () => {
        const provider = createProvider();
        const account = await provider.createSubaccount({ friendlyName: 'org' });
        const found = await provider.searchAvailableNumbers({
          subaccountSid: account.sid,
          isoCountry: 'US',
          limit: 2,
        });

        expect(found.length).toBeGreaterThan(0);
        for (const entry of found) {
          // Parsing rather than regexing: this is the same schema the geo
          // allowlist relies on, so a number that fails here is one that would
          // have been denied downstream for the wrong reason.
          expect(() => PhoneNumberSchema.parse(entry.phoneNumber)).not.toThrow();
        }
      });

      it('does not report a merely AVAILABLE number as one the account owns', async () => {
        /* The distinction the seeder and every "which number do I send from"
           caller depends on. A provider that answered `listOwnedNumbers` from
           the same inventory as `searchAvailableNumbers` would hand back a
           number that only becomes usable by BUYING it — and the failure
           would surface as a carrier rejection at send time, long after the
           wrong number was chosen. */
        const provider = createProvider();
        const account = await provider.createSubaccount({ friendlyName: 'org' });

        const available = await provider.searchAvailableNumbers({
          subaccountSid: account.sid,
          isoCountry: 'US',
          limit: 2,
        });
        const ownedBefore = await provider.listOwnedNumbers({ accountSid: account.sid });

        const availableSet = new Set(available.map((entry) => entry.phoneNumber));
        for (const entry of ownedBefore) {
          expect(availableSet.has(entry.phoneNumber)).toBe(false);
        }
      });

      it('reports a purchased number as owned, in E.164', async () => {
        const provider = createProvider();
        const account = await provider.createSubaccount({ friendlyName: 'org' });
        const available = await provider.searchAvailableNumbers({
          subaccountSid: account.sid,
          isoCountry: 'US',
          limit: 1,
        });
        const target = available[0];
        expect(target).toBeDefined();
        if (target === undefined) return;

        const purchased = await provider.purchaseNumber({
          subaccountSid: account.sid,
          phoneNumber: target.phoneNumber,
          voiceUrl: 'https://example.test/voice',
          smsUrl: 'https://example.test/sms',
        });

        const owned = await provider.listOwnedNumbers({ accountSid: account.sid });
        const match = owned.find((entry) => entry.sid === purchased.sid);

        expect(match).toBeDefined();
        expect(() => PhoneNumberSchema.parse(match?.phoneNumber)).not.toThrow();
      });
    });

    describe('verification', () => {
      it('refuses an incorrect code', async () => {
        const provider = createProvider();
        await provider.startVerification({ to, channel: 'sms' });
        const check = await provider.checkVerification({ to, code: '000000' });
        expect(check.approved).toBe(false);
      });
    });
  });
}
