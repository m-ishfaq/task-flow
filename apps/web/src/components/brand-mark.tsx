import { useId } from 'react';
import { useBranding } from '../lib/branding-context.js';
import { cn } from '../lib/cn.js';

/**
 * The product's mark — a rounded square filled with the accent-flow gradient
 * (the same `from-accent to-accent/0` motif as the sidebar's active bar and a
 * card's priority stripe) with a single light bar cut through it: "a task on
 * the flow". One geometric shape, no clipart, and it follows the deployment's
 * branding palette because the gradient stops are `var(--color-accent)` CSS
 * custom properties, which the `BrandingProvider` overrides live.
 *
 * When an operator uploads a logo through the platform console (migration
 * 0073), the uploaded logo replaces this mark wherever it appears — the
 * favicon included, since `branding-provider.tsx` swaps the icon link the
 * same way.
 */
export function BrandMark({
  size = 40,
  className,
}: {
  readonly size?: number;
  readonly className?: string;
}) {
  const { logoUrl, productName } = useBranding();
  /* The gradient's id must be unique per instance — two marks on one page
     (the favicon is a separate document, but the login and register pages
     could both mount one in tests) would otherwise reference the first
     instance's defs and break when it unmounts. */
  const gradientId = useId();

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
      viewBox="0 0 40 40"
      role="img"
      aria-label={productName}
      className={className}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-accent)" />
          <stop offset="1" stopColor="var(--color-accent-hover)" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill={`url(#${gradientId})`} />
      <rect x="10" y="17.5" width="20" height="5" rx="2.5" fill="oklch(98% 0.01 285)" opacity="0.92" />
    </svg>
  );
}
