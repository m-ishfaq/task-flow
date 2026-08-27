/**
 * The TaskFlow abstract flow-mark — three connected nodes representing
 * tasks flowing through a pipeline.
 *
 * Uses `currentColor` so it inherits whatever text color the parent sets,
 * meaning it automatically picks up the accent palette without any prop.
 * Renders at any size via the `size` prop (default 32px).
 *
 * The design: three circles of increasing size connected by a flowing
 * bezier curve. The path suggests forward motion — tasks entering at
 * the small node, flowing through the pipeline, and arriving at the
 * large node as completed work.
 */
export function TaskFlowLogo({
  size = 32,
  className,
}: {
  readonly size?: number;
  readonly className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Flowing path connecting the three nodes — a smooth S-curve */}
      <path
        d="M8 12C8 12 12 8 16 12C20 16 24 12 24 12"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.5"
      />
      <path
        d="M8 20C8 20 12 16 16 20C20 24 24 20 24 20"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity="0.3"
      />

      {/* Node 1 — entry point (small) */}
      <circle cx="8" cy="16" r="3.5" fill="currentColor" opacity="0.9" />

      {/* Node 2 — in-progress (medium) */}
      <circle cx="16" cy="16" r="4.5" fill="currentColor" />

      {/* Node 3 — completion (large, with a subtle highlight) */}
      <circle cx="24" cy="16" r="5.5" fill="currentColor" opacity="0.85" />
      <circle cx="24" cy="16" r="5.5" fill="white" opacity="0.15" />
    </svg>
  );
}
