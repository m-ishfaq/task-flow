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
  // The project this chart is scoped to. Defaults to the first below; the
  // selector lets the reader switch so a sparse first project does not read as
  // "no data".
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);
  const { start, end } = useMemo(() => {
    const e = new Date();
    const s = new Date();
    s.setDate(s.getDate() - days);
    return { start: s, end: e };
  }, [days]);

  const projects = useQuery({
    queryKey: ['work', 'projects', orgId],
    queryFn: async () => wire(await api.work.projects.list.query({})),
  });

  const projectId = selectedProjectId ?? projects.data?.[0]?.projectId;
  const projectOptions = projects.data ?? [];

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
        {projectOptions.length > 1 && (
          <select
            value={projectId}
            onChange={(e) => {
              setSelectedProjectId(e.target.value);
            }}
            className="rounded border border-line/50 bg-surface px-2 py-1 text-xs text-ink"
          >
            {projectOptions.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.name}
              </option>
            ))}
          </select>
        )}
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
