import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Org billing — the owner-facing half, ported from
 * `apps/web/src/features/admin/billing-section.tsx`. Same routes
 * (`billing.overview/listPlans/invoices/createCheckoutSession/
 * createPortalSession/changePlan/cancelPlan/resumePlan/reconcile`), all of
 * them `org:billing` — Owner-only, and answered by no tuple (`packages/
 * policy`'s own reasoning for why it lives in the ORG_LEVEL permission
 * set). Rendered unconditionally, like every other org-settings control:
 * a non-owner sees the same honest error `apiErrorOf` renders for any
 * other permission they lack, not a hidden screen (§8.2).
 *
 * `billing.tsx` is its own screen rather than a section on
 * `org-settings.tsx` — see that file's own header for why.
 */

export type BillingOverview = Wire<
  Awaited<ReturnType<MobileTRPCClient['billing']['overview']['query']>>
>;
export type BillingPlan = Wire<
  Awaited<ReturnType<MobileTRPCClient['billing']['listPlans']['query']>>
>[number];
export type BillingInvoice = Wire<
  Awaited<ReturnType<MobileTRPCClient['billing']['invoices']['query']>>
>[number];

export const BILLING_OVERVIEW_QUERY_KEY = ['billing.overview'] as const;
export const BILLING_PLANS_QUERY_KEY = ['billing.listPlans'] as const;
export const BILLING_INVOICES_QUERY_KEY = ['billing.invoices'] as const;

/** Cents to a display string. Integer arithmetic only — money is never a float here. Ported verbatim from `billing-section.tsx`'s own `money`. */
export function formatMoney(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/**
 * Whole days from now until `when`, or null once it is in the past — same
 * "14 days left" framing as web's own `daysUntil`, so a reader does not
 * have to do the arithmetic themselves.
 */
export function daysUntil(when: string): number | null {
  const ms = new Date(when).getTime() - Date.now();
  return ms <= 0 ? null : Math.ceil(ms / (24 * 60 * 60 * 1000));
}
