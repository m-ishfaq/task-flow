import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bell,
  ChevronDown,
  Clock,
  Globe,
  Minus,
  Server,
  Smartphone,
  Webhook,
  Zap,
  type LucideProps,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { Button, Badge } from '../../components/primitives.js';
import { StepUpGate, StatCard } from './shared.js';

/**
 * Error health monitoring tab — per-org error rates, trend velocity, source
 * breakdown, and a recent failure log with individual records.
 *
 * Data sourced from:
 * - `platform.operational_events` — mail, billing webhook/sweep, push (global)
 * - `platform.automation_runs` — automation failures (per-org)
 * - `platform.notification_deliveries` — email/push/sms failures (per-org)
 * - `platform.webhook_deliveries` — dead webhook deliveries (per-org)
 */

type TimeRange = '1h' | '6h' | '24h' | '7d';

const TIME_RANGES: readonly { readonly value: TimeRange; readonly label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
];

const SOURCE_META: Record<
  string,
  { label: string; icon: ComponentType<LucideProps>; color: string; note?: string }
> = {
  mail: { label: 'Mail', icon: Bell, color: 'text-blue-500' },
  automation: { label: 'Automation', icon: Zap, color: 'text-amber-500' },
  notifications: { label: 'Notifications', icon: Server, color: 'text-purple-500' },
  webhooks: { label: 'Webhooks', icon: Webhook, color: 'text-red-500' },
  push: {
    label: 'Push',
    icon: Smartphone,
    color: 'text-cyan-500',
    note: 'no_device = user has no registered device (normal for web-only users)',
  },
};

const DETAIL_KEY_LABELS: Record<string, string> = {
  reason: 'Reason',
  pathway: 'Pathway',
  statusCode: 'Status',
  error: 'Error',
};

function DetailBlock({ detail }: { readonly detail: unknown }) {
  if (detail === null || detail === undefined) return null;
  if (typeof detail === 'string') {
    return <p className="mt-1.5 text-[11px] text-ink-muted">{detail}</p>;
  }
  if (typeof detail === 'object') {
    const entries = Object.entries(detail as Record<string, unknown>);
    if (entries.length === 0) return null;
    return (
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {entries.map(([key, val]) => (
          <span key={key} className="text-ink-muted">
            <span className="font-medium text-ink-faint">{DETAIL_KEY_LABELS[key] ?? key}:</span>{' '}
            {typeof val === 'string' ? val : JSON.stringify(val)}
          </span>
        ))}
      </div>
    );
  }
  return (
    <pre className="mt-1.5 max-h-20 overflow-auto rounded bg-canvas-subtle p-2 text-[11px] text-ink-muted">
      {JSON.stringify(detail, null, 2)}
    </pre>
  );
}

function VelocityBadge({ velocity }: { readonly velocity: number }) {
  if (velocity <= 0) {
    return (
      <Badge className="gap-1 bg-secondary text-[11px]">
        <Minus className="size-3" />
        None
      </Badge>
    );
  }
  if (velocity < 1) {
    return (
      <Badge className="gap-1 bg-secondary text-[11px] text-emerald-600">
        <ArrowDown className="size-3" />
        {velocity.toFixed(1)}x
      </Badge>
    );
  }
  if (velocity <= 2) {
    return (
      <Badge className="gap-1 bg-secondary text-[11px] text-amber-600">
        <ArrowUp className="size-3" />
        {velocity.toFixed(1)}x
      </Badge>
    );
  }
  return (
    <Badge className="gap-1 bg-red-100 text-[11px] text-red-700">
      <AlertTriangle className="size-3" />
      {velocity.toFixed(1)}x
    </Badge>
  );
}

