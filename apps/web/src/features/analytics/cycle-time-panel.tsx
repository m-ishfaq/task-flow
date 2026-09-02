import { useQuery } from '@tanstack/react-query';
import { cycleTimeQuery } from './api.js';
import { SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/** §3.4 — Cycle Time: median and p85 time from active to done. */
export function CycleTimePanel({ orgId }: { readonly orgId: string }) {
  const { data, isLoading, error } = useQuery(cycleTimeQuery());

  if (error) return <ErrorView error={error} />;
  if (isLoading) return <SkeletonRows rows={3} />;

  const result = data ?? { medianHours: 0, p85Hours: 0, count: 0, openCount: 0 };

  const formatHours = (h: number) => {
    if (h < 24) return `${Math.round(h)}h`;
    const days = Math.floor(h / 24);
    const hours = Math.round(h % 24);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  };

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-ink/80">Cycle Time</h2>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Median" value={formatHours(result.medianHours)} />
        <StatCard label="P85" value={formatHours(result.p85Hours)} />
        <StatCard label="Completed" value={String(result.count)} />
        <StatCard label="Still Open" value={String(result.openCount)} />
      </div>

      {result.count === 0 && (
        <p className="text-xs text-ink/50">
          No completed cards with active→done transitions yet.
        </p>
      )}
    </div>
  );
}

function StatCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border border-line/50 p-3">
      <div className="text-xs text-ink/50">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
    </div>
  );
}
