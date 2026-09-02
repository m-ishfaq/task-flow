import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { burndownQuery } from './api.js';
import { api } from '../../lib/trpc.js';
import { wire } from '@taskflow/client';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/** §3.2 — Burndown: remaining not-done work over time. */
export function BurndownPanel({ orgId }: { readonly orgId: string }) {
  const [days] = useState(30);
  const { start, end } = useMemo(() => {
    const e = new Date();
    const s = new Date();
    s.setDate(s.getDate() - days);
    return { start: s, end: e };
  }, [days]);

  // Get the first project to show burndown for.
  const projects = useQuery({
    queryKey: ['work', 'projects', orgId],
    queryFn: async () => wire(await api.work.projects.list.query({})),
  });

  const projectId = projects.data?.[0]?.projectId;

  const { data, isLoading, error } = useQuery({
    ...burndownQuery(projectId ?? '', start, end),
    enabled: projectId !== undefined,
  });

  if (projects.isLoading || isLoading) return <SkeletonRows rows={5} />;
  if (error) return <ErrorView error={error} />;

  if (!projectId) {
    return <Empty title="No projects" description="Create a project to see burndown data." />;
  }

  const points = data ?? [];
  if (points.length === 0) {
    return (
      <Empty
        title="No burndown data"
        description="Transitions will appear as cards move through statuses."
      />
    );
  }

  const maxRemaining = Math.max(...points.map((p) => p.remaining), 1);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-medium text-ink/80">Burndown</h2>
        <span className="text-xs text-ink/50">
          {points[0]?.remaining} → {points[points.length - 1]?.remaining} remaining
        </span>
      </div>

      {/* Simple line chart via SVG */}
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
