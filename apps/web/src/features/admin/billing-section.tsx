import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { Badge, Button, Section, SkeletonRows } from '../../components/primitives.js';
import { cn } from '../../lib/cn.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { featureDescription, featureLabel } from '../../lib/feature-labels.js';
import { useBranding } from '../../lib/branding-context.js';

/**
 * Org billing (Phase 12 Wave 3 §3.1, §5; rebuilt in Wave 4) — the
 * owner-facing half.
 *
 * `billing.*` is `org:billing`, Owner-only, and nothing ever turns it on
 * for anyone else — no tuple, no plan upgrade, no member grant
 * (`org:billing` is not in `GRANTABLE_PERMISSIONS`). `settings-page.tsx`
 * only mounts this component when `capabilities.viewBilling` is true
 * (Phase 15 §1's audit of the old "render unconditionally, let it 403"
 * doctrine — showing a non-owner a live Billing section that always
 * answers FORBIDDEN is not "the UI re-deriving authorization" §8.2 warns
 * against, it is exposing another person's payment configuration to
 * someone who was never going to be allowed to see it). This component
 * itself still does not re-check anything — it trusts the mount decision
 * and would render correctly even if reached directly, since every route it
 * calls still enforces `org:billing` server-side regardless.
 *
 * Checkout and the customer portal are both processor-hosted redirects — this
 * component never collects a card number, and never will, for any processor
 * this app is ever configured against (`PaymentProvider`'s own contract).
 *
 * ## What Wave 4 changed, and why
 *
 * This was a status badge and one "Upgrade" button posting a hardcoded
 * `{ planId: 'pro' }`. It could not say what the org was ON, what that
 * included, how much of it they had used, or who could change it — and when
 * the catalog had no priced plan, the button simply sat disabled with no
 * explanation, which is the state that sent someone looking for a bug.
 *
 * So: every plan in the catalog is listed with its real price, the current one
 * is marked, an empty catalog says so in words, and a non-owner is told who to
 * ask rather than shown a control that will refuse them.
 */