function OrgErrorCard({
  org,
  onOpenOrg,
}: {
  readonly org: {
    orgId: string;
    orgName: string;
    orgSlug: string;
    automationFailures: number;
    notificationFailures: number;
    webhookFailures: number;
    avgDaily7d: number;
    currentRate: number;
    velocity: number;
  };
  readonly onOpenOrg: (orgId: string) => void;
}) {
  const total = org.automationFailures + org.notificationFailures + org.webhookFailures;
  const hasErrors = total > 0;

  return (
    <button
      type="button"
      onClick={() => {
        onOpenOrg(org.orgId);
      }}
      className="group w-full rounded-xl border border-line bg-surface p-4 text-left transition-shadow hover:shadow-md"
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] font-semibold text-ink group-hover:text-accent">
            {org.orgName}
          </h3>
          <p className="truncate text-xs text-ink-muted">{org.orgSlug}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-ink">{total}</span>
          <VelocityBadge velocity={org.velocity} />
        </div>
      </div>

      {hasErrors && (
        <div className="flex gap-3">
          {Object.entries(SOURCE_META).map(([key, meta]) => {
            const count =
              key === 'automation'
                ? org.automationFailures
                : key === 'notifications'
                  ? org.notificationFailures
                  : key === 'webhooks'
                    ? org.webhookFailures
                    : 0;
            if (count === 0) return null;
            const Icon = meta.icon;
            return (
              <div key={key} className="flex items-center gap-1.5 text-xs text-ink-muted">
                <Icon className={`size-3.5 ${meta.color}`} strokeWidth={2} />
                <span className="font-medium">{count}</span>
              </div>
            );
          })}
        </div>
      )}

      {!hasErrors && <p className="text-xs text-ink-faint">No failures in this period</p>}

      <div className="mt-2 flex items-center gap-3 text-[11px] text-ink-faint">
        <span>7d avg: {org.avgDaily7d.toFixed(1)}/day</span>
        <span>Current: {org.currentRate.toFixed(1)}/day</span>
      </div>
    </button>
  );
}

