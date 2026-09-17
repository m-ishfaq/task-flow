import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  Building2,
  CreditCard,
  ExternalLink,
  History,
  Shield,
  Smartphone,
  Users,
  Zap,
  X,
} from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { OrgId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { Badge, Button, SkeletonRows } from '../../components/primitives.js';
import { StatusPill } from '@taskflow/ui';
import { ErrorView } from '../../components/error-view.js';
import { StatCard, DetailRow, money, relativeTime } from './shared.js';
import { featureLabel } from '../../lib/feature-labels.js';

/* -------------------------------------------------------------------------- *
 * Org Inspector Panel — slide-over detail view
 *
 * Shows everything about one org: status, billing, limits, entitlements,
 * members, invoices, operator history. Opens from the org table row click.
 * -------------------------------------------------------------------------- */

const ROLE_BADGE_TONES: Record<string, 'success' | 'danger' | 'neutral'> = {
  owner: 'success',
  admin: 'danger',
  guest: 'neutral',
};

function RoleBadge({ role }: { readonly role: string }) {
  return (
    <StatusPill
      tone={ROLE_BADGE_TONES[role] ?? 'neutral'}
      className="min-w-[48px] justify-center text-[10px]"
    >
      {role}
    </StatusPill>
  );
}

/** Format a cap value: null = unlimited, 0 = none, else formatted. */
function formatCap(cents: number | null, kind: 'money' | 'count'): string {
  if (cents === null) return 'Unlimited';
  if (kind === 'money') return money(cents, 'usd');
  return String(cents);
}

export function OrgInspectorPanel({
  orgId,
  guard: _guard,
  onClose,
}: {
  readonly orgId: string;
  readonly guard?: (error: unknown, retry: () => void) => boolean;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: keys.platformOrgDetail(orgId),
    queryFn: async () => wire(await api.platformAdmin.orgs.detail.query({ orgId })),
  });

  const history = useQuery({
    queryKey: keys.platformOrgHistory(orgId),
    queryFn: async () => wire(await api.platformAdmin.orgs.history.query({ orgId, limit: 15 })),
  });

  const aiSpend = useQuery({
    queryKey: ['platform', 'ai-spend', orgId, 30],
    queryFn: async () => wire(await api.platformAdmin.ai.spendReport.query({ sinceDays: 30 })),
  });

  const data = detail.data;

  /** AI spend for this specific org, computed from the full report. */
  const orgAiSpendCents =
    aiSpend.data !== undefined
      ? aiSpend.data.filter((r) => r.orgId === orgId).reduce((sum, r) => sum + r.totalCents, 0)
      : undefined;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-ink/20 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-label="Organization inspector"
        className="fixed bottom-0 right-0 top-0 z-50 flex w-full max-w-lg flex-col border-l border-line/50 bg-surface shadow-[−24px_0_60px_-12px_rgba(0,0,0,0.5)] transition-transform duration-200 ease-out"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-line/50 px-5 py-4">
          <Link
            to="/platform-admin"
            onClick={(e) => {
              e.preventDefault();
              onClose();
            }}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
            aria-label="Back to organizations"
          >
            <ArrowLeft className="size-4" strokeWidth={2} />
          </Link>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10">
            <Building2 className="size-4.5 text-accent" strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-ink">
              {data?.name ?? 'Organization'}
            </h2>
            <p className="truncate text-xs text-ink-muted">
              {data === undefined
                ? 'Loading…'
                : `${data.slug} · created ${formatDate(data.createdAt)} ${relativeTime(new Date(data.createdAt))}`}
            </p>
          </div>
          {data !== undefined && (
            <div className="flex shrink-0 items-center gap-1.5">
              <StatusPill
                tone={data.status === 'active' ? 'success' : 'danger'}
                className="text-[10px]"
              >
                {data.status}
              </StatusPill>
              <StatusPill
                tone={
                  data.billingStatus === 'active'
                    ? 'success'
                    : data.billingStatus === 'trialing'
                      ? 'neutral'
                      : 'danger'
                }
                className="text-[10px]"
              >
                {data.billingStatus}
              </StatusPill>
            </div>
          )}
          <button
            type="button"
            aria-label="Close panel"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-5">
          {detail.isPending && <SkeletonRows rows={8} className="*:h-12" />}
          {detail.isError && (
            <ErrorView error={detail.error} title="Could not load this organization" />
          )}

          {data !== undefined && (
            <div className="flex flex-col gap-5">
              {/* ── Quick stats row ── */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard icon={Users} label="Members" value={data.memberCount} />
                <StatCard
                  icon={CreditCard}
                  label="Telephony (30d)"
                  value={money(data.telephonySpendCents, 'usd')}
                />
                <StatCard icon={Zap} label="Plan" value={data.planName ?? data.planId ?? 'none'} />
                <StatCard
                  icon={Bot}
                  label="AI spend (30d)"
                  value={orgAiSpendCents !== undefined ? money(orgAiSpendCents, 'usd') : '—'}
                />
              </div>

              {/* ── Status & Plan ── */}
              <section className="rounded-xl bg-surface-raised p-4">
                <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink">
                  <Shield className="size-3.5 text-ink-muted" strokeWidth={2} />
                  Status & Plan
                </h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
                  <DetailRow label="Operator status" value={data.status} />
                  <DetailRow label="Billing status" value={data.billingStatus} />
                  <DetailRow label="Plan" value={data.planName ?? data.planId ?? 'none'} />
                  <DetailRow
                    label="Trial ends"
                    value={
                      data.trialEndsAt === null
                        ? '—'
                        : `${formatDate(data.trialEndsAt)} ${relativeTime(new Date(data.trialEndsAt))}`
                    }
                  />
                  <DetailRow
                    label="Grace ends"
                    value={
                      data.billingGraceEndsAt === null
                        ? '—'
                        : `${formatDate(data.billingGraceEndsAt)} ${relativeTime(new Date(data.billingGraceEndsAt))}`
                    }
                  />
                  <DetailRow label="Stripe customer" value={data.stripeCustomerId ?? '—'} mono />
                  <DetailRow
                    label="Stripe subscription"
                    value={data.stripeSubscriptionId ?? '—'}
                    mono
                  />
                </dl>

                {data.override !== null && (
                  <div className="mt-3 rounded-lg bg-warning/[0.06] p-3">
                    <p className="text-[12px] font-medium text-ink">Operator override active</p>
                    <p className="mt-0.5 text-[11px] text-ink-muted">{data.override.reason}</p>
                    <p className="mt-0.5 text-[10px] text-ink-faint">
                      Set {formatDate(data.override.setAt)}
                      {data.override.expiresAt === null
                        ? ' · no expiry'
                        : ` · expires ${formatDate(data.override.expiresAt)}`}
                    </p>
                    {data.override.featuresAdd.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {data.override.featuresAdd.map((f) => (
                          <Badge key={f} className="bg-success/10 text-success">
                            +{featureLabel(f)}
                          </Badge>
                        ))}
                        {data.override.featuresRemove.map((f) => (
                          <Badge key={f} className="bg-danger/10 text-danger">
                            −{featureLabel(f)}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* ── Limits ── */}
              <section className="rounded-xl bg-surface-raised p-4">
                <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink">
                  <Zap className="size-3.5 text-ink-muted" strokeWidth={2} />
                  Limits
                </h3>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg bg-surface p-3 text-center">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                      Telephony cap
                    </p>
                    <p className="mt-1 text-lg font-semibold tabular-nums text-ink">
                      {formatCap(data.limits.telephonyCapCents, 'money')}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface p-3 text-center">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                      Automation /hr
                    </p>
                    <p className="mt-1 text-lg font-semibold tabular-nums text-ink">
                      {formatCap(data.limits.automationRunsPerHour, 'count')}
                    </p>
                  </div>
                  <div className="rounded-lg bg-surface p-3 text-center">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                      TURN issuance /day
                    </p>
                    <p className="mt-1 text-lg font-semibold tabular-nums text-ink">
                      {formatCap(data.limits.turnIssuancePerDay, 'count')}
                    </p>
                  </div>
                </div>
              </section>

              {/* ── Entitlements ── */}
              <section className="rounded-xl bg-surface-raised p-4">
                <h3 className="mb-3 text-[13px] font-semibold text-ink">Entitlements</h3>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                  {data.features.map((feature) => (
                    <li
                      key={feature.flagName}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-surface-hover/40"
                    >
                      <span className={feature.enabled ? 'text-success' : 'text-ink-faint'}>
                        {feature.enabled ? '✓' : '✗'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink">
                        {featureLabel(feature.flagName)}
                      </span>
                      <span className="shrink-0 text-[10px] text-ink-faint">
                        {feature.source === 'default' ? 'plan' : feature.source}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              {/* ── Members ── */}
              <section className="rounded-xl bg-surface-raised p-4">
                <h3 className="mb-3 flex items-center justify-between text-[13px] font-semibold text-ink">
                  <span className="flex items-center gap-2">
                    <Users className="size-3.5 text-ink-muted" strokeWidth={2} />
                    Members ({data.memberCount} active)
                  </span>
                </h3>
                <ul className="space-y-0.5">
                  {data.members.map((member) => (
                    <li
                      key={member.userId}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-surface-hover/40"
                    >
                      <span className="min-w-0 flex-1 truncate text-ink">
                        {member.name ?? member.email}
                        {member.name !== null && (
                          <span className="ml-1 text-[11px] text-ink-faint">{member.email}</span>
                        )}
                      </span>
                      {member.hasPushDevice && (
                        <Smartphone className="size-3 shrink-0 text-ink-faint" />
                      )}
                      <RoleBadge role={member.role} />
                      <span className="w-20 shrink-0 text-right text-[10px] text-ink-faint">
                        {formatDate(member.joinedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              {/* ── Invoices ── */}
              {data.invoices.length > 0 && (
                <section className="rounded-xl bg-surface-raised p-4">
                  <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink">
                    <CreditCard className="size-3.5 text-ink-muted" strokeWidth={2} />
                    Invoices
                  </h3>
                  <ul className="space-y-0.5">
                    {data.invoices.map((invoice) => (
                      <li
                        key={invoice.providerInvoiceId}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-surface-hover/40"
                      >
                        <span className="w-16 shrink-0 text-ink-muted">
                          {formatDate(invoice.issuedAt)}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-ink">
                          {invoice.number ?? invoice.providerInvoiceId}
                        </span>
                        <StatusPill
                          tone={invoice.status === 'paid' ? 'success' : 'danger'}
                          className="min-w-[48px] justify-center text-[10px]"
                        >
                          {invoice.status}
                        </StatusPill>
                        <span className="w-16 shrink-0 text-right tabular-nums text-ink">
                          {money(invoice.amountDueCents, invoice.currency)}
                        </span>
                        {invoice.hostedInvoiceUrl !== null && (
                          <a
                            href={invoice.hostedInvoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-accent underline decoration-dotted"
                          >
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* ── Operator history ── */}
              <section className="rounded-xl bg-surface-raised p-4">
                <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink">
                  <History className="size-3.5 text-ink-muted" strokeWidth={2} />
                  Operator history
                </h3>
                {history.isPending && <SkeletonRows rows={3} className="mt-1 *:h-6" />}
                {history.data !== undefined &&
                  (history.data.length === 0 ? (
                    <p className="text-xs text-ink-faint">No operator actions recorded.</p>
                  ) : (
                    <div className="relative ml-1.5 flex flex-col gap-0 text-[11px] text-ink-muted">
                      {/* Vertical connector line */}
                      <div className="absolute left-0 top-1 bottom-1 w-px bg-line/50" />
                      {history.data.map((entry, index) => (
                        <div
                          key={`${entry.action}-${String(index)}`}
                          className="relative flex items-start gap-3 py-1.5 pl-4"
                        >
                          {/* Node on the connector */}
                          <span className="absolute left-[-3px] top-2 size-1.5 rounded-full bg-accent/40" />
                          <span>
                            {formatDate(entry.at)} ·{' '}
                            <span className="text-ink">{entry.action}</span> · {entry.by}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
              </section>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line/50 px-5 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: keys.platformOrgDetail(orgId) });
                void queryClient.invalidateQueries({ queryKey: keys.platformOrgHistory(orgId) });
                void queryClient.invalidateQueries({
                  queryKey: ['platform', 'ai-spend', orgId, 30],
                });
              }}
            >
              Refresh
            </Button>
            <Button variant="secondary" size="sm">
              <Link
                to="/platform-admin/org/$orgId"
                params={{ orgId: orgId as OrgId }}
                className="flex items-center gap-1.5"
              >
                Full inspector
                <ExternalLink className="size-3" />
              </Link>
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