export function BillingSection({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();
  const { salesEmail } = useBranding();

  const overview = useQuery({
    queryKey: keys.billing(orgId),
    queryFn: async () => wire(await api.billing.overview.query()),
  });

  const plans = useQuery({
    queryKey: keys.billingPlans(orgId),
    queryFn: async () => wire(await api.billing.listPlans.query()),
  });

  const checkout = useMutation({
    mutationFn: (input: { planId: string; interval: 'month' | 'year' }) =>
      api.billing.createCheckoutSession.mutate(input),
    onSuccess: (result) => {
      window.location.assign(result.url);
    },
  });

  const invalidateBilling = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.billing(orgId) });
    await queryClient.invalidateQueries({ queryKey: keys.billingPlans(orgId) });
  };

  /* Switching an EXISTING subscription is a different call from starting one.
     Checkout would create a second subscription and bill for both — the
     server refuses that, and this is the button that does the right thing. */
  const change = useMutation({
    mutationFn: (input: { planId: string; interval: 'month' | 'year' }) =>
      api.billing.changePlan.mutate(input),
    onSuccess: invalidateBilling,
  });

  const cancel = useMutation({
    mutationFn: () => api.billing.cancelPlan.mutate(),
    onSuccess: invalidateBilling,
  });

  const resume = useMutation({
    mutationFn: () => api.billing.resumePlan.mutate(),
    onSuccess: invalidateBilling,
  });

  const portal = useMutation({
    mutationFn: () => api.billing.createPortalSession.mutate(),
    onSuccess: (result) => {
      window.location.assign(result.url);
    },
  });

  /**
   * Checkout redirects back with `?checkout=success`, and at that moment the
   * webhook confirming the payment has usually NOT arrived — Stripe delivers
   * it out of band, and against a localhost API with no forwarding tunnel it
   * never arrives at all. Without this the owner lands on a page still saying
   * "trialing", which reads as the purchase having done nothing.
   *
   * So the return triggers a reconcile: the server asks the processor what
   * this customer's subscription actually is and applies it. The webhook is
   * still the primary path; this makes the page tell the truth immediately
   * either way.
   *
   * `useRef` guards it to once per mount — React 19's strict mode double-
   * invokes effects, and the URL parameter survives until navigation, so
   * without the guard this fires twice on every render pass.
   */
  const reconciled = useRef(false);
  const reconcile = useMutation({
    mutationFn: () => api.billing.reconcile.mutate(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.billing(orgId) });
      await queryClient.invalidateQueries({ queryKey: keys.billingInvoices(orgId) });
    },
  });

  const returnedFromCheckout =
    new URLSearchParams(window.location.search).get('checkout') === 'success';

  useEffect(() => {
    if (!returnedFromCheckout || reconciled.current) return;
    reconciled.current = true;
    reconcile.mutate();
    /* `reconcile` is a stable mutation object from TanStack; including it
       would re-run this on every render without changing what it does. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnedFromCheckout]);

  const data = overview.data;
  /* Only plans that can actually be bought. A tier with no current price is
     one an operator has created and not finished pricing — showing it with a
     dead button is how the previous version of this page confused people. */
  const sellable = (plans.data ?? []).filter((plan) => plan.prices.length > 0);

  /* The switch a click PROPOSED, held until the dialog confirms it. An
     upgrade charges immediately and a downgrade waits until the period ends —
     the server decides which, but the person clicking deserves to know which
     one they are about to get. */
  const [proposed, setProposed] = useState<{
    readonly planId: string;
    readonly planName: string;
    readonly amountCents: number;
  } | null>(null);

  /* From the server, not inferred from `deadline.kind`. The deadline holds
     ONE value and several of them imply a subscription, so deriving it here
     meant scheduling a cancellation (kind becomes `cancels`) flipped every
     plan button from "Switch" to "Choose" — starting a checkout for an org
     that already had a subscription, which the server refuses. */
  const hasSubscription = data?.hasSubscription ?? false;

  return (
    <Section title="Billing" description="What this organization pays, and how to change it.">
      {overview.isPending && <SkeletonRows rows={2} className="*:h-12" />}
      {overview.isError && <ErrorView error={overview.error} title="Could not load billing" />}

      {data !== undefined && (
        <div className="flex flex-col gap-4">
          {/* ── Hero: current plan + price + renewal ── */}
          <div className="rounded-xl border border-line/50 bg-surface-raised p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <StatusBadge billingStatus={data.billingStatus} />
                  <span className="text-lg font-semibold text-ink">
                    {data.planName ?? data.planId ?? 'No plan'}
                  </span>
                </div>

                {data.currentPriceCents !== null && (
                  <p className="mt-2 text-2xl font-bold tracking-tight text-ink">
                    {money(data.currentPriceCents)}
                    <span className="text-sm font-normal text-ink-muted">/month</span>
                  </p>
                )}

                {data.deadline !== null && (
                  <p
                    className={
                      data.deadline.kind === 'grace_ends' || data.deadline.kind === 'cancels'
                        ? 'mt-2 text-sm text-danger'
                        : 'mt-2 text-sm text-ink-muted'
                    }
                  >
                    {data.deadline.kind === 'trial_ends' && 'Trial ends '}
                    {data.deadline.kind === 'grace_ends' && 'Access pauses '}
                    {data.deadline.kind === 'renews' && 'Renews '}
                    {data.deadline.kind === 'cancels' && 'Your subscription ends '}
                    {data.deadline.kind === 'plan_changes' &&
                      `Moves to ${data.deadline.planId ?? 'another plan'} `}
                    <strong className="text-ink">{formatDate(data.deadline.at)}</strong>
                    {daysUntil(data.deadline.at) !== null && (
                      <span className="ml-1 inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                        {String(daysUntil(data.deadline.at))} days
                      </span>
                    )}
                  </p>
                )}

                {data.billingStatus === 'trialing' && data.deadline === null && (
                  <p className="mt-2 text-sm text-ink-muted">
                    On trial, with no end date set. Choose a plan whenever you are ready.
                  </p>
                )}

                {data.billingStatus === 'past_due' && data.billingGraceEndsAt !== null && (
                  <p className="mt-2 text-sm text-danger">
                    A recent payment failed. Update your payment method by{' '}
                    {formatDate(data.billingGraceEndsAt)}, or access will pause.
                  </p>
                )}

                {data.cancelAtPeriodEnd && data.billingStatus !== 'canceled' && (
                  <p className="mt-2 text-sm text-ink-muted">
                    Nothing changes until then — you keep {data.planName ?? 'your plan'} and every
                    feature it includes, and you will not be charged again. Resume any time before
                    the date to carry on as normal.
                  </p>
                )}

                {data.billingStatus === 'canceled' && (
                  <p className="mt-2 text-sm text-danger">
                    This organization's subscription has ended. Choose a plan to restore access.
                  </p>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full max-sm:flex-col max-sm:[&>button]:w-full">
                {(data.billingStatus === 'active' || data.billingStatus === 'past_due') && (
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
                )}

                {data.billingStatus === 'active' &&
                  !data.cancelAtPeriodEnd &&
                  data.deadline?.kind === 'renews' && (
                    <Button
                      size="sm"
                      disabled={cancel.isPending}
                      onClick={() => {
                        cancel.mutate();
                      }}
                    >
                      {cancel.isPending ? 'Cancelling…' : 'Cancel at period end'}
                    </Button>
                  )}

                {(data.cancelAtPeriodEnd || data.billingStatus === 'canceled') && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={resume.isPending}
                    onClick={() => {
                      resume.mutate();
                    }}
                  >
                    {resume.isPending ? 'Resuming…' : 'Resume subscription'}
                  </Button>
                )}
              </div>
            </div>

            {reconcile.isPending && (
              <p className="mt-3 text-xs text-ink-muted">Confirming your payment…</p>
            )}

            {data.billingContact !== null && (
              <p className="mt-3 text-xs text-ink-faint">
                Billing is managed by{' '}
                <strong className="text-ink-muted">
                  {data.billingContact.name ?? data.billingContact.email}
                </strong>
                {data.billingContact.name !== null && ` (${data.billingContact.email})`}.
              </p>
            )}
          </div>

          {/* ── Usage ── */}
          {(data.usage.telephonyCapCents !== null || data.usage.aiCapCents !== null) && (
            <div className="grid gap-4 sm:grid-cols-2">
              {data.usage.telephonyCapCents !== null && (
                <UsageCard
                  label="Voice & messaging"
                  sublabel="last 30 days"
                  spent={data.usage.telephonySpentCents}
                  cap={data.usage.telephonyCapCents}
                  included={data.usage.telephonyIncludedCents}
                  includedNote="included in your plan; usage past that is billed with your next invoice"
                />
              )}
              {data.usage.aiCapCents !== null && (
                <UsageCard
                  label="AI assistant"
                  sublabel="this month"
                  spent={data.usage.aiSpentCents}
                  cap={data.usage.aiCapCents}
                />
              )}
            </div>
          )}

          {/* ── Included features ── */}
          {data.features.length > 0 && (
            <div className="rounded-xl border border-line/50 bg-surface-raised p-4">
              <h4 className="text-xs font-semibold text-ink">Included in your plan</h4>
              <div className="mt-2.5 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {data.features.map((feature) => (
                  <div key={feature.flagName} className="flex items-start gap-2.5">
                    <span className="mt-0.5 shrink-0 text-sm text-success">✓</span>
                    <div className="min-w-0">
                      <span className="text-sm text-ink">{featureLabel(feature.flagName)}</span>
                      {featureDescription(feature.flagName) !== null && (
                        <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                          {featureDescription(feature.flagName)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Plans ── */}
          <div className="rounded-xl border border-line/50 bg-surface-raised p-4">
            <h4 className="text-xs font-semibold text-ink">Plans</h4>

            {plans.isPending && <SkeletonRows rows={2} className="mt-2.5 *:h-10" />}
            {plans.isError && <ErrorText error={plans.error} />}

            {plans.data !== undefined && sellable.length === 0 && (
              <p className="mt-2.5 text-xs text-ink-muted">
                No plans are available for purchase yet. Nothing is wrong with your account — the
                catalog has not been set up.
              </p>
            )}

            {sellable.length > 0 && (
              <ul className="mt-2.5 space-y-1.5">
                {sellable.map((plan) => {
                  const monthly = plan.prices.find((price) => price.interval === 'month');
                  const current = plan.id === data.planId;

                  return (
                    <li
                      key={plan.id}
                      className={cn(
                        'flex flex-wrap items-center gap-4 rounded-lg border p-3.5 transition-colors max-sm:flex-col max-sm:items-stretch max-sm:gap-3',
                        current
                          ? 'border-accent/30 bg-accent/5'
                          : 'border-line/50 hover:border-line-strong',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-ink">{plan.name}</p>
                          {current && (
                            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                              current
                            </span>
                          )}
                        </div>
                        {plan.description !== null && (
                          <p className="mt-0.5 text-xs text-ink-muted">{plan.description}</p>
                        )}
                        <p className="mt-1 text-xs text-ink">
                          {plan.prices
                            .map(
                              (price) =>
                                `${money(price.amountCents, price.currency)}/${price.interval}`,
                            )
                            .join(' · ')}
                        </p>

                        {plan.features.length > 0 && (
                          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                            {plan.features.map((feature) => (
                              <li key={feature} className="text-[11px] text-ink-muted">
                                ✓ {featureLabel(feature)}
                              </li>
                            ))}
                          </ul>
                        )}
                        {plan.features.length === 0 && (
                          <p className="mt-1.5 text-[11px] text-ink-faint">
                            Core work management only
                          </p>
                        )}
                      </div>

                      <Button
                        {...(current ? {} : ({ variant: 'primary' } as const))}
                        size="sm"
                        className="max-sm:w-full"
                        disabled={
                          current || checkout.isPending || change.isPending || monthly === undefined
                        }
                        onClick={() => {
                          if (hasSubscription) {
                            setProposed({
                              planId: plan.id,
                              planName: plan.name,
                              amountCents: monthly?.amountCents ?? 0,
                            });
                          } else {
                            checkout.mutate({ planId: plan.id, interval: 'month' });
                          }
                        }}
                      >
                        {current
                          ? 'Current'
                          : checkout.isPending || change.isPending
                            ? 'Working…'
                            : hasSubscription
                              ? 'Switch'
                              : 'Choose'}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}

            {salesEmail !== null && (
              <div className="flex items-center justify-between gap-3 border-t border-line/50 pt-3 max-sm:flex-col max-sm:items-stretch max-sm:gap-3">
                <div>
                  <p className="text-sm text-ink">Enterprise</p>
                  <p className="text-xs text-ink-muted">
                    Custom limits and a plan tailored to how your organization actually works.
                  </p>
                </div>
                <Button
                  size="sm"
                  className="max-sm:w-full"
                  onClick={() => {
                    window.location.assign(`mailto:${salesEmail}`);
                  }}
                >
                  Contact us
                </Button>
              </div>
            )}
          </div>

          <InvoiceHistory orgId={orgId} />

          {proposed !== null && data !== undefined && (
            <SwitchPlanDialog
              planName={proposed.planName}
              amountCents={proposed.amountCents}
              currentPriceCents={data.currentPriceCents}
              renewsAt={data.deadline?.kind === 'renews' ? data.deadline.at : null}
              pending={change.isPending}
              onClose={() => {
                setProposed(null);
              }}
              onConfirm={() => {
                change.mutate({ planId: proposed.planId, interval: 'month' });
                setProposed(null);
              }}
            />
          )}

          {change.isError && <ErrorText error={change.error} />}
          {cancel.isError && <ErrorText error={cancel.error} />}
          {resume.isError && <ErrorText error={resume.error} />}
          {checkout.isError && <ErrorText error={checkout.error} />}
          {portal.isError && <ErrorText error={portal.error} />}
        </div>
      )}
    </Section>
  );
}

/**
 * Confirms a plan switch, saying WHICH WAY it goes before it happens.
 *
 * The server decides upgrade-versus-downgrade from the price and does not
 * consult this; the comparison is repeated here purely to word the sentence.
 * So a client that got it wrong would show the wrong copy and still produce
 * the right behaviour — the correct direction for a number that has been
 * through a browser.
 *
 * Worth a dialog because the two outcomes are genuinely different and neither
 * is legible from a button labelled "Switch": one takes money today, the other
 * changes nothing until a date weeks away.
 */
function SwitchPlanDialog({
  planName,
  amountCents,
  currentPriceCents,
  renewsAt,
  pending,
  onClose,
  onConfirm,
}: {
  readonly planName: string;
  readonly amountCents: number;
  readonly currentPriceCents: number | null;
  readonly renewsAt: string | null;
  readonly pending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  /* Null current price means we have no record of what they pay — treat that
     as an upgrade, because warning about a charge that does not arrive is a
     far better failure than staying silent about one that does. */
  const isUpgrade = amountCents > (currentPriceCents ?? 0);

  return (
    <ModalRoot
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ModalContent size="sm" className="p-4">
        <ModalTitle>Switch to {planName}?</ModalTitle>
        <ModalDescription>
          {isUpgrade ? (
            <>
              This takes effect <strong>immediately</strong>. You will be charged the difference for
              the rest of the current period, and {planName} becomes available straight away.
            </>
          ) : (
            <>
              This takes effect{' '}
              <strong>
                {renewsAt === null ? 'at the end of your current period' : formatDate(renewsAt)}
              </strong>
              . You keep everything you are paying for until then — nothing is removed today, and
              there is no charge now.
            </>
          )}
        </ModalDescription>

        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>
            Keep current plan
          </Button>
          <Button variant="primary" size="sm" disabled={pending} onClick={onConfirm}>
            {isUpgrade ? 'Upgrade now' : 'Schedule change'}
          </Button>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/**
 * Recorded invoices.
 *
 * Served from our own mirror (migration 0065) rather than fetched from the
 * processor, so this section renders during a processor incident — which is
 * exactly when a worried customer opens it. Each row links to the processor's
 * hosted copy, because the mirror is a convenience and that document is the
 * authoritative one.
 *
 * Its own component, and its own query: an empty history is the common case
 * for a trialing org, and there is no reason for it to delay the plan picker
 * above it.
 */
function InvoiceHistory({ orgId }: { readonly orgId: string }) {
  const invoices = useQuery({
    queryKey: keys.billingInvoices(orgId),
    queryFn: async () => wire(await api.billing.invoices.query({ limit: 24 })),
  });

  if (invoices.data === undefined || invoices.data.length === 0) return null;

  return (
    <div className="rounded-xl border border-line/50 bg-surface-raised p-4">
      <h4 className="text-xs font-semibold text-ink">Invoices</h4>
      <ul className="mt-2.5 divide-y divide-line/50">
        {invoices.data.map((invoice) => (
          <li
            key={invoice.providerInvoiceId}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-xs first:pt-0 last:pb-0 max-sm:gap-x-2 max-sm:gap-y-0.5"
          >
            <span className="w-24 shrink-0 text-ink-muted max-sm:w-auto">
              {formatDate(invoice.issuedAt)}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-ink">
              {invoice.number ?? invoice.providerInvoiceId}
            </span>
            <Badge
              className={cn(
                invoice.status === 'paid'
                  ? 'text-success border-success/30 bg-success/10'
                  : invoice.status === 'open'
                    ? 'text-accent border-accent/30 bg-accent/10'
                    : invoice.status === 'void'
                      ? 'text-ink-faint border-line/30 bg-surface-hover/50'
                      : '',
              )}
            >
              {invoice.status}
            </Badge>
            <span className="w-20 shrink-0 text-right font-medium text-ink max-sm:w-auto max-sm:text-left">
              {money(invoice.amountDueCents, invoice.currency)}
            </span>
            {invoice.hostedInvoiceUrl !== null && (
              <a
                href={invoice.hostedInvoiceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
              >
                View
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Whole days from now until `when`, or null once it is in the past.
 *
 * A date alone makes the reader do the arithmetic; "14 days left" is the thing
 * they actually wanted to know. Null past the deadline rather than a negative
 * number, because "-3 days left" is not a sentence.
 */
function daysUntil(when: string | Date): number | null {
  /* `string | Date`, and the string case is the real one: no tRPC transformer
     is configured, so a `z.date()` output arrives as an ISO string and
     `wire()` is what stops the compiler agreeing with the lie (see
     `lib/wire.ts`). Typing this as `Date` compiled and would have thrown
     `when.getTime is not a function` at runtime — the compiler caught it here
     only because the value had been through `wire()`. */
  const ms = new Date(when).getTime() - Date.now();
  return ms <= 0 ? null : Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/** Cents to a display string. Integer arithmetic only — money is never a float here. */
function money(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function UsageCard({
  label,
  sublabel,
  spent,
  cap,
  included,
  includedNote,
}: {
  readonly label: string;
  readonly sublabel: string;
  readonly spent: number;
  readonly cap: number;
  readonly included?: number;
  readonly includedNote?: string;
}) {
  const pct = cap === 0 ? 100 : Math.min(100, Math.round((spent / cap) * 100));
  const over = spent >= cap;

  return (
    <div className="rounded-xl border border-line/50 bg-surface-raised p-4">
      <p className="text-xs font-semibold text-ink">{label}</p>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="text-2xl font-bold tracking-tight text-ink">{money(spent)}</span>
        <span className="text-xs text-ink-muted">
          of {money(cap)}
          <span className="ml-1 text-ink-faint">· {sublabel}</span>
        </span>
      </div>
      <div className="mt-2.5 h-2.5 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            over ? 'bg-danger' : pct > 75 ? 'bg-warning' : 'bg-accent',
          )}
          style={{ width: `${String(pct)}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px]">
        <span className={cn('font-medium', over ? 'text-danger' : 'text-ink-muted')}>
          {String(pct)}% used
        </span>
        {included !== undefined && included > 0 && includedNote !== undefined && (
          <span className="text-ink-faint">
            {money(included)} {includedNote}
          </span>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ billingStatus }: { readonly billingStatus: string }) {
  const color =
    billingStatus === 'active'
      ? 'text-success border-success/30 bg-success/10'
      : billingStatus === 'trialing'
        ? 'text-accent border-accent/30 bg-accent/10'
        : billingStatus === 'past_due'
          ? 'text-warning border-warning/30 bg-warning/10'
          : billingStatus === 'canceled'
            ? 'text-danger border-danger/30 bg-danger/10'
            : '';
  return <Badge className={color}>{billingStatus}</Badge>;
}