function OperationalErrorRow({
  row,
  recent,
}: {
  readonly row: { kind: string; count: number };
  readonly recent: readonly {
    id: string;
    kind: string;
    target: string | null;
    detail?: unknown;
    occurredAt: Date | string;
  }[];
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = SOURCE_META[row.kind];
  const Icon = meta?.icon ?? Activity;
  const matching = recent.filter((r) => r.kind === row.kind);

  return (
    <div className="rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={() => {
          setExpanded(!expanded);
        }}
        className="flex w-full items-center justify-between p-3 text-left transition-colors hover:bg-canvas-subtle"
      >
        <div className="flex items-center gap-2.5">
          <Icon className={`size-4 ${meta?.color ?? 'text-ink-muted'}`} strokeWidth={2} />
          <span className="text-sm font-medium text-ink">{meta?.label ?? row.kind}</span>
          <Badge className="bg-secondary">{row.count}</Badge>
          {meta?.note && <span className="text-[11px] text-ink-faint">— {meta.note}</span>}
        </div>
        <div className="flex items-center gap-2">
          {matching.length > 0 && (
            <span className="text-[11px] text-ink-faint">{matching.length} recent</span>
          )}
          <ChevronDown
            className={`size-4 text-ink-faint transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-line">
          {matching.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-ink-faint">
              No individual failure records in this time range.
            </p>
          ) : (
            <div className="max-h-[400px] overflow-y-auto divide-y divide-line">
              {matching.map((r) => (
                <div key={r.id} className="px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-xs">
                      <Clock className="size-3 text-ink-faint" />
                      <span className="font-mono text-ink-muted">
                        {new Date(r.occurredAt).toLocaleString()}
                      </span>
                    </div>
                    {r.target && (
                      <span className="truncate font-mono text-[11px] text-ink-faint max-w-[160px]">
                        {r.target}
                      </span>
                    )}
                  </div>
                  <DetailBlock detail={r.detail} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RecentErrorsSection({
  recentAutomation,
  recentWebhooks,
}: {
  readonly recentAutomation: readonly {
    id: string;
    orgId: string;
    orgName: string;
    triggerEvent: string;
    reason: string | null;
    actionResults?: unknown;
    durationMs: number | null;
    createdAt: Date | string;
  }[];
  readonly recentWebhooks: readonly {
    id: string;
    orgId: string;
    orgName: string;
    eventName: string;
    lastStatusCode: number | null;
    lastError: string | null;
    attempts: number;
    createdAt: Date | string;
  }[];
}) {
  const hasAny = recentAutomation.length > 0 || recentWebhooks.length > 0;
  if (!hasAny) return null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Automation failures */}
      {recentAutomation.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
            <Zap className="size-4 text-amber-500" strokeWidth={2} />
            Recent Automation Failures
            <Badge className="bg-secondary">{recentAutomation.length}</Badge>
          </div>
          <div className="max-h-[360px] overflow-y-auto space-y-2">
            {recentAutomation.map((run) => (
              <div key={run.id} className="rounded-lg border border-line bg-canvas-subtle p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-ink">{run.orgName}</span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-muted">
                  <span>Trigger: {run.triggerEvent}</span>
                  {run.durationMs !== null && (
                    <span className="text-ink-faint">({(run.durationMs / 1000).toFixed(1)}s)</span>
                  )}
                </div>
                {run.reason !== null && (
                  <p className="mt-1 truncate text-[11px] text-red-600">{run.reason}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Webhook failures */}
      {recentWebhooks.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
            <Webhook className="size-4 text-red-500" strokeWidth={2} />
            Recent Webhook Failures
            <Badge className="bg-secondary">{recentWebhooks.length}</Badge>
          </div>
          <div className="max-h-[360px] overflow-y-auto space-y-2">
            {recentWebhooks.map((hook) => (
              <div key={hook.id} className="rounded-lg border border-line bg-canvas-subtle p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium text-ink">{hook.orgName}</span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                    {new Date(hook.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-muted">
                  <span>Event: {hook.eventName}</span>
                  {hook.lastStatusCode !== null && (
                    <Badge className="bg-secondary text-[10px]">HTTP {hook.lastStatusCode}</Badge>
                  )}
                  <span className="text-ink-faint">
                    {hook.attempts} attempt{hook.attempts !== 1 ? 's' : ''}
                  </span>
                </div>
                {hook.lastError !== null && (
                  <p className="mt-1 truncate text-[11px] text-red-600">{hook.lastError}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ErrorsTab({
  onStepUp,
  onOpenOrg,
}: {
  readonly onStepUp: () => void;
  readonly onOpenOrg?: (orgId: string) => void;
}) {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');

  const { data, isLoading, error } = useQuery({
    queryKey: keys.platformErrorHealth(timeRange),
    queryFn: async () => wire(await api.platformAdmin.operations.errorHealth.query({ timeRange })),
  });

  if (errorCodeOf(error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const summary = data?.summary;
  const orgErrors = data?.orgErrors ?? [];
  const operationalErrors = data?.operationalErrors ?? [];
  const recentOperational = data?.recentOperational ?? [];
  const recentAutomation = data?.recentAutomation ?? [];
  const recentWebhooks = data?.recentWebhooks ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* Time range selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-ink-muted">Time range:</span>
        <div className="flex gap-1">
          {TIME_RANGES.map((tr) => (
            <Button
              key={tr.value}
              variant={timeRange === tr.value ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => {
                setTimeRange(tr.value);
              }}
            >
              {tr.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      {summary !== undefined && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            icon={AlertTriangle}
            label="Total Failures"
            value={summary.totalFailures}
            accent={summary.totalFailures > 0}
          />
          <StatCard
            icon={Bell}
            label="Mail"
            value={summary.bySource.mail}
            accent={summary.bySource.mail > 0}
          />
          <StatCard
            icon={Zap}
            label="Automation"
            value={summary.bySource.automation}
            accent={summary.bySource.automation > 0}
          />
          <StatCard
            icon={Webhook}
            label="Webhooks"
            value={summary.bySource.webhooks}
            accent={summary.bySource.webhooks > 0}
          />
        </div>
      )}

      {/* Loading skeleton */}
      {isLoading && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Activity className="size-8 text-ink-faint animate-pulse" strokeWidth={1.5} />
          <p className="text-sm text-ink-muted">Loading error data…</p>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && summary?.totalFailures === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-emerald-200 bg-emerald-50/30 py-16 text-center">
          <Activity className="size-10 text-emerald-500" strokeWidth={1.5} />
          <div>
            <p className="text-sm font-medium text-emerald-700">No failures detected</p>
            <p className="mt-1 text-xs text-emerald-600/70">
              All subsystems are healthy in the selected time range.
            </p>
          </div>
        </div>
      )}

      {/* Global operational errors */}
      {operationalErrors.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-ink">Global Operational Errors</h3>
          <div className="space-y-2">
            {operationalErrors.map((row) => (
              <OperationalErrorRow key={row.kind} row={row} recent={recentOperational} />
            ))}
          </div>
        </div>
      )}

      {/* Recent failures (automation + webhooks) */}
      <RecentErrorsSection recentAutomation={recentAutomation} recentWebhooks={recentWebhooks} />

      {/* Per-org error cards */}
      <div>
        <h3 className="mb-3 text-sm font-semibold text-ink">
          Per-Org Errors ({orgErrors.length} org{orgErrors.length !== 1 ? 's' : ''})
        </h3>
        {!isLoading && orgErrors.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-16 text-center">
            <Globe className="size-10 text-ink-faint" strokeWidth={1.5} />
            <div>
              <p className="text-sm text-ink-muted">No per-org failures in this period</p>
              <p className="mt-1 text-xs text-ink-faint">
                Automation, notification, and webhook errors will appear here.
              </p>
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {orgErrors.map((org) => (
            <OrgErrorCard
              key={org.orgId}
              org={org}
              onOpenOrg={(id) => {
                onOpenOrg?.(id);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
