import { useQuery } from '@tanstack/react-query';
import { workloadQuery } from './api.js';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/**
 * §3.5 — Workload: open cards per assignee.
 *
 * Renders no title of its own — `overview-panel.tsx`'s `DashboardCard`
 * supplies it now that the standalone Workload tab is gone.
 */
export function WorkloadPanel() {
  const { data, isLoading, error } = useQuery(workloadQuery());

  if (error) return <ErrorView error={error} />;
  if (isLoading) return <SkeletonRows rows={5} />;

  const entries = data ?? [];
  if (entries.length === 0) {
    return (
      <Empty
        title="No assigned cards"
        description="Assign cards to team members to see workload distribution."
      />
    );
  }

  const maxCount = Math.max(...entries.map((e) => e.cardCount), 1);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.userId} className="flex items-center gap-3">
            <div className="w-32 truncate text-xs text-ink/80" title={entry.email ?? entry.userId}>
              {entry.name ?? entry.email?.split('@')[0] ?? entry.userId.slice(0, 8) + '…'}
            </div>
            <div className="flex-1">
              <div
                className="h-4 rounded bg-accent/60"
                style={{ width: `${String((entry.cardCount / maxCount) * 100)}%` }}
              />
            </div>
            <div className="w-8 text-right text-xs font-medium text-ink">{entry.cardCount}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
