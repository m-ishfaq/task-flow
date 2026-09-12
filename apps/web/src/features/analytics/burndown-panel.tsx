import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { burndownQuery } from './api.js';
import { api } from '../../lib/trpc.js';
import { wire } from '@taskflow/client';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/**
 * §3.2 — Burndown: remaining not-done work over time.
 *
 * Renders no title of its own — the consolidated Analytics dashboard
 * (`overview-panel.tsx`'s `DashboardCard`) supplies the icon+heading for
 * every secondary panel now that this is the only place `BurndownPanel`
 * mounts (the standalone per-metric tab it used to sit behind is gone).
 */
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
        {projectOptions.length > 1 && (
          <select
            value={projectId}
            onChange={(e) => {
              setSelectedProjectId(e.target.value);
            }}
            className="rounded-md border border-line/50 bg-surface px-2 py-1 text-xs text-ink"
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

      {/* Design Bible §10's own burndown treatment: a dashed IDEAL line —
          a straight burn from the window's starting remaining count down to
          zero by its end, computed here rather than fetched, since it is a
          pure function of the two numbers the chart already has and needs
          no server round trip of its own — behind a solid ACTUAL line with
          rounded joins and an emphasized dot at its own last point. No area
          fill here, unlike Velocity's own chart: the bible's own SVG for
          this one has none either, and a downward-trending fill would read
          as "remaining work," which is already what the line itself shows. */}
      <svg
        viewBox={`0 0 ${String(points.length * 8)} 120`}
        className="w-full"
        style={{ height: 120 }}
        preserveAspectRatio="none"
      >
        {(() => {
          const width = points.length * 8;
          const yFor = (remaining: number) => 120 - (remaining / maxRemaining) * 110;
          const coords = points.map((p, i) => ({ x: i * 8 + 4, y: yFor(p.remaining) }));
          const last = coords[coords.length - 1];
          const first = points[0];
          if (last === undefined || first === undefined) return null;

          return (
            <>
              <line
                x1={4}
                y1={yFor(first.remaining)}
                x2={width - 4}
                y2={yFor(0)}
                stroke="var(--color-line-strong)"
                strokeDasharray="4 5"
              />
              <polyline
                fill="none"
                stroke="var(--color-success)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={coords.map((c) => `${String(c.x)},${String(c.y)}`).join(' ')}
              />
              <circle cx={last.x} cy={last.y} r={4} fill="var(--color-success)" />
            </>
          );
        })()}
      </svg>

      <div className="flex justify-between text-[10px] text-ink/40">
        <span>{points[0]?.date}</span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
    </div>
  );
}
