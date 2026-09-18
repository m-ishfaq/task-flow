import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle, StatusPill } from '@taskflow/ui';
import type { OrgId } from '@taskflow/contracts';
import { AlertTriangle, CreditCard, Search, Timer, Users, XCircle } from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { cn } from '../../lib/cn.js';
import { formatDate } from '../../lib/format.js';
import { Button, Field, Input, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import {
  Pagination,
  StatCard,
  StepUpGate,
  TableSearch,
  downloadCsv,
  money,
  relativeTime,
} from './shared.js';
import { OrgInspectorPanel } from './org-inspector-panel.js';

/* -------------------------------------------------------------------------- *
 * Billing (Phase 12 Wave 3 §3.6)
 * -------------------------------------------------------------------------- */

/** Urgency colour for a renewal/trial/grace date — overdue = red, within 3 days = amber. */
function urgencyColor(date: Date): string {
  const now = Date.now();
  const diff = date.getTime() - now;
  if (diff < 0) return 'text-danger';
  if (diff < 3 * 24 * 60 * 60 * 1000) return 'text-warning';
  return 'text-ink-faint';
}

export function BillingTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const [detailOrgId, setDetailOrgId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [extendTarget, setExtendTarget] = useState<{ orgId: string; name: string } | null>(null);
  const [extendByDays, setExtendByDays] = useState('7');
  const [search, setSearch] = useState('');

  const billing = useQuery({
    queryKey: keys.platformBilling(cursor),
    queryFn: async () => wire(await api.platformAdmin.billing.list.query({ cursor, limit: 25 })),
  });

  const extend = useMutation({
    mutationFn: (input: { orgId: OrgId; extendByDays: number }) =>
      api.platformAdmin.billing.grantExtension.mutate(input),
    onSuccess: async () => {
      setExtendTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['platform', 'billing'] });
    },
    onError: (error, input) => {
      guard(error, () => {
        extend.mutate(input);
      });
    },
  });

  if (errorCodeOf(billing.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const orgs = billing.data?.orgs ?? [];

  /* Summary stats — computed from the current page of billing data. */
  let mrr = 0;
  let activeCount = 0;
  let trialingCount = 0;
  let pastDueCount = 0;
  let canceledCount = 0;
  let nearestTrialEnd: Date | null = null;
  let nearestGraceEnd: Date | null = null;

  for (const org of orgs) {
    if (org.billingStatus === 'active') {
      activeCount++;
      if (org.currentPriceCents !== null && org.currentPriceCents > 0) {
        mrr += org.currentPriceCents;
      }
    } else if (org.billingStatus === 'trialing') {
      trialingCount++;
      if (org.trialEndsAt !== null) {
        const trialEnd = new Date(org.trialEndsAt);
        if (nearestTrialEnd === null || trialEnd < nearestTrialEnd) {
          nearestTrialEnd = trialEnd;
        }
      }
    } else if (org.billingStatus === 'past_due') {
      pastDueCount++;
      if (org.billingGraceEndsAt !== null) {
        const graceEnd = new Date(org.billingGraceEndsAt);
        if (nearestGraceEnd === null || graceEnd < nearestGraceEnd) {
          nearestGraceEnd = graceEnd;
        }
      }
    } else {
      canceledCount++;
    }
  }

  const filteredOrgs = orgs.filter((org) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return (
      org.name.toLowerCase().includes(q) ||
      org.slug.toLowerCase().includes(q) ||
      org.planId?.toLowerCase().includes(q) === true ||
      org.planName?.toLowerCase().includes(q) === true ||
      org.stripeCustomerId?.toLowerCase().includes(q) === true ||
      org.billingStatus.toLowerCase().includes(q)
    );
  });

  return (
    <section aria-label="Billing" className="space-y-4">
      {/* ── Summary stat cards ── */}
      {orgs.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard icon={CreditCard} label="MRR" value={money(mrr, 'usd')} accent />
          <StatCard icon={Users} label="Active" value={activeCount} />
          <div className="relative">
            <StatCard icon={Timer} label="Trialing" value={trialingCount} />
            {nearestTrialEnd !== null && (
              <p
                className={cn(
                  'absolute -bottom-3 right-4 text-[10px]',
                  urgencyColor(nearestTrialEnd),
                )}
              >
                Next: {relativeTime(nearestTrialEnd)}
              </p>
            )}
          </div>
          <div className="relative">
            <StatCard icon={AlertTriangle} label="Past due" value={pastDueCount} />
            {nearestGraceEnd !== null && (
              <p
                className={cn(
                  'absolute -bottom-3 right-4 text-[10px]',
                  urgencyColor(nearestGraceEnd),
                )}
              >
                Next: {relativeTime(nearestGraceEnd)}
              </p>
            )}
          </div>
          <StatCard icon={XCircle} label="Canceled" value={canceledCount} />
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between gap-3">
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter by name, slug, plan, or Stripe ID…"
        />
        {orgs.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const header = [
                'Organization',
                'Slug',
                'Billing status',
                'Plan',
                'Plan name',
                'Current price',
                'Interval',
                'Renews',
                'Last invoice status',
                'Last invoice amount',
                'Last invoice date',
                'Trial ends',
                'Grace ends',
                'Pending plan',
                'Stripe customer',
              ];
              const rows = [
                header,
                ...orgs.map((org) => [
                  org.name,
                  org.slug,
                  org.billingStatus,
                  org.planId ?? '',
                  org.planName ?? '',
                  org.currentPriceCents !== null ? money(org.currentPriceCents, 'usd') : '',
                  org.currentPriceInterval ?? '',
                  org.currentPeriodEnd !== null ? formatDate(org.currentPeriodEnd) : '',
                  org.lastInvoice?.status ?? '',
                  org.lastInvoice !== null
                    ? money(org.lastInvoice.amountDueCents, org.lastInvoice.currency)
                    : '',
                  org.lastInvoice !== null ? formatDate(org.lastInvoice.issuedAt) : '',
                  org.trialEndsAt !== null ? formatDate(org.trialEndsAt) : '',
                  org.billingGraceEndsAt !== null ? formatDate(org.billingGraceEndsAt) : '',
                  org.pendingPlanId ?? '',
                  org.stripeCustomerId ?? '',
                ]),
              ];
              downloadCsv(`billing-export-${new Date().toISOString().slice(0, 10)}.csv`, rows);
            }}
          >
            Export CSV
          </Button>
        )}
      </div>

      {/* ── Table ── */}
      {billing.isPending && <SkeletonRows rows={5} className="mt-3 *:h-12" />}
      {billing.isError && <ErrorView error={billing.error} title="Could not load billing" />}

      {billing.data !== undefined && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60">
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Organization
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Plan
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Renewal
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Last invoice
                </th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Stripe
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/30">
              {filteredOrgs.map((org) => {
                /* Urgency date: trial end → grace end → renewal, whichever is nearest. */
                const urgencyDate =
                  org.billingStatus === 'trialing' && org.trialEndsAt !== null
                    ? new Date(org.trialEndsAt)
                    : org.billingStatus === 'past_due' && org.billingGraceEndsAt !== null
                      ? new Date(org.billingGraceEndsAt)
                      : org.currentPeriodEnd !== null
                        ? new Date(org.currentPeriodEnd)
                        : new Date();

                return (
                  <tr
                    key={org.orgId}
                    className="group cursor-pointer border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/40"
                    onClick={() => {
                      setDetailOrgId(org.orgId);
                    }}
                  >
                    {/* Organization */}
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink transition-colors group-hover:text-accent">
                        {org.name}
                      </p>
                      <p className="font-mono text-[11px] text-ink-faint">{org.slug}</p>
                    </td>

                    {/* Status + urgency */}
                    <td className="px-4 py-3">
                      <StatusPill
                        tone={
                          org.billingStatus === 'active'
                            ? 'success'
                            : org.billingStatus === 'trialing'
                              ? 'neutral'
                              : 'danger'
                        }
                      >
                        {org.billingStatus}
                      </StatusPill>
                      <p className={cn('mt-0.5 text-[11px]', urgencyColor(urgencyDate))}>
                        {org.billingStatus === 'trialing' &&
                          org.trialEndsAt !== null &&
                          `Trial ends ${formatDate(org.trialEndsAt)} ${relativeTime(new Date(org.trialEndsAt))}`}
                        {org.billingStatus === 'past_due' &&
                          org.billingGraceEndsAt !== null &&
                          `Grace ends ${formatDate(org.billingGraceEndsAt)} ${relativeTime(new Date(org.billingGraceEndsAt))}`}
                        {org.billingStatus === 'active' &&
                          org.currentPeriodEnd !== null &&
                          `Renews ${formatDate(org.currentPeriodEnd)} ${relativeTime(new Date(org.currentPeriodEnd))}`}
                        {org.billingStatus === 'active' &&
                          org.currentPeriodEnd === null &&
                          'No renewal date'}
                        {org.billingStatus === 'canceled' && 'Canceled'}
                      </p>
                    </td>

                    {/* Plan + price + pending */}
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">
                        {org.planName ?? org.planId ?? <span className="text-ink-faint">none</span>}
                      </p>
                      {org.currentPriceCents !== null && (
                        <p className="text-[11px] text-ink-faint">
                          {money(org.currentPriceCents, 'usd')}/{org.currentPriceInterval ?? 'mo'}
                        </p>
                      )}
                      {org.pendingPlanId !== null && org.pendingPlanEffectiveAt !== null && (
                        <p className="text-[11px] font-medium text-warning">
                          → {org.pendingPlanId} {formatDate(org.pendingPlanEffectiveAt)}
                        </p>
                      )}
                    </td>

                    {/* Renewal — urgency colored */}
                    <td className="whitespace-nowrap px-4 py-3">
                      {org.currentPeriodEnd === null ? (
                        <span className="text-ink-faint">—</span>
                      ) : (
                        <span
                          className={cn(
                            'text-[11px]',
                            urgencyColor(new Date(org.currentPeriodEnd)),
                          )}
                        >
                          {formatDate(org.currentPeriodEnd)}
                          <span className="ml-1.5 text-[10px] text-ink-faint">
                            {relativeTime(new Date(org.currentPeriodEnd))}
                          </span>
                        </span>
                      )}
                    </td>

                    {/* Last invoice — compact inline */}
                    <td className="px-4 py-3">
                      {org.lastInvoice === null ? (
                        <span className="text-ink-faint">—</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <StatusPill
                            tone={org.lastInvoice.status === 'paid' ? 'success' : 'danger'}
                            className="min-w-12 justify-center text-[10px]"
                          >
                            {org.lastInvoice.status}
                          </StatusPill>
                          <span className="text-[11px] tabular-nums text-ink">
                            {org.lastInvoice.amountDueCents === 0
                              ? 'free'
                              : money(org.lastInvoice.amountDueCents, org.lastInvoice.currency)}
                          </span>
                          <span className="text-[10px] text-ink-faint">
                            {formatDate(org.lastInvoice.issuedAt)}
                          </span>
                          {org.lastInvoice.hostedInvoiceUrl !== null && (
                            <a
                              href={org.lastInvoice.hostedInvoiceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="shrink-0 text-accent underline decoration-dotted"
                              onClick={(e) => {
                                e.stopPropagation();
                              }}
                            >
                              ↗
                            </a>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Stripe customer ID */}
                    <td className="max-w-32 truncate px-4 py-3 font-mono text-[11px] text-ink-faint">
                      {org.stripeCustomerId ?? '—'}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3 text-right">
                      {org.billingStatus === 'past_due' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={extend.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExtendByDays('7');
                            setExtendTarget({ orgId: org.orgId, name: org.name });
                          }}
                        >
                          Extend grace
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredOrgs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    {search.trim() !== '' ? (
                      <div className="flex flex-col items-center gap-2">
                        <Search className="size-5 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm text-ink-faint">
                          No organizations match your search.
                        </p>
                        <p className="text-xs text-ink-faint">
                          Try a different name, slug, plan, or Stripe ID.
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <CreditCard className="size-8 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm font-medium text-ink">No billing entries yet</p>
                        <p className="max-w-xs text-xs text-ink-faint">
                          Billing data appears here once an organization subscribes to a plan
                          through Stripe.
                        </p>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {extend.isError && (
        <ErrorView error={extend.error} title="Could not extend the grace period" />
      )}

      {/* Org inspector slide-over — same panel the Orgs tab opens. */}
      {detailOrgId !== null && (
        <OrgInspectorPanel
          orgId={detailOrgId}
          guard={guard}
          onClose={() => {
            setDetailOrgId(null);
          }}
        />
      )}

      {/* Extend grace modal — keeps the disclaimer for audit. */}
      {extendTarget !== null && (
        <ModalRoot
          open
          onOpenChange={(next) => {
            if (!next) setExtendTarget(null);
          }}
        >
          <ModalContent size="sm" className="p-4">
            <ModalTitle>Extend grace period for {extendTarget.name}?</ModalTitle>
            <ModalDescription>
              Pushes the deadline before this organization is locked out for non-payment. This does
              not mark the organization as paid — only Stripe, or the organization&rsquo;s own owner
              completing checkout, does that.
            </ModalDescription>

            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const days = Number.parseInt(extendByDays, 10);
                if (Number.isInteger(days) && days > 0) {
                  extend.mutate({ orgId: extendTarget.orgId as OrgId, extendByDays: days });
                }
              }}
            >
              <Field label="Extend by (days)" htmlFor="extend-by-days">
                <Input
                  id="extend-by-days"
                  type="number"
                  min={1}
                  max={90}
                  value={extendByDays}
                  onChange={(event) => {
                    setExtendByDays(event.target.value);
                  }}
                />
              </Field>

              <div className="flex gap-2">
                <Button type="submit" variant="primary" disabled={extend.isPending}>
                  {extend.isPending ? 'Extending…' : 'Extend'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setExtendTarget(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </ModalContent>
        </ModalRoot>
      )}

      {/* ── Pagination ── */}
      <Pagination
        hasMore={cursor !== null || (billing.data?.nextCursor ?? null) !== null}
        onNewest={() => {
          setCursor(null);
        }}
        onOlder={() => {
          setCursor(billing.data?.nextCursor ?? null);
        }}
      />
    </section>
  );
}
