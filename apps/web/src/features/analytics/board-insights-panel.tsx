import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { velocityQuery, burndownQuery } from './api.js';
import { api } from '../../lib/trpc.js';
import { wire } from '@taskflow/client';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/**
 * Board-scoped insights (ai/phase-11-analytics.md §4).
 *
 * Shown as a view option inside the board page — velocity and burndown
 * scoped to this board's sprint. The org-wide /analytics page covers all
 * boards; this is the per-board slice.
 */
export function BoardInsightsPanel({
  orgId,
  boardId,
}: {
  readonly orgId: string;
  readonly boardId: string;
}) {
  const [days] = useState(30);
  const { start, end } = useMemo(() => {
    const e = new Date();
    const s = new Date();
    s.setDate(s.getDate() - days);
    return { start: s, end: e };
  }, [days]);

  const velocity = useQuery(velocityQuery(start, end, boardId));

  // For burndown, we need the project — get it from the board's first card.
  const cards = useQuery({
    queryKey: ['work', 'cards', orgId, boardId, 'insights'],
    queryFn: async () =>
      wire(
        await api.work.cards.list.query({
          boardId,
        }),
      ),
  });

  const projectId = cards.data?.[0]?.projectId;

  const burndown = useQuery({
    ...burndownQuery(projectId ?? '', start, end),
    enabled: projectId !== undefined,
  });

  if (velocity.isLoading || burndown.isLoading) {
    return <SkeletonRows rows={5} />;
  }

  if (velocity.error) return <ErrorView error={velocity.error} />;
  if (burndown.error) return <ErrorView error={burndown.error} />;

  const velocityPoints = velocity.data ?? [];
  const burndownPoints = burndown.data ?? [];

  if (velocityPoints.length === 0 && burndownPoints.length === 0) {
    return (
      <Empty
        title="No analytics data yet"
        description="Move cards through statuses to generate velocity and burndown data for this board."
      />
    );
  }

  return (
    <div className="space-y-6 p-4">
      {/* Velocity chart */}
      {velocityPoints.length > 0 && <VelocityChart points={velocityPoints} days={days} />}

      {/* Burndown chart */}
      {burndownPoints.length > 0 && <BurndownChart points={burndownPoints} />}
    </div>
  );
}

function VelocityChart({
  points,
  days,
}: {
  readonly points: readonly { readonly date: string; readonly count: number }[];
  readonly days: number;
}) {
  const total = points.reduce((sum, p) => sum + p.count, 0);
  const maxCount = Math.max(...points.map((p) => p.count), 1);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <h3 className="text-sm font-medium text-ink/80">Velocity</h3>
        <span className="text-xs text-ink/50">
          {total} cards done in {days} days
        </span>
      </div>

      <div className="flex items-end gap-px" style={{ height: 120 }}>
        {points.map((p) => (
          <div
            key={p.date}
            className="group relative flex-1"
            style={{ height: `${String((p.count / maxCount) * 100)}%` }}
          >
            <div className="h-full rounded-t bg-accent/60 transition-colors group-hover:bg-accent" />
            <div className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink/80 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
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

function BurndownChart({
  points,
}: {
  readonly points: readonly { readonly date: string; readonly remaining: number }[];
}) {
  const maxRemaining = Math.max(...points.map((p) => p.remaining), 1);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <h3 className="text-sm font-medium text-ink/80">Burndown</h3>
        <span className="text-xs text-ink/50">
          {points[0]?.remaining} → {points[points.length - 1]?.remaining} remaining
        </span>
      </div>

      <svg
        viewBox={`0 0 ${String(points.length * 8)} 120`}
        className="w-full"
        style={{ height: 120 }}
        preserveAspectRatio="none"
      >
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-accent"
          points={points
            .map(
              (p, i) => `${String(i * 8 + 4)},${String(120 - (p.remaining / maxRemaining) * 110)}`,
            )
            .join(' ')}
        />
      </svg>

      <div className="flex justify-between text-[10px] text-ink/40">
        <span>{points[0]?.date}</span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
    </div>
  );
}
