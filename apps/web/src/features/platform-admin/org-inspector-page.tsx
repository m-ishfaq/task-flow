import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Building2,
  CreditCard,
  ExternalLink,
  History,
  Shield,
  Users,
} from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { Badge, Button, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { StatCard, DetailRow, money } from './shared.js';
import { featureLabel } from '../../lib/feature-labels.js';
import { PlatformSidebar } from './platform-sidebar.js';

/**
 * Full-page org inspector at `/platform-admin/org/:orgId`.
 *
 * Two-tier design per CLAUDE.md §2.2: the slide-over panel (OrgInspectorPanel)
 * shows immediate context; this page shows everything including full member
 * list, invoices, and comprehensive operator history.
 *
 * Renders with the PlatformSidebar so the operator can navigate back to the
 * org directory or switch to another tab without leaving the inspector.
 */
export function OrgInspectorPage({ orgId }: { readonly orgId: string }) {
  const navigate = useNavigate();

  const detail = useQuery({
    queryKey: keys.platformOrgDetail(orgId),
    queryFn: async () => wire(await api.platformAdmin.orgs.detail.query({ orgId })),
  });

  const history = useQuery({
    queryKey: keys.platformOrgHistory(orgId),
    queryFn: async () => wire(await api.platformAdmin.orgs.history.query({ orgId, limit: 50 })),
  });

  const data = detail.data;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <PlatformSidebar
        activeTab="orgs"
        onNavigate={(t) => {
          void navigate({ to: '/platform-admin', search: { tab: t } });
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-8">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          {/* Back + header */}
          <div className="flex items-start gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigate({ to: '/platform-admin', search: { tab: 'orgs' } });
              }}
              className="mt-1"
            >
              <ArrowLeft className="mr-1 size-4" />
              Back to orgs
            </Button>
          </div>

          {detail.isPending && <SkeletonRows rows={10} className="*:h-12" />}
          {detail.isError && (
            <ErrorView error={detail.error} title="Could not load this organization" />
          )}

          {data !== undefined && (
            <>
              {/* Page header */}
              <div className="flex items-center gap-4">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-accent/10">
                  <Building2 className="size-6 text-accent" strokeWidth={2} />
                </span>
                <div className="min-w-0 flex-1">
                  <h1 className="text-2xl font-bold text-ink">{data.name}</h1>
                  <p className="text-sm text-ink-muted">
                    {data.slug} · created {formatDate(data.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge>{data.status}</Badge>
                  <Badge>{data.billingStatus}</Badge>
                </div>
              </div>

              {/* Quick stats */}
              <div className="grid grid-cols-4 gap-3">
                <StatCard icon={Users} label="Members" value={data.memberCount} />
                <StatCard
                  icon={CreditCard}
                  label="Telephony (30d)"
                  value={money(data.telephonySpendCents, 'usd')}
                />
                <StatCard
                  icon={Shield}
                  label="Plan"
                  value={data.planName ?? data.planId ?? 'none'}
                />
                <StatCard
                  icon={History}
                  label="Operator actions"
                  value={history.data?.length ?? '—'}
                />
              </div>

              {/* Status + Plan detail */}
              <section className="rounded-xl border border-line p-5">
                <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink">
                  <Shield className="size-4 text-ink-muted" strokeWidth={2} />
                  Status & Plan
                </h3>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                  <DetailRow label="Operator status" value={data.status} />
                  <DetailRow label="Billing status" value={data.billingStatus} />
                  <DetailRow label="Plan" value={data.planName ?? data.planId ?? 'none'} />
                  <DetailRow
                    label="Trial ends"
                    value={data.trialEndsAt === null ? '—' : formatDate(data.trialEndsAt)}
                  />
                  <DetailRow
                    label="Grace ends"
                    value={
                      data.billingGraceEndsAt === null ? '—' : formatDate(data.billingGraceEndsAt)
                    }
                  />
                  <DetailRow label="Stripe customer" value={data.stripeCustomerId ?? '—'} />
                  <DetailRow label="Stripe subscription" value={data.stripeSubscriptionId ?? '—'} />
                </dl>

                {data.override !== null && (
                  <div className="mt-4 rounded-lg border border-warning/40 bg-warning/5 p-4">
                    <p className="text-sm font-medium text-ink">Operator override active</p>
                    <p className="mt-1 text-xs text-ink-muted">{data.override.reason}</p>
                    <p className="mt-1 text-[11px] text-ink-faint">
                      Set {formatDate(data.override.setAt)}
                      {data.override.expiresAt === null
                        ? ' · no expiry'
                        : ` · expires ${formatDate(data.override.expiresAt)}`}
                    </p>
                    {data.override.featuresAdd.length > 0 && (
                      <p className="mt-2 text-[11px] text-ink-faint">
                        Added: {data.override.featuresAdd.join(', ')}
                      </p>
                    )}
                    {data.override.featuresRemove.length > 0 && (
                      <p className="mt-1 text-[11px] text-ink-faint">
                        Removed: {data.override.featuresRemove.join(', ')}
                      </p>
                    )}
                  </div>
                )}

                {/* Limits */}
                <div className="mt-4 grid grid-cols-3 gap-3">
                  <div className="rounded-lg border border-line p-3">
                    <p className="text-[11px] text-ink-muted">Telephony cap</p>
                    <p className="text-sm font-medium text-ink">
                      {data.limits.telephonyCapCents === null
                        ? 'Unlimited'
                        : money(data.limits.telephonyCapCents, 'usd')}
                    </p>
                  </div>
                  <div className="rounded-lg border border-line p-3">
                    <p className="text-[11px] text-ink-muted">Automation runs/hr</p>
                    <p className="text-sm font-medium text-ink">
                      {data.limits.automationRunsPerHour === null
                        ? 'Unlimited'
                        : String(data.limits.automationRunsPerHour)}
                    </p>
                  </div>
                  <div className="rounded-lg border border-line p-3">
                    <p className="text-[11px] text-ink-muted">TURN issuance/day</p>
                    <p className="text-sm font-medium text-ink">
                      {data.limits.turnIssuancePerDay === null
                        ? 'Unlimited'
                        : String(data.limits.turnIssuancePerDay)}
                    </p>
                  </div>
                </div>
              </section>

              {/* Entitlements */}
              <section className="rounded-xl border border-line p-5">
                <h3 className="mb-4 text-sm font-semibold text-ink">Entitlements</h3>
                <ul className="grid grid-cols-2 gap-1">
                  {data.features.map((feature) => (
                    <li
                      key={feature.flagName}
                      className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-surface-hover/30"
                    >
                      <span className={feature.enabled ? 'text-success' : 'text-ink-faint'}>
                        {feature.enabled ? '✓' : '✗'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink">
                        {featureLabel(feature.flagName)}
                      </span>
                      <span className="shrink-0 text-[11px] text-ink-faint">
                        {feature.source === 'default' ? 'plan' : feature.source}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Full members list */}
              <section className="rounded-xl border border-line p-5">
                <h3 className="mb-4 flex items-center justify-between text-sm font-semibold text-ink">
                  <span className="flex items-center gap-2">
                    <Users className="size-4 text-ink-muted" strokeWidth={2} />
                    Members ({data.memberCount} active)
                  </span>
                </h3>
                <ul className="divide-y divide-line/50 overflow-hidden rounded-lg border border-line/50">
                  {data.members.map((member) => (
                    <li
                      key={member.userId}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-surface-hover/30"
                    >
                      <span className="min-w-0 flex-1 truncate text-ink">
                        {member.name ?? member.email}
                        {member.name !== null && (
                          <span className="ml-1.5 text-xs text-ink-faint">{member.email}</span>
                        )}
                      </span>
                      <Badge>{member.role}</Badge>
                      {member.status !== 'active' && (
                        <span className="text-xs text-ink-faint">{member.status}</span>
                      )}
                      <span className="text-[11px] text-ink-faint">
                        joined {formatDate(member.joinedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              {/* Invoices */}
              {data.invoices.length > 0 && (
                <section className="rounded-xl border border-line p-5">
                  <h3 className="mb-4 text-sm font-semibold text-ink">Invoices</h3>
                  <ul className="divide-y divide-line/50 overflow-hidden rounded-lg border border-line/50">
                    {data.invoices.map((invoice) => (
                      <li
                        key={invoice.providerInvoiceId}
                        className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-surface-hover/30"
                      >
                        <span className="w-20 shrink-0 text-ink-muted">
                          {formatDate(invoice.issuedAt)}
                        </span>
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
                            rel="noopener noreferrer"
                            className="shrink-0 text-accent underline decoration-dotted"
                          >
                            <ExternalLink className="size-3.5" />
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Operator history */}
              <section className="rounded-xl border border-line p-5">
                <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink">
                  <History className="size-4 text-ink-muted" strokeWidth={2} />
                  Operator history
                </h3>
                {history.isPending && <SkeletonRows rows={5} className="mt-1 *:h-6" />}
                {history.data !== undefined &&
                  (history.data.length === 0 ? (
                    <p className="text-sm text-ink-faint">No operator actions recorded.</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5 text-xs text-ink-muted">
                      {history.data.map((entry, index) => (
                        <li
                          key={`${entry.action}-${String(index)}`}
                          className="flex items-start gap-2"
                        >
                          <span className="mt-px size-1.5 shrink-0 rounded-full bg-accent/40" />
                          <span>
                            {formatDate(entry.at)} ·{' '}
                            <span className="text-ink">{entry.action}</span> · {entry.by}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ))}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
