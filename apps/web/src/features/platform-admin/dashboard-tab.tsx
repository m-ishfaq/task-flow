import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Building2,
  CreditCard,
  Shield,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDateTime } from '../../lib/format.js';
import { Spinner } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { StepUpGate } from './shared.js';
import { errorCodeOf } from '../../lib/trpc.js';
import { cn } from '../../lib/cn.js';

/* -------------------------------------------------------------------------- *
 * Dashboard — premium command center for platform operators.
 *
 * Vercel-tier dark aesthetic: no visible borders on cards (surface-difference
 * for depth), generous whitespace, large metric type, horizontal bar charts,
 * timeline connectors for activity feeds, bento quick-actions.
 * -------------------------------------------------------------------------- */

/* ── Hero metric card ────────────────────────────────────────────────────── */

function HeroStat({
  icon: Icon,
  label,
  value,
  subtext,
  accent = false,
}: {
  readonly icon: React.ComponentType<{
    readonly className?: string;
    readonly strokeWidth?: number;
  }>;
  readonly label: string;
  readonly value: string | number;
  readonly subtext?: string;
  readonly accent?: boolean;
}) {
  return (
    <div
      className={cn(
        'group relative flex items-center gap-4 rounded-2xl px-5 py-5 transition-all duration-200',
        accent
          ? 'bg-accent/[0.06] shadow-[0_0_32px_-10px_color-mix(in_oklab,var(--color-accent)_22%,transparent)]'
          : 'bg-surface-raised hover:bg-surface-hover hover:shadow-[0_2px_24px_-6px_rgba(0,0,0,0.5)]',
      )}
    >
      <div
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-xl',
          accent ? 'bg-accent/15 text-accent' : 'bg-surface-sunken text-ink-muted',
        )}
      >
        <Icon className="size-5" strokeWidth={1.5} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-widest text-ink-faint">{label}</p>
        <p className="mt-0.5 text-3xl font-bold tracking-tight text-ink tabular-nums">{value}</p>
        {subtext !== undefined && <p className="mt-1 text-[11px] text-ink-faint">{subtext}</p>}
      </div>
    </div>
  );
}

/* ── Velocity badge ──────────────────────────────────────────────────────── */

function VelocityBadge({ velocity }: { readonly velocity: number }) {
  if (velocity === 0) return null;
  const rising = velocity > 1;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        rising ? 'bg-danger/15 text-danger' : 'bg-success/15 text-success',
      )}
    >
      <TrendingUp
        aria-hidden="true"
        className={cn('size-3', !rising && 'rotate-180')}
        strokeWidth={2.5}
      />
      {rising ? '↑' : '↓'}
    </span>
  );
}

/* ── Horizontal bar for error source ─────────────────────────────────────── */

function ErrorBar({
  label,
  count,
  max,
  color,
}: {
  readonly label: string;
  readonly count: number;
  readonly max: number;
  readonly color: string;
}) {
  const pct = max > 0 ? Math.min((count / max) * 100, 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-ink-muted">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className={cn('h-full rounded-full transition-all duration-500', color)}
          style={{ width: `${String(pct)}%` }}
        />
      </div>
      <span className="w-8 text-right text-xs font-semibold tabular-nums text-ink-faint">
        {count}
      </span>
    </div>
  );
}

/* ── Section header ──────────────────────────────────────────────────────── */

