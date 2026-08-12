import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '../../lib/wire.js';
import { formatDate } from '../../lib/format.js';
import { Badge, Button, Section, SkeletonRows } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';

/**
 * Org billing (Phase 12 Wave 3 §3.1, §5) — the owner-facing half.
 * `billing.status`/`createCheckoutSession`/`createPortalSession` are all
 * `org:billing`, Owner-only. Rendered unconditionally, like every other
 * section on this page (§8.2 — the UI never re-derives authorization): a
 * non-owner sees the same honest FORBIDDEN card `ErrorView` renders for any
 * other section they lack the permission for, not a hidden panel.
 *
 * Checkout and the customer portal are both Stripe-hosted redirects — this
 * component never collects a card number, and never will, for any processor
 * this app is ever configured against (`PaymentProvider`'s own contract).
 */
export function BillingSection({ orgId }: { readonly orgId: string }) {
  const status = useQuery({
    queryKey: keys.billing(orgId),
    queryFn: async () => wire(await api.billing.status.query()),
  });

  const checkout = useMutation({
    mutationFn: () => api.billing.createCheckoutSession.mutate({ planId: 'pro' }),
    onSuccess: (result) => {
      window.location.assign(result.url);
    },
  });

  const portal = useMutation({
    mutationFn: () => api.billing.createPortalSession.mutate(),
    onSuccess: (result) => {
      window.location.assign(result.url);
    },
  });

  return (
    <Section title="Billing" description="What this organization pays, and how to change it.">
      {status.isPending && <SkeletonRows rows={1} className="*:h-12" />}
      {status.isError && <ErrorView error={status.error} title="Could not load billing" />}

      {status.data !== undefined && (
        <div className="rounded-lg border border-line bg-surface-raised p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <StatusBadge billingStatus={status.data.billingStatus} />
              {status.data.planId !== null && (
                <span className="text-sm text-ink">
                  {status.data.planId === 'pro' ? 'Pro plan' : status.data.planId}
                </span>
              )}
            </div>

            {status.data.billingStatus === 'active' || status.data.billingStatus === 'past_due' ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={portal.isPending}
                onClick={() => {
                  portal.mutate();
                }}
              >
                {portal.isPending ? 'Redirecting…' : 'Manage subscription'}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={checkout.isPending}
                onClick={() => {
                  checkout.mutate();
                }}
              >
                {checkout.isPending ? 'Redirecting…' : 'Upgrade'}
              </Button>
            )}
          </div>

          {status.data.billingStatus === 'trialing' && status.data.trialEndsAt !== null && (
            <p className="mt-2 text-xs text-ink-muted">
              Trial ends {formatDate(status.data.trialEndsAt)}. Upgrade any time to keep access
              afterward.
            </p>
          )}

          {status.data.billingStatus === 'past_due' && status.data.billingGraceEndsAt !== null && (
            <p className="mt-2 text-xs text-danger">
              A recent payment failed. Update your payment method by{' '}
              {formatDate(status.data.billingGraceEndsAt)}, or access will pause.
            </p>
          )}

          {status.data.billingStatus === 'canceled' && (
            <p className="mt-2 text-xs text-danger">
              This organization’s subscription has ended. Upgrade to restore access.
            </p>
          )}
        </div>
      )}

      {checkout.isError && <ErrorText error={checkout.error} />}
      {portal.isError && <ErrorText error={portal.error} />}
    </Section>
  );
}

function StatusBadge({ billingStatus }: { readonly billingStatus: string }) {
  if (billingStatus === 'active') {
    return <Badge className="bg-success/15 text-success">Active</Badge>;
  }
  if (billingStatus === 'trialing') {
    return <Badge>Trial</Badge>;
  }
  if (billingStatus === 'past_due') {
    return <Badge className="bg-danger/15 text-danger">Past due</Badge>;
  }
  return <Badge className="bg-danger/15 text-danger">Canceled</Badge>;
}
