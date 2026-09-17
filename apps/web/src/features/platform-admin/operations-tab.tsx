import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, Layers, Search, XCircle, Zap } from 'lucide-react';
import { StatusPill } from '@taskflow/ui';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDateTime } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { SkeletonRows, TabBar } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { Pagination, StepUpGate, StatCard, TableSearch } from './shared.js';

/* -------------------------------------------------------------------------- *
 * Operations dashboard — "did a system action succeed or fail" (mail
 * delivery, a billing webhook, the billing sweep's heartbeat), the different
 * question from the operator audit tab, which answers "what did a
 * human operator do". Read-only in this wave — no retry action yet.
 * -------------------------------------------------------------------------- */

type OperationalEventKind = 'mail' | 'billing_webhook' | 'billing_sweep' | 'push';

const KIND_META: Record<string, { readonly label: string; readonly color: string }> = {
  mail: { label: 'Mail', color: 'text-sky-600 bg-sky-500/10' },
  billing_webhook: { label: 'Billing webhook', color: 'text-amber-600 bg-amber-500/10' },
  billing_sweep: { label: 'Billing sweep', color: 'text-violet-600 bg-violet-500/10' },
  push: { label: 'Push', color: 'text-emerald-600 bg-emerald-500/10' },
};

const OPERATIONAL_EVENT_KINDS: readonly {
  readonly value: OperationalEventKind | null;
  readonly label: string;
}[] = [
  { value: null, label: 'All' },
  { value: 'mail', label: 'Mail' },
  { value: 'billing_webhook', label: 'Billing webhook' },
  { value: 'billing_sweep', label: 'Billing sweep' },
  { value: 'push', label: 'Push' },
];

/** Human-readable labels for detail object keys. */
const DETAIL_KEY_LABELS: Record<string, string> = {
  gracesExpired: 'Graces expired',
  periodsClosed: 'Periods closed',
  trialsExpired: 'Trials expired',
  recipientCount: 'Recipients',
  deliveryCount: 'Delivered',
  failedCount: 'Failed',
  skippedCount: 'Skipped',
  reason: 'Reason',
  error: 'Error',
  pathway: 'Pathway',
  statusCode: 'Status',
};

function DetailBlock({ detail }: { readonly detail: unknown }) {
  if (detail === null || detail === undefined) return null;
  if (typeof detail === 'string') {
    return <p className="text-[11px] text-ink-muted">{detail}</p>;
  }
  if (typeof detail === 'object') {
    const entries = Object.entries(detail as Record<string, unknown>);
    if (entries.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
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
    <pre className="max-h-20 overflow-auto rounded bg-canvas-subtle p-2 text-[11px] text-ink-muted">
      {JSON.stringify(detail, null, 2)}
    </pre>
  );
}

function KindBadge({ kind }: { readonly kind: string }) {
  const meta = KIND_META[kind];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
        meta?.color ?? 'bg-surface-hover text-ink',
      )}
    >
      {meta?.label ?? kind}
    </span>
  );
}

