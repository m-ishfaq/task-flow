import { useQuery } from '@tanstack/react-query';
import { statusQuery } from './api.js';
import { SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/** §6 — Status: staleness and rollup freshness. */
export function StatusPanel() {
  const { data, isLoading, error } = useQuery(statusQuery());

  if (error) return <ErrorView error={error} />;
  if (isLoading) return <SkeletonRows rows={4} />;

  const status = data ?? {
    totalTransitions: 0,
    lastIndexedAt: null,
    syntheticCount: 0,
    rollupLastRefreshedAt: null,
    rollupOrgCount: 0,
  };

  const formatDate = (d: string | Date | null) => {
    if (!d) return 'Never';
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatRelative = (d: string | Date | null) => {
    if (!d) return '';
    const date = typeof d === 'string' ? new Date(d) : d;
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 1) return 'Just now';
    if (diffHours < 24) return `${String(diffHours)}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${String(diffDays)}d ago`;
  };

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-ink">Analytics Status</h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <InfoCard
          label="Total Transitions"
          value={String(status.totalTransitions)}
          hint={`${String(status.syntheticCount)} synthetic (backfilled)`}
        />
        <InfoCard
          label="Last Indexed"
          value={formatDate(status.lastIndexedAt)}
          hint={formatRelative(status.lastIndexedAt)}
        />
        <InfoCard
          label="Rollup Last Refreshed"
          value={formatDate(status.rollupLastRefreshedAt)}
          hint={formatRelative(status.rollupLastRefreshedAt)}
        />
        <InfoCard
          label="Data Source"
          value="Rollup Tables"
          hint="Pre-computed aggregations refreshed by worker"
        />
      </div>
    </div>
  );
}

function InfoCard({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}) {
  return (
    <div className="rounded-lg border border-line/50 p-3">
      <div className="text-xs text-ink-faint">{label}</div>
      <div className="mt-1 text-sm font-medium text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-ink-faint">{hint}</div>}
    </div>
  );
}