function SectionHeader({
  title,
  onNavigate,
  target,
}: {
  readonly title: string;
  readonly onNavigate: (tab: string) => void;
  readonly target: string;
}) {
  return (
    <div className="mb-5 flex items-center justify-between border-b border-line/40 pb-3">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <button
        type="button"
        onClick={() => {
          onNavigate(target);
        }}
        className="flex items-center gap-1 text-xs font-medium text-accent transition-colors hover:text-accent/80"
      >
        View all <ArrowRight className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}

/* ── Dashboard ───────────────────────────────────────────────────────────── */

export function DashboardTab({
  onNavigate,
  onStepUp,
}: {
  readonly onNavigate: (tab: string) => void;
  readonly onStepUp: () => void;
}) {
  const orgs = useQuery({
    queryKey: keys.platformOrgs(null),
    queryFn: async () =>
      wire(await api.platformAdmin.orgs.list.query({ cursor: null, limit: 100 })),
  });
  const users = useQuery({
    queryKey: keys.platformUsers(null),
    queryFn: async () =>
      wire(await api.platformAdmin.users.list.query({ cursor: null, limit: 100 })),
  });
  const billing = useQuery({
    queryKey: keys.platformBilling(null),
    queryFn: async () =>
      wire(await api.platformAdmin.billing.list.query({ cursor: null, limit: 100 })),
  });
  const errorHealth = useQuery({
    queryKey: keys.platformErrorHealth('24h'),
    queryFn: async () =>
      wire(await api.platformAdmin.operations.errorHealth.query({ timeRange: '24h' })),
  });
  const audit = useQuery({
    queryKey: keys.platformAudit(null),
    queryFn: async () => wire(await api.platformAdmin.audit.list.query({ limit: 5, before: null })),
  });
  const recentOps = useQuery({
    queryKey: keys.platformOperations(null, null),
    queryFn: async () =>
      wire(await api.platformAdmin.operations.list.query({ cursor: null, limit: 8, kind: null })),
  });

  const criticalQueries = [orgs, users, billing, audit, recentOps];
  const stepUpQuery = criticalQueries.find((q) => errorCodeOf(q.error) === 'STEP_UP_REQUIRED');
  if (stepUpQuery !== undefined) return <StepUpGate onStepUp={onStepUp} />;

  const firstError = criticalQueries.find((q) => q.error !== null && q.error !== undefined);
  if (firstError !== undefined) return <ErrorView error={firstError.error} />;

  const loading = criticalQueries.some((q) => q.isLoading);
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-ink-muted">
        <Spinner /> Loading platform data…
      </div>
    );
  }

  const orgRows = orgs.data?.orgs ?? [];
  const userRows = users.data?.users ?? [];
  const billingRows = billing.data?.orgs ?? [];

  const totalOrgs = orgRows.length;
  const activeOrgs = orgRows.filter((o) => o.status === 'active').length;
  const totalMembers = orgRows.reduce((sum, o) => sum + o.memberCount, 0);
  const totalUsers = userRows.length;
  const trials = billingRows.filter((o) => o.billingStatus === 'trialing').length;
  const mrr = billingRows.reduce((sum, o) => {
    if (o.currentPriceCents !== null && o.billingStatus === 'active')
      return sum + o.currentPriceCents;
    return sum;
  }, 0);

  const errorData = errorHealth.data;
  const auditEntries = audit.data?.entries ?? [];
  const opsEvents = recentOps.data?.events ?? [];
  const totalFailures = errorData?.summary.totalFailures ?? 0;

  const errorSources =
    errorData !== undefined
      ? ([
          { label: 'Mail', count: errorData.summary.bySource.mail, color: 'bg-info' },
          {
            label: 'Automation',
            count: errorData.summary.bySource.automation,
            color: 'bg-warning',
          },
          {
            label: 'Notifications',
            count: errorData.summary.bySource.notifications,
            color: 'bg-danger',
          },
          { label: 'Webhooks', count: errorData.summary.bySource.webhooks, color: 'bg-accent' },
        ] as const)
      : [];
  const maxError = Math.max(...errorSources.map((s) => s.count), 1);

  return (
    <div className="space-y-6">
      {/* ── Hero metrics ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <HeroStat
          icon={Building2}
          label="Organizations"
          value={totalOrgs}
          subtext={`${String(activeOrgs)} active`}
        />
        <HeroStat
          icon={Users}
          label="Users"
          value={totalUsers}
          subtext={`${String(totalMembers)} members`}
        />
        <HeroStat
          icon={CreditCard}
          label="Monthly Revenue"
          value={`$${(mrr / 100).toFixed(2)}`}
          subtext={`${String(trials)} in trial`}
          accent={mrr > 0}
        />
        <HeroStat
          icon={Activity}
          label="Failures (24h)"
          value={totalFailures}
          subtext={totalFailures > 0 ? 'needs attention' : 'all clear'}
          accent={totalFailures > 0}
        />
      </div>

      {/* ── Health + Activity ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Error health — horizontal bars */}
        <div className="rounded-2xl bg-surface-raised p-5">
          <SectionHeader title="Error Health (24h)" onNavigate={onNavigate} target="errors" />
          {errorData === undefined ? (
            <p className="text-sm text-ink-muted">No error data available.</p>
          ) : (
            <div className="space-y-4">
              <div className="space-y-3">
                {errorSources.map((source) => (
                  <ErrorBar
                    key={source.label}
                    label={source.label}
                    count={source.count}
                    max={maxError}
                    color={source.color}
                  />
                ))}
              </div>

              {errorData.orgErrors.length > 0 && (
                <div className="mt-4 border-t border-line/30 pt-4">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-widest text-ink-faint">
                    Top by velocity
                  </p>
                  <div className="space-y-2">
                    {errorData.orgErrors.slice(0, 3).map((org) => (
                      <div key={org.orgId} className="flex items-center justify-between text-sm">
                        <span className="truncate text-ink">{org.orgName}</span>
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums text-ink-muted">
                            {org.automationFailures +
                              org.notificationFailures +
                              org.webhookFailures}
                          </span>
                          <VelocityBadge velocity={org.velocity} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Operator activity — timeline */}
        <div className="rounded-2xl bg-surface-raised p-5">
          <SectionHeader title="Operator Activity" onNavigate={onNavigate} target="audit" />
          {auditEntries.length === 0 ? (
            <p className="text-sm text-ink-muted">No operator actions recorded yet.</p>
          ) : (
            <div className="relative">
              {/* Vertical connector line */}
              <div className="absolute left-[15px] top-2 bottom-2 w-px bg-line/40" />
              <div className="space-y-1">
                {auditEntries.map((entry) => (
                  <div
                    key={entry.seq}
                    className="relative flex items-start gap-3 rounded-lg px-1 py-2 transition-colors hover:bg-surface-sunken/50"
                  >
                    <div className="relative z-10 mt-0.5 flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-sunken ring-2 ring-surface-raised">
                      <Shield className="size-3.5 text-accent" aria-hidden="true" strokeWidth={2} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-ink">
                        <span className="font-medium">{entry.operatorEmail}</span>{' '}
                        <span className="text-ink-muted">{entry.action}</span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        {formatDateTime(entry.occurredAt)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Recent system events ── */}
      <div className="rounded-2xl bg-surface-raised p-5">
        <SectionHeader title="Recent System Events" onNavigate={onNavigate} target="operations" />
        {opsEvents.length === 0 ? (
          <p className="text-sm text-ink-muted">No operational events recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line/30 text-[11px] font-medium uppercase tracking-widest text-ink-faint">
                  <th className="pb-2.5 pr-6 font-medium">Time</th>
                  <th className="pb-2.5 pr-6 font-medium">Kind</th>
                  <th className="pb-2.5 pr-6 font-medium">Outcome</th>
                  <th className="pb-2.5 font-medium">Target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/20">
                {opsEvents.map((event, idx) => (
                  <tr
                    key={`${String(idx)}-${event.kind}`}
                    className="transition-colors hover:bg-surface-sunken/50"
                  >
                    <td className="whitespace-nowrap py-2.5 pr-6 text-xs text-ink-muted">
                      {formatDateTime(event.occurredAt)}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-6">
                      <span className="inline-flex items-center rounded-md bg-surface-sunken px-2 py-0.5 font-mono text-[11px] text-ink-muted">
                        {event.kind}
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-6">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold',
                          event.outcome === 'success'
                            ? 'bg-success/15 text-success'
                            : event.outcome === 'failure'
                              ? 'bg-danger/15 text-danger'
                              : 'bg-surface-hover text-ink-faint',
                        )}
                      >
                        {event.outcome}
                      </span>
                    </td>
                    <td className="max-w-[200px] truncate py-2.5 text-xs text-ink-muted">
                      {event.target ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Quick actions — bento grid ── */}
      <div className="rounded-2xl bg-surface-raised p-5">
        <h3 className="mb-4 text-sm font-semibold text-ink">Quick Actions</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {(
            [
              { tab: 'orgs', label: 'Organizations', icon: Building2 },
              { tab: 'users', label: 'Users', icon: Users },
              { tab: 'errors', label: 'Error Health', icon: Activity },
              { tab: 'audit', label: 'Audit Log', icon: Shield },
              { tab: 'broadcast', label: 'Broadcast', icon: Zap },
              { tab: 'plans', label: 'Plans', icon: CreditCard },
            ] as const
          ).map(({ tab, label, icon: Icon }) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                onNavigate(tab);
              }}
              className="group flex flex-col items-center gap-2 rounded-xl bg-surface-sunken px-4 py-4 text-center text-ink-muted transition-all duration-200 hover:bg-surface-hover hover:text-ink hover:shadow-[0_2px_16px_-4px_rgba(0,0,0,0.4)]"
            >
              <Icon
                className="size-5 transition-transform duration-200 group-hover:scale-110"
                aria-hidden="true"
                strokeWidth={1.5}
              />
              <span className="text-xs font-medium">{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
