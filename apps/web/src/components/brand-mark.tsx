import { useBranding } from '../lib/branding-context.js';
import { cn } from '../lib/cn.js';

/**
 * The product's mark — three connected nodes representing tasks flowing
 * through a pipeline. Uses `currentColor` so it inherits the accent palette
 * via CSS. When an operator uploads a custom logo, that image replaces this
 * mark wherever it appears.
 */
export function BrandMark({
  size = 40,
  className,
}: {
  readonly size?: number;
  readonly className?: string;
}) {
  const { logoUrl, productName } = useBranding();

  if (logoUrl !== null) {
    return (
      <img
        src={logoUrl}
        alt=""
        className={cn('rounded-lg object-contain', className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label={productName}
      className={className}
    >
      {/* Flowing paths connecting the three nodes */}
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
      {/* Node 3 — completion (large, with subtle highlight) */}
      <circle cx="24" cy="16" r="5.5" fill="currentColor" opacity="0.85" />
      <circle cx="24" cy="16" r="5.5" fill="white" opacity="0.15" />
    </svg>
  );
}
