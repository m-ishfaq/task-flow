import { useId } from 'react';
import type { VelocityPoint } from './api.js';

/**
 * The Design Bible §10 velocity treatment — a gradient area fill under the
 * line, three faint gridlines, and an emphasized dot (a ring plus a solid
 * center) at the chart's own most recent point.
 *
 * Extracted out of `velocity-panel.tsx` once a second real caller needed the
 * identical chart: the Analytics overview's own hero card plots the same
 * daily-done-count shape, just over a different (sprint- or quarter-bounded)
 * window — the §6 rule this codebase holds itself to ("extract a component
 * only once the same pattern appears a second time"), not extracted ahead of
 * that need.
 *
 * Each point keeps a native SVG `<title>` on an otherwise-invisible hover
 * target, the simplest way to offer "hover for the exact count" without a
 * bar chart's own absolute-positioned tooltip div for a shape (a line) with
 * no per-point box to anchor one to.
 *
 * `useId()` gives the gradient a unique id per mounted instance — with two
 * real call sites now, two charts could in principle be on screen in the
 * same document at once (a future page composing both), and SVG `<defs>`
 * ids are global to the document; a shared literal id would make the SECOND
 * instance silently paint using the FIRST one's gradient node.
 */
export function VelocityChart({ points }: { readonly points: readonly VelocityPoint[] }) {
  const gradientId = `velocity-fill-${useId()}`;
  const maxCount = Math.max(...points.map((p) => p.count), 1);

  const step = points.length > 1 ? 640 / (points.length - 1) : 0;
  const yFor = (count: number) => 118 - (count / maxCount) * 108;
  const coords = points.map((p, i) => ({ x: i * step, y: yFor(p.count), point: p }));
  const last = coords[coords.length - 1];

  return (
    <svg
      viewBox="0 0 640 120"
      className="w-full"
      style={{ height: 120 }}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          {/* `var(--color-accent-strong)`, matching the polyline below —
              not a literal `oklch(.. 285)`, which stayed indigo regardless
              of an org's branding palette (see styles.css's own
              `--color-accent-strong` comment for the wider fix). */}
          <stop offset="0" stopColor="var(--color-accent-strong)" stopOpacity="0.3" />
          <stop offset="1" stopColor="var(--color-accent-strong)" stopOpacity="0" />
        </linearGradient>
      </defs>

      <line x1={0} y1={30} x2={640} y2={30} stroke="var(--color-line)" />
      <line x1={0} y1={60} x2={640} y2={60} stroke="var(--color-line)" />
      <line x1={0} y1={90} x2={640} y2={90} stroke="var(--color-line)" />

      {last !== undefined && (
        <>
          <path
            d={`M${coords.map((c) => `${String(c.x)},${String(c.y)}`).join(' ')} L${String(last.x)},120 L0,120 Z`}
            fill={`url(#${gradientId})`}
          />
          <polyline
            fill="none"
            stroke="var(--color-accent-strong)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={coords.map((c) => `${String(c.x)},${String(c.y)}`).join(' ')}
          />
          <circle cx={last.x} cy={last.y} r={4} fill="var(--color-accent-strong)" />
          <circle
            cx={last.x}
            cy={last.y}
            r={7.5}
            fill="none"
            stroke="var(--color-accent-strong)"
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
      )}
    </svg>
  );
}
