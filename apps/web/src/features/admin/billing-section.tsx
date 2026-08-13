import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '../../lib/wire.js';
import { formatDate } from '../../lib/format.js';
import { Badge, Button, Section, SkeletonRows } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { featureDescription, featureLabel } from '../../lib/feature-labels.js';

/**
 * Org billing (Phase 12 Wave 3 §3.1, §5; rebuilt in Wave 4) — the
 * owner-facing half.
 *
 * `billing.*` is `org:billing`, Owner-only. Rendered unconditionally, like
 * every other section on this page (§8.2 — the UI never re-derives
 * authorization): a non-owner sees the same honest FORBIDDEN card `ErrorView`
 * renders for any other section they lack the permission for, not a hidden
 * panel.
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
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-line bg-surface-raised p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <StatusBadge billingStatus={data.billingStatus} />
                <span className="text-sm text-ink">
                  {data.planName ?? data.planId ?? 'No plan'}
                </span>
              </div>

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

              {/* Cancelling never takes effect immediately — the customer keeps
                  what they paid for until the period ends, and the server
                  refuses to do otherwise.

                  Gated on `cancelAtPeriodEnd` as well as the renewal, because
                  the first version was gated on the renewal ALONE: pressing
                  Cancel changed nothing this page could see, so the button
                  stayed, offering an action that had already been taken. */}
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

              {/* Two routes to the same button. `cancelAtPeriodEnd` is the
                  useful one — the subscription is still live and resuming
                  genuinely calls it off — where `canceled` means it has
                  already lapsed and this restarts it. */}
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

            {reconcile.isPending && (
              <p className="mt-2 text-xs text-ink-muted">Confirming your payment…</p>
            )}

            {/* ONE sentence, from the server's computed deadline — this page
                no longer decides which of three date columns matters. */}
            {data.deadline !== null && (
              <p
                className={
                  data.deadline.kind === 'grace_ends' || data.deadline.kind === 'cancels'
                    ? 'mt-2 text-xs text-danger'
                    : 'mt-2 text-xs text-ink-muted'
                }
              >
                {data.deadline.kind === 'trial_ends' && 'Trial ends '}
                {data.deadline.kind === 'grace_ends' && 'Access pauses '}
                {data.deadline.kind === 'renews' && 'Renews '}
                {data.deadline.kind === 'cancels' && 'Your subscription ends '}
                {data.deadline.kind === 'plan_changes' &&
                  `Moves to ${data.deadline.planId ?? 'another plan'} `}
                <strong>{formatDate(data.deadline.at)}</strong>
                {daysUntil(data.deadline.at) !== null &&
                  ` — ${String(daysUntil(data.deadline.at))} days`}
                .
              </p>
            )}

            {data.billingStatus === 'trialing' && data.deadline === null && (
              /* A trialing org with no end date is a real state here: seeded
                 orgs are created without one. Say so rather than rendering
                 nothing, which looked like the page was still loading. */
              <p className="mt-2 text-xs text-ink-muted">
                On trial, with no end date set. Choose a plan whenever you are ready.
              </p>
            )}

            {data.billingStatus === 'past_due' && data.billingGraceEndsAt !== null && (
              <p className="mt-2 text-xs text-danger">
                A recent payment failed. Update your payment method by{' '}
                {formatDate(data.billingGraceEndsAt)}, or access will pause.
              </p>
            )}

            {data.cancelAtPeriodEnd && data.billingStatus !== 'canceled' && (
              /* Said in full rather than left to the one-line deadline above:
                 "ends 13 Sep" does not tell somebody whether they lose access
                 that day, and that is the only question they have. */
              <p className="mt-2 text-xs text-ink-muted">
                Nothing changes until then — you keep {data.planName ?? 'your plan'} and every
                feature it includes, and you will not be charged again. Resume any time before
                the date to carry on as normal.
              </p>
            )}

            {data.billingStatus === 'canceled' && (
              <p className="mt-2 text-xs text-danger">
                This organization’s subscription has ended. Choose a plan to restore access.
              </p>
            )}

            {/* Who can act. `org:billing` is Owner-only and no tuple can
                grant it, so an admin reading this page can do nothing about
                what it says — naming the owner turns a dead end into a next
                step. */}
            {data.billingContact !== null && (
              <p className="mt-2 text-[11px] text-ink-faint">
                Billing is managed by{' '}
                <strong className="text-ink-muted">
                  {data.billingContact.name ?? data.billingContact.email}
                </strong>
                {data.billingContact.name !== null && ` (${data.billingContact.email})`}.
              </p>
            )}
          </div>

          {data.features.length > 0 && (
            <div className="rounded-lg border border-line p-3">
              <h4 className="text-xs font-semibold text-ink">Included in your plan</h4>
              <ul className="mt-1.5 flex flex-col gap-1">
                {data.features.map((feature) => (
                  <li key={feature.flagName} className="flex items-baseline gap-2">
                    <span className="shrink-0 text-success">✓</span>
                    <span>
                      <span className="text-xs text-ink">{featureLabel(feature.flagName)}</span>
                      {/* What it actually means. A chip reading "tqlTextSyntax"
                          tells a customer nothing about what they are paying
                          for. */}
                      {featureDescription(feature.flagName) !== null && (
                        <span className="block text-[11px] text-ink-muted">
                          {featureDescription(feature.flagName)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Usage, but only where there is a ceiling to compare against.
              `null` is unlimited and showing "spent $0 of unlimited" is noise;
              a real cap is the thing worth watching. */}
          {data.usage.telephonyCapCents !== null && (
            <div className="rounded-lg border border-line p-3">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-semibold text-ink">Voice &amp; messaging, last 30 days</span>
                <span className="text-ink-muted">
                  {money(data.usage.telephonySpentCents)} of {money(data.usage.telephonyCapCents)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className={
                    data.usage.telephonySpentCents >= data.usage.telephonyCapCents
                      ? 'h-full bg-danger'
                      : 'h-full bg-accent'
                  }
                  style={{
                    width: `${String(
                      Math.min(
                        100,
                        data.usage.telephonyCapCents === 0
                          ? 100
                          : Math.round(
                              (data.usage.telephonySpentCents / data.usage.telephonyCapCents) * 100,
                            ),
                      ),
                    )}%`,
                  }}
                />
              </div>
              {data.usage.telephonyIncludedCents > 0 && (
                <p className="mt-1 text-[10px] text-ink-faint">
                  {money(data.usage.telephonyIncludedCents)} is included in your plan; usage past
                  that is billed with your next invoice.
                </p>
              )}
            </div>
          )}

          <InvoiceHistory orgId={orgId} />

          <div className="rounded-lg border border-line p-3">
            <h4 className="text-xs font-semibold text-ink">Plans</h4>

            {plans.isPending && <SkeletonRows rows={2} className="mt-1.5 *:h-10" />}
            {plans.isError && <ErrorText error={plans.error} />}

            {/* An empty catalog is a real state, and the previous version of
                this page rendered it as a disabled button with no words. */}
            {plans.data !== undefined && sellable.length === 0 && (
              <p className="mt-1.5 text-xs text-ink-muted">
                No plans are available for purchase yet. Nothing is wrong with your account — the
                catalog has not been set up.
              </p>
            )}

            {sellable.length > 0 && (
              <ul className="mt-1.5 divide-y divide-line">
                {sellable.map((plan) => {
                  const monthly = plan.prices.find((price) => price.interval === 'month');
                  const current = plan.id === data.planId;

                  return (
                    <li key={plan.id} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-ink">
                          {plan.name}
                          {current && <span className="ml-1.5 text-[10px] text-accent">current</span>}
                        </p>
                        {plan.description !== null && (
                          <p className="text-xs text-ink-muted">{plan.description}</p>
                        )}
                        <p className="mt-0.5 text-xs text-ink">
                          {plan.prices
                            .map(
                              (price) =>
                                `${money(price.amountCents, price.currency)}/${price.interval}`,
                            )
                            .join(' · ')}
                        </p>

                        {/* What you actually GET. The picker previously showed
                            a name and a price and left "what is the difference
                            between these tiers" unanswerable — which is the
                            only question anyone opens a plan picker with. */}
                        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                          {plan.features.length === 0 ? (
                            <li className="text-[11px] text-ink-faint">
                              Core work management only
                            </li>
                          ) : (
                            plan.features.map((feature) => (
                              <li key={feature} className="text-[11px] text-ink-muted">
                                ✓ {featureLabel(feature)}
                              </li>
                            ))
                          )}
                        </ul>
                      </div>

                      {/* Two different processor operations behind one column.
                          With no subscription this STARTS one (checkout); with
                          a subscription it reprices the existing one, because
                          checkout would create a SECOND and bill for both. */}
                      <Button
                        {...(current ? {} : ({ variant: 'primary' } as const))}
                        size="sm"
                        disabled={
                          current || checkout.isPending || change.isPending || monthly === undefined
                        }
                        onClick={() => {
                          if (hasSubscription) {
                            /* Propose, do not act. Checkout confirms on the
                               processor's own hosted page before taking money;
                               a switch has no such step, and it moves money. */
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
          </div>
        </div>
      )}

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
              This takes effect <strong>immediately</strong>. You will be charged the difference
              for the rest of the current period, and {planName} becomes available straight away.
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

  /* Rendered only when there is something to show. A "no invoices yet" panel
     on every trialing org's settings page is noise about a normal state. */
  if (invoices.data === undefined || invoices.data.length === 0) return null;

  return (
    <div className="rounded-lg border border-line p-3">
      <h4 className="text-xs font-semibold text-ink">Invoices</h4>
      <ul className="mt-1.5 divide-y divide-line">
        {invoices.data.map((invoice) => (
          <li
            key={invoice.providerInvoiceId}
            className="flex items-center gap-3 py-1.5 text-xs"
          >
            <span className="w-24 shrink-0 text-ink-muted">{formatDate(invoice.issuedAt)}</span>
            <span className="min-w-0 flex-1 truncate text-ink">
              {invoice.number ?? invoice.providerInvoiceId}
            </span>
            <Badge>{invoice.status}</Badge>
            <span className="w-20 shrink-0 text-right text-ink">
              {money(invoice.amountDueCents, invoice.currency)}
            </span>
            {invoice.hostedInvoiceUrl !== null && (
              <a
                href={invoice.hostedInvoiceUrl}
                target="_blank"
                /* noreferrer alongside noopener: the target is the processor's
                   own page, and the referrer would leak this app's settings
                   path to it. */
                rel="noopener noreferrer"
                className="shrink-0 text-accent underline decoration-dotted"
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

function StatusBadge({ billingStatus }: { readonly billingStatus: string }) {
  return <Badge>{billingStatus}</Badge>;
}
