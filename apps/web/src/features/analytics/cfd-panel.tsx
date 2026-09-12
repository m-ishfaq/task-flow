import { useQuery, useQueries } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { cfdQuery } from './api.js';
import { api } from '../../lib/trpc.js';
import { wire } from '@taskflow/client';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

const CATEGORY_COLORS: Record<string, string> = {
  notStarted: 'rgb(156, 163, 175)', // gray
  active: 'rgb(59, 130, 246)', // blue
  done: 'rgb(34, 197, 94)', // green
};

const CATEGORY_LABELS: Record<string, string> = {
  notStarted: 'Not Started',
  active: 'Active',
  done: 'Done',
};

/**
 * §3.3 — Cumulative Flow Diagram: cards in each category per day.
 *
 * Renders no title of its own — `overview-panel.tsx`'s `DashboardCard`
 * supplies it now that the standalone Flow tab is gone.
 */
export function CfdPanel({ orgId }: { readonly orgId: string }) {
  const [days] = useState(30);
  // The board this chart is scoped to. Defaults to the first board below, but a
  // selector lets the reader switch — otherwise a sparse first board reads as
  // "no data" when other boards have plenty.
  const [selectedBoardId, setSelectedBoardId] = useState<string | undefined>(undefined);
  const { start, end } = useMemo(() => {
    const e = new Date();
    const s = new Date();
    s.setDate(s.getDate() - days);
    return { start: s, end: e };
  }, [days]);

  // boards.list requires a projectId (there is no org-wide board list), so
  // fetch all projects, then fan out one query per project and flatten.
  const projects = useQuery({
    queryKey: ['work', 'projects', orgId],
    queryFn: async () => wire(await api.work.projects.list.query({})),
  });
  const projectList = projects.data ?? [];

  const boardQueries = useQueries({
    queries: projectList.map((project) => ({
      queryKey: ['work', 'boards', orgId, project.projectId],
      queryFn: async () => wire(await api.work.boards.list.query({ projectId: project.projectId })),
    })),
  });
  const boardsLoading = boardQueries.some((q) => q.isLoading);

  const boardOptions = boardQueries.flatMap((q, index) => {
    const projectName = projectList[index]?.name ?? '';
    return (q.data ?? []).map((board) => ({
      boardId: board.boardId,
      // Prefix with project name so two boards named "Sprint 1" are distinguishable.
      label: projectList.length > 1 ? `${projectName} / ${board.name}` : board.name,
    }));
  });

  const boardId = selectedBoardId ?? boardOptions[0]?.boardId;

  const { data, isLoading, error } = useQuery({
    ...cfdQuery(boardId ?? '', start, end),
    enabled: boardId !== undefined,
  });

  if (projects.isLoading || boardsLoading || isLoading) return <SkeletonRows rows={5} />;
  if (error) return <ErrorView error={error} />;

  if (!boardId) {
    return <Empty title="No boards" description="Create a board to see flow data." />;
  }

  const points = data ?? [];
  if (points.length === 0) {
    return (
      <Empty
        title="No flow data"
        description="Transitions will appear as cards move through statuses."
      />
    );
  }

  const maxTotal = Math.max(...points.map((p) => p.notStarted + p.active + p.done), 1);

  // Build stacked area points for SVG
  const width = points.length * 8;
  const height = 120;

  const toY = (count: number) => height - (count / maxTotal) * height;

  // Stacked: done on bottom, active in middle, notStarted on top
  const donePath = points.map((p, i) => `${String(i * 8 + 4)},${String(toY(p.done))}`).join(' ');
  const activePath = points
    .map((p, i) => `${String(i * 8 + 4)},${String(toY(p.done + p.active))}`)
    .join(' ');
  const notStartedPath = points
    .map((p, i) => `${String(i * 8 + 4)},${String(toY(p.done + p.active + p.notStarted))}`)
    .join(' ');

  return (
    <div className="space-y-4">
      {boardOptions.length > 1 && (
        <select
          value={boardId}
          onChange={(e) => {
            setSelectedBoardId(e.target.value);
          }}
          className="rounded-md border border-line/50 bg-surface px-2 py-1 text-xs text-ink"
        >
          {boardOptions.map((board) => (
            <option key={board.boardId} value={board.boardId}>
              {board.label}
            </option>
          ))}
        </select>
      )}

      {/* Stacked area chart */}
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        className="w-full"
        style={{ height: 120 }}
        preserveAspectRatio="none"
      >
        <polyline fill="none" stroke={CATEGORY_COLORS['done']} strokeWidth="1" points={donePath} />
        <polyline
          fill="none"
          stroke={CATEGORY_COLORS['active']}
          strokeWidth="1"
          points={activePath}
        />
        <polyline
          fill="none"
          stroke={CATEGORY_COLORS['notStarted']}
          strokeWidth="1"
          points={notStartedPath}
        />
      </svg>

      {/* Legend */}
      <div className="flex gap-4 text-xs text-ink/60">
        {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
          <div key={key} className="flex items-center gap-1.5">
            <div
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: CATEGORY_COLORS[key] }}
            />
            <span>{label}</span>
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
