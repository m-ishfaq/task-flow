import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import type { OrgId } from '@taskflow/contracts';
import { CreditCard, Search, ShieldAlert } from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { Button, Field, Input, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import {
  OrgDetailDialog,
  Pagination,
  StepUpGate,
  TableSearch,
  downloadCsv,
  money,
  relativeTime,
} from './shared.js';

/* -------------------------------------------------------------------------- *
 * Billing (Phase 12 Wave 3 §3.6)
 * -------------------------------------------------------------------------- */

/**
 * A pure-SVG horizontal bar chart for billing summary stats.
 * No charting library — just rect elements sized proportionally.
 */
function BillingBarChart({
  data,
  maxValue,
}: {
  readonly data: readonly {
    readonly label: string;
    readonly value: number;
    readonly color: string;
  }[];
  readonly maxValue: number;
}) {
  if (maxValue === 0) return null;

  return (
    <div className="space-y-1.5">
      {data.map((item) => {
        const width = Math.max((item.value / maxValue) * 100, item.value > 0 ? 4 : 0);
        return (
          <div key={item.label} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-right text-[11px] text-ink-muted">
              {item.label}
            </span>
            <div className="min-w-0 flex-1">
              <svg width="100%" height="16" className="overflow-visible">
                <rect
                  x={0}
                  y={2}
                  width={`${String(width)}%`}
                  height={12}
                  rx={4}
                  fill={item.color}
                  opacity={item.value > 0 ? 0.85 : 0.15}
                />
              </svg>
            </div>
            <span className="w-8 shrink-0 text-right text-[11px] font-medium text-ink">
              {String(item.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Billing summary dashboard — computed from the current page of billing data.
 * Shows MRR, status breakdown, and plan distribution as compact bar charts.
 */
function BillingSummary({ orgs }: { readonly orgs: readonly Record<string, unknown>[] }) {
  /* MRR — sum of currentPriceCents for active orgs only. */
  const mrr = orgs.reduce((sum, org) => {
    const price = (org as { currentPriceCents?: number | null; billingStatus?: string })
      .currentPriceCents;
    const status = (org as { billingStatus?: string }).billingStatus;
    if (price !== null && price !== undefined && status === 'active') {
      return sum + price;
    }
    return sum;
  }, 0);

  /* Status counts */
  const statusCounts = {
    active: 0,
    trialing: 0,
    past_due: 0,
    canceled: 0,
  };
  for (const org of orgs) {
    const status = (org as { billingStatus?: string }).billingStatus;
    if (status === 'active') statusCounts.active++;
    else if (status === 'trialing') statusCounts.trialing++;
    else if (status === 'past_due') statusCounts.past_due++;
    else statusCounts.canceled++;
  }

  /* Plan distribution */
  const planCounts = new Map<string, number>();
  for (const org of orgs) {
    const plan = (org as { planId?: string | null }).planId ?? 'none';
    planCounts.set(plan, (planCounts.get(plan) ?? 0) + 1);
  }
  const planData = [...planCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, value]) => ({
      label,
      value,
      color: 'var(--color-accent)',
    }));

  const statusData = [
    { label: 'Active', value: statusCounts.active, color: 'var(--color-success)' },
    { label: 'Trialing', value: statusCounts.trialing, color: 'var(--color-accent)' },
    { label: 'Past due', value: statusCounts.past_due, color: 'var(--color-danger)' },
    { label: 'Canceled', value: statusCounts.canceled, color: 'var(--color-ink-faint)' },
  ];

  const maxStatus = Math.max(
    statusCounts.active,
    statusCounts.trialing,
    statusCounts.past_due,
    statusCounts.canceled,
  );
  const maxPlan = planData.length > 0 ? Math.max(...planData.map((d) => d.value)) : 0;

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {/* MRR card */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          Monthly recurring revenue
        </p>
        <p className="mt-1 text-2xl font-semibold tracking-tight text-ink">{money(mrr, 'usd')}</p>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          from {String(statusCounts.active)} active organization
          {statusCounts.active === 1 ? '' : 's'}
        </p>
      </div>

      {/* Status breakdown */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          By status
        </p>
        <BillingBarChart data={statusData} maxValue={maxStatus} />
      </div>

      {/* Plan distribution */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          By plan
        </p>
        {planData.length === 0 ? (
          <p className="text-[11px] text-ink-faint">No data</p>
        ) : (
          <BillingBarChart data={planData} maxValue={maxPlan} />
        )}
      </div>
    </div>
  );
}

export function BillingTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  /** The drill-down panel's subject — the same one the Orgs tab opens. */
  const [billingDetailOrgId, setBillingDetailOrgId] = useState<string | null>(null);
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

  const filteredOrgs = billing.data?.orgs.filter((org) => {
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
    <section aria-label="Billing">
      {billing.data !== undefined && billing.data.orgs.length > 0 && (
        <BillingSummary orgs={billing.data.orgs} />
      )}

      <div className="flex items-center justify-between gap-3">
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter by name, slug, plan, or Stripe ID…"
        />
        {billing.data !== undefined && billing.data.orgs.length > 0 && (
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
                ...billing.data.orgs.map((org) => [
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

      {billing.isPending && <SkeletonRows rows={5} className="mt-3 *:h-12" />}
      {billing.isError && <ErrorView error={billing.error} title="Could not load billing" />}

      {billing.data !== undefined && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60">
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Organization
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Status
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Plan
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Renews
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Last invoice
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Trial / grace ends
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Stripe customer
                </th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>{' '}
            <tbody className="divide-y divide-line/50">
              {(filteredOrgs ?? []).map((org) => (
                <tr
                  key={org.orgId}
                  className="group cursor-pointer border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50"
                  onClick={() => {
                    setBillingDetailOrgId(org.orgId);
                  }}
                >
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-ink transition-colors group-hover:text-accent">
                      {org.name}
                    </p>
                    <p className="font-mono text-[11px] text-ink-faint">{org.slug}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <BillingStatusBadge billingStatus={org.billingStatus} />
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="text-ink">{org.planName ?? org.planId ?? '—'}</p>
                    {org.currentPriceCents !== null && (
                      <p className="text-[11px] text-ink-faint">
                        {money(org.currentPriceCents, 'usd')}/{org.currentPriceInterval ?? 'month'}
                      </p>
                    )}
                    {org.pendingPlanId !== null && org.pendingPlanEffectiveAt !== null && (
                      <p className="text-[11px] font-medium text-warning">
                        → {org.pendingPlanId} {formatDate(org.pendingPlanEffectiveAt)}
                      </p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                    {org.currentPeriodEnd === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <span>
                        {formatDate(org.currentPeriodEnd)}
                        <span className="ml-1.5 text-[10px] text-ink-faint">
                          {relativeTime(new Date(org.currentPeriodEnd))}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {org.lastInvoice === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <>
                        <p
                          className={
                            org.lastInvoice.status === 'paid' ? 'text-success' : 'text-danger'
                          }
                        >
                          {org.lastInvoice.status}{' '}
                          {money(org.lastInvoice.amountDueCents, org.lastInvoice.currency)}
                        </p>
                        <p className="text-[11px] text-ink-faint">
                          {formatDate(org.lastInvoice.issuedAt)}
                        </p>
                      </>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                    {org.billingStatus === 'past_due' && org.billingGraceEndsAt !== null
                      ? formatDate(org.billingGraceEndsAt)
                      : org.trialEndsAt !== null
                        ? formatDate(org.trialEndsAt)
                        : '—'}
                  </td>
                  <td className="max-w-35 truncate px-3 py-2.5 font-mono text-[11px] text-ink-faint">
                    {org.stripeCustomerId ?? '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {org.billingStatus === 'past_due' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={extend.isPending}
                        onClick={() => {
                          setExtendByDays('7');
                          setExtendTarget({ orgId: org.orgId, name: org.name });
                        }}
                      >
                        Extend grace
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {(filteredOrgs ?? []).length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center">
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

      {/* A support-ticket override, not a way to mark an org paid — this
          writes billing_grace_ends_at alone, never billing_status. */}
      {billingDetailOrgId !== null && (
        <OrgDetailDialog
          orgId={billingDetailOrgId}
          onClose={() => {
            setBillingDetailOrgId(null);
          }}
        />
      )}

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

      <div className="mt-3">
        <Pagination
          hasMore={cursor !== null || (billing.data?.nextCursor ?? null) !== null}
          onNewest={() => {
            setCursor(null);
          }}
          onOlder={() => {
            setCursor(billing.data?.nextCursor ?? null);
          }}
        />
      </div>
    </section>
  );
}

function BillingStatusBadge({ billingStatus }: { readonly billingStatus: string }) {
  if (billingStatus === 'active') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
        <span className="size-1.5 rounded-full bg-success" />
        active
      </span>
    );
  }
  if (billingStatus === 'trialing') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink-faint">
        trial
      </span>
    );
  }
  if (billingStatus === 'past_due') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
        <ShieldAlert className="size-3" strokeWidth={2.5} />
        past due
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
      canceled
    </span>
  );
}
