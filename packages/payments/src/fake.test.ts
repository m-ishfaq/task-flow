import { describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import { FakePaymentProvider } from './fake.js';

const orgId = unsafeAsId<'OrgId'>('11111111-1111-1111-1111-111111111111');

describe('FakePaymentProvider', () => {
  it('ensureCustomer is idempotent per org', async () => {
    const provider = new FakePaymentProvider();

    const first = await provider.ensureCustomer({ orgId, email: 'owner@example.test' });
    const second = await provider.ensureCustomer({ orgId, email: 'owner@example.test' });

    expect(second.customerId).toBe(first.customerId);
  });

  it('returns a distinct customer id for a different org', async () => {
    const provider = new FakePaymentProvider();
    const otherOrgId = unsafeAsId<'OrgId'>('22222222-2222-2222-2222-222222222222');

    const first = await provider.ensureCustomer({ orgId, email: 'owner@example.test' });
    const second = await provider.ensureCustomer({
      orgId: otherOrgId,
      email: 'other@example.test',
    });

    expect(second.customerId).not.toBe(first.customerId);
  });

  it('checkout and portal sessions carry the customer id', async () => {
    const provider = new FakePaymentProvider();
    const { customerId } = await provider.ensureCustomer({ orgId, email: 'owner@example.test' });

    const checkout = await provider.createCheckoutSession({
      customerId,
      priceId: 'price_test_pro_monthly',
      successUrl: 'https://app.test/billing/success',
      cancelUrl: 'https://app.test/billing/cancel',
    });
    expect(checkout.url).toContain(customerId);

    const portal = await provider.createPortalSession({
      customerId,
      returnUrl: 'https://app.test/billing',
    });
    expect(portal.url).toContain(customerId);
  });

  it('parses a webhook event signed with the correct secret', () => {
    const provider = new FakePaymentProvider();
    const event = {
      kind: 'subscription_activated' as const,
      providerEventId: 'evt_1',
      customerId: 'cus_fake_1',
      subscriptionId: 'sub_1',
    };

    const parsed = provider.parseWebhookEvent({
      payload: JSON.stringify(event),
      signature: 'fake_signed:whsec_test',
      webhookSecret: 'whsec_test',
    });

    expect(parsed).toEqual(event);
  });

  it('refuses a webhook event with the wrong secret', () => {
    const provider = new FakePaymentProvider();

    expect(() =>
      provider.parseWebhookEvent({
        payload: '{}',
        signature: 'fake_signed:whsec_wrong',
        webhookSecret: 'whsec_test',
      }),
    ).toThrow('Invalid webhook signature.');
  });
});
