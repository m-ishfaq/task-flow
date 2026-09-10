import type { ReactNode } from 'react';

/**
 * Shared chart craft (design bible §10): "an area fill, a faint grid, an
 * emphasized endpoint." Every analytics chart is assembled from these three
 * pieces so the dashboards read as one instrument panel rather than seven
 * one-off SVGs.
 *
 * Colours come from CSS custom properties (`--accent`, `--line`) rather than
 * literals so the charts follow the theme the same way every other surface
 * does — `styles.css`'s `@theme` block is the single source.
 */

/** Faint horizontal gridlines behind a chart's plotting area. */
export function ChartGrid({
  rows = 3,
  height,
  width,
}: {
  readonly rows?: number;
  readonly height: number;
  readonly width: number;
}) {
  return (
    <g aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => {
        const y = ((i + 1) / (rows + 1)) * height;
        return (
          <line
            key={i}
            x1={0}
            x2={width}
            y1={y}
            y2={y}
            stroke="var(--line)"
            strokeOpacity={0.45}
            strokeWidth={1}
          />
        );
      })}
    </g>
  );
}

/**
 * The area fill under a line: accent at ~30% opacity fading to transparent —
 * the exact gradient stops the bible's own mock uses. `<defs>` ids must be
 * unique per chart, hence the caller-supplied prefix.
 */
export function AreaGradient({ id }: { readonly id: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="var(--accent)" stopOpacity={0.32} />
        <stop offset="1" stopColor="var(--accent)" stopOpacity={0} />
      </linearGradient>
    </defs>
  );
}

/** The emphasized endpoint: a solid accent dot with a soft ring, on the last point. */
export function EndPoint({
  cx,
  cy,
  r = 3.5,
}: {
  readonly cx: number;
  readonly cy: number;
  readonly r?: number;
}) {
  return (
    <g aria-hidden="true">
      <circle cx={cx} cy={cy} r={r + 3} fill="var(--accent)" fillOpacity={0.18} />
      <circle cx={cx} cy={cy} r={r} fill="var(--accent)" />
    </g>
  );
}

/** Standard chart canvas: `preserveAspectRatio="none"` so points spread the full width. */
export function ChartFrame({
  height,
  viewBoxWidth,
  children,
  label,
}: {
  readonly height: number;
  readonly viewBoxWidth: number;
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${String(viewBoxWidth)} ${String(height)}`}
      className="w-full"
      style={{ height }}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {children}
    </svg>
  );
}

/** A closed area path from a polyline's points (already `x,y` strings). */
export function closedArea(points: readonly string[], height: number, width: number): string {
  if (points.length === 0) return '';
  return `M${points.join(' L')} L${String(width)},${String(height)} L0,${String(height)} Z`;
}
