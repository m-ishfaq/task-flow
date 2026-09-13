import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { velocityQuery } from './api.js';
import { VelocityChart } from './velocity-chart.js';
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

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-semibold text-ink">Velocity</h2>
        <span className="text-xs text-ink-muted">
          {total} cards done in {days} days
        </span>
      </div>

      <VelocityChart points={points} />

      <div className="flex justify-between text-[10px] text-ink-faint">
        <span>{points[0]?.date}</span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
    </div>
  );
}