export function OperationsTab({ onStepUp }: { readonly onStepUp: () => void }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [kind, setKind] = useState<OperationalEventKind | null>(null);
  const [search, setSearch] = useState('');

  const events = useQuery({
    queryKey: keys.platformOperations(cursor, kind),
    queryFn: async () =>
      wire(await api.platformAdmin.operations.list.query({ cursor, limit: 25, kind })),
  });

  if (errorCodeOf(events.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const summary = events.data?.summary;
  const filteredEvents = events.data?.events.filter((event) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return (
      event.kind.toLowerCase().includes(q) ||
      event.outcome.toLowerCase().includes(q) ||
      event.target?.toLowerCase().includes(q) === true
    );
  });

  /* Build kind counts for tab labels — use summary.byKind which covers
     the full dataset (not just the current page). */
  const kindCounts = new Map<string, number>();
  if (summary !== undefined) {
    for (const entry of summary.byKind) {
      kindCounts.set(entry.kind, entry.count);
    }
  }

  const kindTabItems = OPERATIONAL_EVENT_KINDS.map((item) => {
    if (item.value === null) {
      return { value: item.value, label: item.label };
    }
    const count = kindCounts.get(item.value) ?? 0;
    return { value: item.value, label: `${item.label} (${String(count)})` };
  });

  return (
    <section aria-label="Operations" className="flex flex-col gap-5">
      {/* Summary stat cards */}
      {summary !== undefined && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={Layers} label="Total events" value={summary.totalEvents} />
          <StatCard
            icon={CheckCircle2}
            label="Success rate"
            value={
              summary.totalEvents === 0
                ? '—'
                : `${String(Math.round((summary.successCount / summary.totalEvents) * 100))}%`
            }
            accent={summary.failureCount === 0 && summary.totalEvents > 0}
          />
          <StatCard
            icon={XCircle}
            label="Failures"
            value={summary.failureCount}
            accent={summary.failureCount > 0}
          />
          <StatCard icon={Clock} label="Kinds" value={summary.byKind.length} />
        </div>
      )}

      {/* Failure banner */}
      {summary !== undefined && summary.failureCount > 0 && (
        <div className="flex items-center gap-3 rounded-xl bg-red-500/6 px-4 py-3">
          <XCircle className="size-4 shrink-0 text-red-500" strokeWidth={2} />
          <p className="text-[13px] text-red-600">
            {summary.failureCount} failure{summary.failureCount === 1 ? '' : 's'} recorded across{' '}
            {summary.totalEvents} event{summary.totalEvents === 1 ? '' : 's'}.
          </p>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TabBar
          ariaLabel="Filter by kind"
          size="xs"
          value={kind}
          onChange={(value) => {
            setKind(value);
            setCursor(null);
          }}
          items={kindTabItems}
        />
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter events…"
          className="sm:w-48"
        />
      </div>

      {events.isPending && <SkeletonRows rows={5} className="mt-3 *:h-12" />}
      {events.isError && <ErrorView error={events.error} title="Could not load operations" />}

      {events.data !== undefined &&
        (events.data.events.length === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-2 py-8">
            <Zap className="size-8 text-ink-faint" strokeWidth={1.5} />
            <p className="text-sm font-medium text-ink">Nothing recorded yet</p>
            <p className="max-w-xs text-center text-xs text-ink-faint">
              Operational events will appear here as system actions occur — mail delivery, billing
              webhooks, and sweep heartbeats.
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-sunken/60">
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      When
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Kind
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Outcome
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Target
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Detail
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/50">
                  {(filteredEvents ?? []).map((event) => (
                    <tr
                      key={event.id}
                      className={cn(
                        'border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50',
                        event.outcome !== 'success' && 'bg-red-500/3',
                      )}
                    >
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                        {formatDateTime(event.occurredAt)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <KindBadge kind={event.kind} />
                      </td>
                      <td className="px-3 py-2.5">
                        <OutcomeBadge outcome={event.outcome} />
                      </td>
                      <td className="max-w-50 overflow-x-auto px-3 py-2.5 whitespace-nowrap font-mono text-[11px] text-ink-muted">
                        {event.target ?? '—'}
                      </td>
                      <td className="max-w-50 overflow-x-auto px-3 py-2.5 whitespace-nowrap">
                        <DetailBlock detail={event.detail} />
                      </td>
                    </tr>
                  ))}
                  {(filteredEvents ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-12 text-center">
                        <div className="flex flex-col items-center gap-2">
                          <Search className="size-5 text-ink-faint" strokeWidth={1.5} />
                          <p className="text-sm text-ink-faint">No events match your search.</p>
                          <p className="text-xs text-ink-faint">
                            Try a different kind, outcome, or target.
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div>
              <Pagination
                hasMore={cursor !== null || (events.data.nextCursor ?? null) !== null}
                onNewest={() => {
                  setCursor(null);
                }}
                onOlder={() => {
                  setCursor(events.data.nextCursor);
                }}
              />
            </div>
          </>
        ))}
    </section>
  );
}

function OutcomeBadge({ outcome }: { readonly outcome: string }) {
  if (outcome === 'success') {
    return <StatusPill tone="success">success</StatusPill>;
  }
  return <StatusPill tone="danger">failure</StatusPill>;
}
