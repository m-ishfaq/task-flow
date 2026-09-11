import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3 } from 'lucide-react';
import type { ProjectId } from '@taskflow/contracts';
import { cn } from '../../lib/cn.js';
import { Empty, Segmented, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { projectsQuery, sprintsQuery, type Sprint } from '../work/api.js';
import { burndownQuery, cycleTimeQuery, velocityQuery } from './api.js';
import { VelocityChart } from './velocity-chart.js';
import { BurndownPanel } from './burndown-panel.js';
import { WorkloadPanel } from './workload-panel.js';

/**
 * Analytics overview (Design Bible §10 — prompted directly with a fresh
 * screenshot of the mockup: "this is the analytics page lets start this").
 *
 * The mockup shows one page, not seven tabs: a "Velocity & flow" hero card
 * (a 4-tile KPI row, a Sprint/Quarter toggle, and the area-fill velocity
 * chart) over a two-column row of Burndown and Workload. This is that page,
 * added as a new, DEFAULT first tab — additive, not a replacement. The
 * existing seven dashboards (Velocity, Burndown, Flow, Cycle Time, Workload,
 * Volume, Status) stay reachable exactly as they were for anyone who wants
 * one metric's own full-width view; this is the landing summary that used
 * to not exist at all.
 *
 * ## "Points completed per sprint" — an honest relabelling
 *
 * The mockup's own eyebrow reads "VELOCITY — POINTS COMPLETED PER SPRINT"
 * and its first KPI tile "42". This codebase has no story-point or estimate
 * field anywhere in `work.cards` — checked directly, not assumed — so a
 * literal "points" reading would be a number this product cannot actually
 * produce. Every count here is real: a CARD count, not a point count, and
 * every label below says so plainly ("cards done per day", "This sprint" as
 * a card count) rather than borrowing the mockup's own vocabulary for a
 * concept that does not exist in this codebase's data model.
 *
 * ## Where each tile's number actually comes from
 *
 * The velocity CHART stays org-wide (unchanged from the standalone Velocity
 * tab) — a broader throughput trend, not scoped to one project's sprint.
 * The KPI row is deliberately narrower and more precise: sourced from the
 * SAME sprint-mode burndown query the Burndown card below already uses
 * (`queryBurndown`'s sprint mode filters to cards that were actually IN the
 * sprint via `card_transitions`, the semantically correct source — unlike
 * the org-wide velocity endpoint, which has no project or sprint filter at
 * all and would double-count another project's cards completed on the same
 * calendar days). "This sprint" and "Completed" are both derived from the
 * SAME burndown series already being fetched for the chart below, not a
 * second query — `first.remaining - last.remaining` is exactly the count of
 * cards that left "remaining" since the sprint's own tracked start. "Cycle
 * time" is the existing `cycleTimeQuery`'s median, in days. The "▲/▼" delta
 * on "This sprint" compares against the most recently COMPLETED sprint's
 * own identical calculation — a second burndown query, only fired when a
 * previous sprint actually exists — and is omitted entirely rather than
 * showing a fabricated 0% when there is nothing real to compare against.
 *
 * ## No active sprint
 *
 * A project with no active sprint has nothing sprint-scoped to show: the
 * KPI row reads "—" throughout and the Sprint/Quarter toggle only offers
 * Quarter — there is no sprint window to switch INTO.
 */

type Window = 'sprint' | 'quarter';

const QUARTER_DAYS = 90;

function mostRecentlyCompleted(sprints: readonly Sprint[]): Sprint | undefined {
  return sprints
    .filter((sprint) => sprint.status === 'completed')
    .toSorted((a, b) => (a.endsOn < b.endsOn ? 1 : -1))[0];
}

export function OverviewPanel({ orgId }: { readonly orgId: string }) {
  const [windowMode, setWindowMode] = useState<Window>('sprint');

  const projects = useQuery(projectsQuery(orgId));
  const projectId = projects.data?.[0]?.projectId;

  const sprints = useQuery({
    ...sprintsQuery(orgId, (projectId ?? '') as ProjectId),
    enabled: projectId !== undefined,
  });

  const activeSprint = sprints.data?.find((sprint) => sprint.status === 'active');
  const previousSprint =
    sprints.data === undefined ? undefined : mostRecentlyCompleted(sprints.data);

  // Only ever 'quarter' with no active sprint — there is no sprint window
  // to show, so the toggle offers nothing else.
  const effectiveWindow: Window = activeSprint === undefined ? 'quarter' : windowMode;

  const today = new Date();
  const { chartStart, chartEnd } =
    effectiveWindow === 'sprint' && activeSprint !== undefined
      ? { chartStart: new Date(activeSprint.startsOn), chartEnd: today }
      : {
          chartStart: new Date(today.getTime() - QUARTER_DAYS * 86_400_000),
          chartEnd: today,
        };

  const velocity = useQuery(velocityQuery(chartStart, chartEnd));

  const currentBurndown = useQuery({
    ...burndownQuery(
      projectId ?? '',
      activeSprint === undefined ? today : new Date(activeSprint.startsOn),
      activeSprint === undefined ? today : new Date(activeSprint.endsOn),
      activeSprint?.sprintId,
    ),
    enabled: projectId !== undefined && activeSprint !== undefined,
  });

  const previousBurndown = useQuery({
    ...burndownQuery(
      projectId ?? '',
      previousSprint === undefined ? today : new Date(previousSprint.startsOn),
      previousSprint === undefined ? today : new Date(previousSprint.endsOn),
      previousSprint?.sprintId,
    ),
    enabled: projectId !== undefined && previousSprint !== undefined,
  });

  const cycleTime = useQuery({
    ...cycleTimeQuery(projectId),
    enabled: projectId !== undefined,
  });

  const currentPoints = currentBurndown.data ?? [];
  const currentFirst = currentPoints[0];
  const currentLast = currentPoints[currentPoints.length - 1];
  const completedThisSprint =
    currentFirst !== undefined && currentLast !== undefined
      ? currentFirst.remaining - currentLast.remaining
      : undefined;

  const previousPoints = previousBurndown.data ?? [];
  const previousFirst = previousPoints[0];
  const previousLast = previousPoints[previousPoints.length - 1];
  const completedPreviousSprint =
    previousFirst !== undefined && previousLast !== undefined
      ? previousFirst.remaining - previousLast.remaining
      : undefined;

  const deltaPercent =
    completedThisSprint !== undefined &&
    completedPreviousSprint !== undefined &&
    completedPreviousSprint > 0
      ? Math.round(
          ((completedThisSprint - completedPreviousSprint) / completedPreviousSprint) * 100,
        )
      : undefined;

  const completedPercent =
    completedThisSprint !== undefined && currentFirst !== undefined && currentFirst.remaining > 0
      ? Math.round((completedThisSprint / currentFirst.remaining) * 100)
      : undefined;

  const cycleDays =
    cycleTime.data !== undefined && cycleTime.data.count > 0
      ? cycleTime.data.medianHours / 24
      : undefined;

  const kpiLoading =
    projects.isPending ||
    sprints.isPending ||
    (activeSprint !== undefined && currentBurndown.isPending);
  const velocityPoints = velocity.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <section className="rounded-xl border border-line bg-surface-raised p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <BarChart3 aria-hidden="true" className="size-4 text-accent" strokeWidth={2.25} />
            <h2 className="text-sm font-semibold text-ink">Velocity &amp; flow</h2>
          </div>
          {activeSprint !== undefined && (
            <Segmented
              value={effectiveWindow}
              onChange={setWindowMode}
              options={[
                { value: 'sprint', label: 'Sprint' },
                { value: 'quarter', label: 'Quarter' },
              ]}
              aria-label="Time window"
            />
          )}
        </div>

        <p className="mt-3 text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
          Velocity — cards done per day
        </p>

        <div className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KpiTile
            label="This sprint"
            value={kpiLoading ? '…' : (completedThisSprint?.toString() ?? '—')}
            delta={deltaPercent}
          />
          <KpiTile
            label="Cycle time"
            value={
              cycleTime.isPending ? '…' : cycleDays === undefined ? '—' : `${cycleDays.toFixed(1)}d`
            }
          />
          <KpiTile
            label="Remaining"
            value={kpiLoading ? '…' : (currentLast?.remaining.toString() ?? '—')}
          />
          <KpiTile
            label="Completed"
            value={
              kpiLoading
                ? '…'
                : completedPercent === undefined
                  ? '—'
                  : `${String(completedPercent)}%`
            }
          />
        </div>

        <div className="mt-4">
          {velocity.isPending ? (
            <SkeletonRows rows={3} />
          ) : velocity.isError ? (
            <ErrorView error={velocity.error} title="Could not load velocity" />
          ) : velocityPoints.length === 0 ? (
            <Empty
              title="No velocity data"
              description="Transitions will appear as cards move through statuses."
            />
          ) : (
            <VelocityChart points={velocityPoints} />
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface-raised p-4">
          <BurndownPanel orgId={orgId} />
        </div>
        <div className="rounded-xl border border-line bg-surface-raised p-4">
          <WorkloadPanel />
        </div>
      </div>
    </div>
  );
}

function KpiTile({
  label,
  value,
  delta,
}: {
  readonly label: string;
  readonly value: string;
  readonly delta?: number | undefined;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className="text-2xl font-bold text-ink">{value}</span>
        {delta !== undefined && (
          <span className={cn('text-xs font-medium', delta >= 0 ? 'text-success' : 'text-danger')}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
          </span>
        )}
      </div>
      <span className="text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
        {label}
      </span>
    </div>
  );
}
