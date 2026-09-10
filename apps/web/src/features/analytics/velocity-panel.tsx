import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { velocityQuery } from './api.js';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { AreaGradient, ChartFrame, ChartGrid, EndPoint } from './chart.js';

/** §3.1 — Velocity: cards entering done per day (bible §10 craft). */
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
  const peak = points.reduce<{ index: number; count: number }>(
    (best, p, i) => (p.count > best.count ? { index: i, count: p.count } : best),
    { index: 0, count: 0 },
  );
  const peakIndex = peak.index;
  const perDay = total / days;
  const W = points.length * 10;
  const H = 140;

  return (
    <div className="space-y-4">
      {/* KPI strip — the bible's analytics mock leads with four numbers, and
          "cards done" alone wastes the row the eye lands on first. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Done" value={String(total)} hint={`${String(days)} days`} />
        <Stat label="Per day" value={perDay >= 10 ? String(Math.round(perDay)) : perDay.toFixed(1)} hint="average" />
        <Stat label="Peak day" value={String(peak.count)} {...(points[peakIndex] !== undefined ? { hint: points[peakIndex].date } : {})} />
        <Stat label="Active days" value={String(points.filter((p) => p.count > 0).length)} hint={`of ${String(days)}`} />
      </div>

      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-medium text-ink/80">Velocity</h2>
        <span className="text-xs text-ink/50">
          {total} cards done in {String(days)} days
        </span>
      </div>

      <div className="relative">
        <ChartFrame height={H} viewBoxWidth={W} label={`Cards done per day over ${String(days)} days`}>
          <AreaGradient id="velocity-fill" />
          <ChartGrid height={H} width={W} />
          {points.map((p, i) => {
            const barH = Math.max((p.count / maxCount) * (H - 18), p.count > 0 ? 3 : 0);
            const isPeak = i === peakIndex && p.count > 0;
            return (
              <g key={p.date} className="group">
                {/* Invisible hit column so the tooltip is reachable across the
                    full bar slot, not just the drawn bar. */}
                <rect
                  x={i * 10}
                  y={0}
                  width={10}
                  height={H}
                  fill="transparent"
                  className="[&:hover+rect]:fill-[color-mix(in_oklch,var(--accent)_28%,transparent)]"
                />
                <rect
                  x={i * 10 + 1.5}
                  y={H - barH}
                  width={7}
                  height={barH}
                  rx={2}
                  fill={isPeak ? 'var(--accent)' : 'url(#velocity-fill)'}
                  stroke={isPeak ? 'none' : 'var(--accent)'}
                  strokeOpacity={isPeak ? 0 : 0.5}
                  strokeWidth={1}
                />
                {/* Emphasized endpoint: the bible's signature mark, on the peak. */}
                {isPeak && <EndPoint cx={i * 10 + 5} cy={H - barH - 7} r={3} />}
                <title>{`${p.date}: ${String(p.count)}`}</title>
              </g>
            );
          })}
        </ChartFrame>
      </div>

      <div className="flex justify-between text-xs text-ink/40">
        <span>{points[0]?.date}</span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { readonly label: string; readonly value: string; readonly hint?: string }) {
  return (
    <div className="rounded-xl border border-line/50 bg-surface-raised px-3 py-2.5">
      <div className="text-[13px] text-ink-faint">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink">{value}</div>
      {hint !== undefined && <div className="text-[13px] text-ink-faint">{hint}</div>}
    </div>
  );
}
