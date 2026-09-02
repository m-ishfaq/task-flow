import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { velocityQuery } from './api.js';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/** §3.1 — Velocity: cards entering done per day. */
export function VelocityPanel() {
  const [days] = useState(30);
  const { start, end } = useMemo(() => {
    const e = new Date();
    const s = new Date();
    s.setDate(s.getDate() - days);
    return { start: s, end: e };
  }, [days]);

  const { data, isLoading, error } = useQuery(velocityQuery(start, end));

  if (error) return <ErrorView error={error} />;
  if (isLoading) return <SkeletonRows rows={5} />;

  const points = data ?? [];
  if (points.length === 0) {
    return (
      <Empty
        title="No velocity data"
        description="Transitions will appear as cards move through statuses."
      />
    );
  }

  const total = points.reduce((sum, p) => sum + p.count, 0);
  const maxCount = Math.max(...points.map((p) => p.count), 1);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-medium text-ink/80">Velocity</h2>
        <span className="text-xs text-ink/50">
          {total} cards done in {days} days
        </span>
      </div>

      {/* Simple bar chart */}
      <div className="flex items-end gap-px" style={{ height: 120 }}>
        {points.map((p) => (
          <div
            key={p.date}
            className="group relative flex-1"
            style={{ height: `${String((p.count / maxCount) * 100)}%` }}
          >
            <div className="h-full rounded-t bg-accent/60 transition-colors group-hover:bg-accent" />
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-ink/80 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
              {p.date}: {p.count}
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-between text-[10px] text-ink/40">
        <span>{points[0]?.date}</span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
    </div>
  );
}
