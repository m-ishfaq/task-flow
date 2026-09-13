import { type ReactNode, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, BarChart3, Clock, Layers, RefreshCw, TrendingDown, Users } from 'lucide-react';
import type { ProjectId } from '@taskflow/contracts';
import { cn } from '../../lib/cn.js';
import { formatRelative } from '../../lib/format.js';
import { Empty, Segmented, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { projectsQuery, sprintsQuery, type Sprint } from '../work/api.js';
import { burndownQuery, cycleTimeQuery, statusQuery, velocityQuery } from './api.js';
import { VelocityChart } from './velocity-chart.js';
import { BurndownPanel } from './burndown-panel.js';
import { CfdPanel } from './cfd-panel.js';
import { CycleTimePanel } from './cycle-time-panel.js';
import { WorkloadPanel } from './workload-panel.js';
import { VolumePanel } from './volume-panel.js';

/**
 * Analytics: one consolidated dashboard (Design Bible §10).
 *
 * REDESIGNED after shipping — the first version (a "Velocity & flow" hero
 * plus Burndown/Workload) was itself additive: a new default tab sitting
 * ahead of seven other, still-separate per-metric tabs. Reported back
 * directly against a screenshot of that result: check whether the bible
 * means for every metric to live on ONE screen, and if so build that,
 * properly — not the fragmented multi-tab shape this page had instead.
 *
 * It does. There is no tab strip anymore — `analytics-page.tsx` renders
 * this component directly, and every one of the seven dashboards that used
 * to sit behind its own tab (Velocity, Burndown, Flow, Cycle Time,
 * Workload, Volume, Status) is a section on this one page. Nothing was
 * deleted: every panel component below is the same one the old tabs
 * rendered, each still doing its own real query and its own project/board
 * picker where it needs one — only the navigation around them changed.
 *
 * ## Card chrome, not tabs
 *
 * `DashboardCard` is the one shared shell every secondary section uses — an
 * icon, a title, and the panel's own content beneath, all inside the same
 * bordered `rounded-xl` card the hero section already established. Panels
 * that used to render their own bare `<h2>` (Burndown, Flow, Workload,
 * Cycle Time, Volume) had that heading stripped out — see each file's own
 * updated header comment — since a title now belongs to the card wrapping
 * it, never printed twice.
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
 * ## Where each hero tile's number actually comes from
 *
 * The velocity CHART stays org-wide — a broader throughput trend, not
 * scoped to one project's sprint. The KPI row is deliberately narrower and
 * more precise: sourced from the SAME sprint-mode burndown query the
 * Burndown card below already uses (`queryBurndown`'s sprint mode filters
 * to cards that were actually IN the sprint via `card_transitions`, the
 * semantically correct source — unlike the org-wide velocity endpoint,
 * which has no project or sprint filter at all and would double-count
 * another project's cards completed on the same calendar days). "This
 * sprint" and "Completed" are both derived from the SAME burndown series
 * already being fetched for the chart below, not a second query —
 * `first.remaining - last.remaining` is exactly the count of cards that
 * left "remaining" since the sprint's own tracked start. "Cycle time" is
 * the existing `cycleTimeQuery`'s median, in days. The "▲/▼" delta on
 * "This sprint" compares against the most recently COMPLETED sprint's own
 * identical calculation — a second burndown query, only fired when a
 * previous sprint actually exists — and is omitted entirely rather than
 * showing a fabricated 0% when there is nothing real to compare against.
 *
 * ## No active sprint
 *
 * A project with no active sprint has nothing sprint-scoped to show: the
 * KPI row reads "—" throughout and the Sprint/Quarter toggle only offers
 * Quarter — there is no sprint window to switch INTO.
 *
 * ## Status, as a footer line rather than a card
 *
 * The old Status tab (§6) is rollup-freshness diagnostics — "when did the
 * background worker last refresh this org's numbers" — not a metric a
 * project lead reads alongside Velocity or Workload. Giving it the same
 * card weight as everything else would bury the KPIs this page actually
 * exists to show under an operational detail nobody but this codebase's
 * own maintainers cares about day to day. It is still real data from the
 * same `statusQuery()` the old tab used, just demoted to one small, muted
 * line under everything else — present, honest about staleness, and out
 * of the way.
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
    <div className="mx-auto max-w-6xl space-y-4">
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
        <DashboardCard
          icon={
            <TrendingDown aria-hidden="true" className="size-4 text-accent" strokeWidth={2.25} />
          }
          title="Burndown"
        >
          <BurndownPanel orgId={orgId} />
        </DashboardCard>
        <DashboardCard
          icon={<Layers aria-hidden="true" className="size-4 text-accent" strokeWidth={2.25} />}
          title="Cumulative flow"
        >
          <CfdPanel orgId={orgId} />
        </DashboardCard>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <DashboardCard
          icon={<Users aria-hidden="true" className="size-4 text-accent" strokeWidth={2.25} />}
          title="Workload"
        >
          <WorkloadPanel />
        </DashboardCard>
        <DashboardCard
          icon={<Clock aria-hidden="true" className="size-4 text-accent" strokeWidth={2.25} />}
          title="Cycle time"
        >
          <CycleTimePanel />
        </DashboardCard>
      </div>

      <DashboardCard
        icon={<Activity aria-hidden="true" className="size-4 text-accent" strokeWidth={2.25} />}
        title="Activity"
      >
        <VolumePanel />
      </DashboardCard>

      <StatusFooter />
    </div>
  );
}

/**
 * The shared card shell every secondary section (Burndown, Flow, Workload,
 * Cycle Time, Activity) renders inside — the same icon+title header
 * language the hero "Velocity & flow" card above already established,
 * applied consistently rather than each panel inventing its own heading
 * style. `children` is the panel's own returned JSX unchanged; only the
 * title it used to print itself moved up into this shell.
 */
function DashboardCard({
  icon,
  title,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface-raised p-4">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * The old Status tab, demoted to one line — see this file's own header
 * comment for why rollup-freshness diagnostics do not get a card of their
 * own on a page meant to be read as a set of KPIs. Renders nothing at all
 * while loading or on error: a status footer that itself shows a loading
 * skeleton or an error box would be a bigger visual claim than this data
 * is worth making.
 */
function StatusFooter() {
  const status = useQuery(statusQuery());
  if (status.data === undefined) return null;

  const refreshedAt = status.data.rollupLastRefreshedAt;

  return (
    <p className="flex items-center justify-center gap-1.5 px-1 py-1 text-center text-xs text-ink-faint">
      <RefreshCw aria-hidden="true" className="size-3" strokeWidth={2} />
      {refreshedAt === null
        ? 'Rollups have not run for this organization yet.'
        : `Data current as of ${formatRelative(refreshedAt)} · ${String(status.data.totalTransitions)} transitions indexed`}
    </p>
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
