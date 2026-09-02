import { useQuery } from '@tanstack/react-query';
import { workloadQuery } from './api.js';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/** §3.5 — Workload: open cards per assignee. */
export function WorkloadPanel({ orgId }: { readonly orgId: string }) {
  const { data, isLoading, error } = useQuery(workloadQuery());

  if (error) return <ErrorView error={error} />;
  if (isLoading) return <SkeletonRows rows={5} />;

  const entries = data ?? [];
  if (entries.length === 0) {
    return <Empty title="No assigned cards" description="Assign cards to team members to see workload distribution." />;
  }

  const maxCount = Math.max(...entries.map((e) => e.cardCount), 1);

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-ink/80">Workload</h2>

      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.userId} className="flex items-center gap-3">
            <div className="w-24 truncate text-xs text-ink/60" title={entry.userId}>
              {entry.userId.slice(0, 8)}…
            </div>
            <div className="flex-1">
              <div
                className="h-4 rounded bg-accent/60"
                style={{ width: `${(entry.cardCount / maxCount) * 100}%` }}
              />
            </div>
            <div className="w-8 text-right text-xs font-medium text-ink">
              {entry.cardCount}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
