import { useQuery, useQueries } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { cfdQuery, type CfdPoint } from './api.js';
import { api } from '../../lib/trpc.js';
import { wire } from '@taskflow/client';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/**
 * The three states a CFD stacks, bottom to top — the order a real
 * cumulative-flow diagram always reads in (finished work anchors the
 * bottom, unstarted work is the top band still to come). Colors are this
 * app's own status tokens, not an ad hoc palette: `--color-success` is
 * already what `burndown-panel.tsx`'s own "actual" line uses for exactly
 * "done," and reusing it here (rather than a disconnected literal
 * `rgb(34, 197, 94)`, what this file used before) is what makes a CFD next
 * to a burndown chart read as the same product's own status language
 * rather than two different generic-chart-library defaults pasted in side
 * by side. `active` reuses `--color-accent` — the same "this is the thing
 * in motion right now" tint the sidebar's own active-row treatment already
 * carries — and `notStarted` is `--color-ink-faint`, a neutral rather than
 * a third saturated hue: unstarted work is not a STATE worth its own
 * alarm color, it is the absence of progress yet.
 */
const CATEGORIES = [
  { key: 'done', label: 'Done', color: 'var(--color-success)' },
  { key: 'active', label: 'Active', color: 'var(--color-accent)' },
  { key: 'notStarted', label: 'Not started', color: 'var(--color-ink-faint)' },
] as const satisfies readonly {
  key: keyof Pick<CfdPoint, 'done' | 'active' | 'notStarted'>;
  label: string;
  color: string;
}[];

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
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
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

  const width = points.length * 8;
  const height = 120;
  const step = 8;

  const toY = (count: number) => height - (count / maxTotal) * height;

  /* Cumulative Y per point, bottom band first — the three lines a stacked
     area is actually built from. `total` doubles as the top boundary of
     the whole stack (the "not started" band's own upper edge) and the
     value the hover tooltip reads its per-day breakdown from. */
  const rows = points.map((p, i) => {
    const x = i * step + step / 2;
    const doneTop = toY(p.done);
    const activeTop = toY(p.done + p.active);
    const total = toY(p.done + p.active + p.notStarted);
    return { point: p, x, doneTop, activeTop, total };
  });

  /* Each band is a closed polygon: its own cumulative line across the top,
     the line below it (or the chart floor, for the bottom band) reversed
     back across the bottom — the actual filled shape a stacked area chart
     is, replacing three bare, unfilled polylines that only ever traced the
     band BOUNDARIES with nothing rendered between them. */
  const donePath = `M${rows.map((r) => `${String(r.x)},${String(r.doneTop)}`).join(' L')} L${rows
    .slice()
    .reverse()
    .map((r) => `${String(r.x)},${String(height)}`)
    .join(' L')} Z`;
  const activePath = `M${rows.map((r) => `${String(r.x)},${String(r.activeTop)}`).join(' L')} L${rows
    .slice()
    .reverse()
    .map((r) => `${String(r.x)},${String(r.doneTop)}`)
    .join(' L')} Z`;
  const notStartedPath = `M${rows.map((r) => `${String(r.x)},${String(r.total)}`).join(' L')} L${rows
    .slice()
    .reverse()
    .map((r) => `${String(r.x)},${String(r.activeTop)}`)
    .join(' L')} Z`;

  const doneLine = rows.map((r) => `${String(r.x)},${String(r.doneTop)}`).join(' ');
  const activeLine = rows.map((r) => `${String(r.x)},${String(r.activeTop)}`).join(' ');

  const hovered = hoverIndex === null ? undefined : rows[hoverIndex];
  const hoverLeftPercent =
    hovered === undefined ? 0 : Math.min(96, Math.max(4, (hovered.x / width) * 100));

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

      {/* `relative` so the hover tooltip below can anchor to this exact
          box rather than the page — the same "a percentage of the SVG's
          own rendered width" positioning `velocity-chart.tsx` has no need
          for (its hover is a native `<title>`) but a real tooltip does. */}
      <div className="relative">
        <svg
          viewBox={`0 0 ${String(width)} ${String(height)}`}
          className="w-full"
          style={{ height: 120 }}
          preserveAspectRatio="none"
        >
          <line x1={0} y1={height / 4} x2={width} y2={height / 4} stroke="var(--color-line)" />
          <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="var(--color-line)" />
          <line
            x1={0}
            y1={(height * 3) / 4}
            x2={width}
            y2={(height * 3) / 4}
            stroke="var(--color-line)"
          />

          <path d={donePath} fill={CATEGORIES[0].color} fillOpacity="0.55" />
          <path d={activePath} fill={CATEGORIES[1].color} fillOpacity="0.4" />
          <path d={notStartedPath} fill={CATEGORIES[2].color} fillOpacity="0.25" />

          {/* A thin surface-colored seam at each band boundary — the "2px
              surface gap between fills" mark spec every stacked chart in
              this app's own dataviz conventions is held to, so adjacent
              bands read as distinct segments rather than one bleeding into
              the next. */}
          <polyline fill="none" stroke="var(--color-surface)" strokeWidth="1.5" points={doneLine} />
          <polyline
            fill="none"
            stroke="var(--color-surface)"
            strokeWidth="1.5"
            points={activeLine}
          />

          {hovered !== undefined && (
            <line
              x1={hovered.x}
              y1={0}
              x2={hovered.x}
              y2={height}
              stroke="var(--color-ink-faint)"
              strokeWidth="1"
              strokeDasharray="2 3"
            />
          )}

          {/* One invisible hit target per day, wider than the ~8-unit data
              step so a hover doesn't require pixel-perfect aim — the
              crosshair+tooltip pair the dataviz skill's own interaction
              guidance asks for on every line/area chart, replacing what
              this chart had none of before. */}
          {rows.map((r, i) => (
            <rect
              key={r.point.date}
              x={i * step}
              y={0}
              width={step}
              height={height}
              fill="transparent"
              onMouseEnter={() => {
                setHoverIndex(i);
              }}
              onMouseLeave={() => {
                setHoverIndex((current) => (current === i ? null : current));
              }}
            />
          ))}
        </svg>

        {hovered !== undefined && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-xs shadow-lg"
            style={{ left: `${String(hoverLeftPercent)}%` }}
          >
            <p className="mb-1 font-medium text-ink">{hovered.point.date}</p>
            {CATEGORIES.map(({ key, label, color }) => (
              <div key={key} className="flex items-center gap-1.5 whitespace-nowrap">
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="text-ink-muted">{label}</span>
                <span className="ml-auto font-mono tabular-nums text-ink">
                  {hovered.point[key]}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex gap-4 text-xs text-ink-muted">
        {CATEGORIES.map(({ key, label, color }) => (
          <div key={key} className="flex items-center gap-1.5">
            <div
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span>{label}</span>
          </div>
        ))}
      </div>

      <div className="flex justify-between text-[10px] text-ink-faint">
        <span>{points[0]?.date}</span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
    </div>
  );
}
