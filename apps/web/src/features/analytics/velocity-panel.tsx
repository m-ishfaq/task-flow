import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { velocityQuery } from './api.js';
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
  const maxCount = Math.max(...points.map((p) => p.count), 1);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-medium text-ink/80">Velocity</h2>
        <span className="text-xs text-ink/50">
          {total} cards done in {days} days
        </span>
      </div>

      {/* Design Bible §10's own velocity treatment: a gradient area fill
          under the line, three faint gridlines, and an emphasized dot —
          a ring plus a solid center — at the chart's own most recent
          point. Same daily data this chart always plotted, rendered as a
          line instead of bars; each point keeps a native SVG `<title>` on
          an otherwise-invisible hover target, the simplest way to keep
          "hover for the exact count" without reproducing the old bar
          chart's own absolute-positioned tooltip div for a shape (a line)
          that has no per-point box to anchor one to. */}
      <svg
        viewBox="0 0 640 120"
        className="w-full"
        style={{ height: 120 }}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="velocity-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="oklch(62% 0.18 285)" stopOpacity="0.3" />
            <stop offset="1" stopColor="oklch(62% 0.18 285)" stopOpacity="0" />
          </linearGradient>
        </defs>

        <line x1={0} y1={30} x2={640} y2={30} stroke="var(--color-line)" />
        <line x1={0} y1={60} x2={640} y2={60} stroke="var(--color-line)" />
        <line x1={0} y1={90} x2={640} y2={90} stroke="var(--color-line)" />

        {(() => {
          const step = points.length > 1 ? 640 / (points.length - 1) : 0;
          const yFor = (count: number) => 118 - (count / maxCount) * 108;
          const coords = points.map((p, i) => ({ x: i * step, y: yFor(p.count), point: p }));
          const last = coords[coords.length - 1];
          if (last === undefined) return null;

          const line = coords.map((c) => `${String(c.x)},${String(c.y)}`).join(' ');
          const area = `M${line} L${String(last.x)},120 L0,120 Z`;

          return (
            <>
              <path d={area} fill="url(#velocity-fill)" />
              <polyline
                fill="none"
                stroke="var(--color-accent-strong)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={line}
              />
              <circle cx={last.x} cy={last.y} r={4} fill="oklch(66% 0.18 285)" />
              <circle
                cx={last.x}
                cy={last.y}
                r={7.5}
                fill="none"
                stroke="oklch(66% 0.18 285)"
                strokeOpacity="0.35"
                strokeWidth="2"
              />
              {coords.map((c) => (
                <circle key={c.point.date} cx={c.x} cy={c.y} r={8} fill="transparent">
                  <title>
                    {c.point.date}: {c.point.count}
                  </title>
                </circle>
              ))}
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
