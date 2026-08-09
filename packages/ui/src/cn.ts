import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional class names, with later Tailwind utilities winning.
 *
 * A duplicate of `apps/web/src/lib/cn.ts`, not an import of it — this package
 * has no dependency on the app that consumes it, the same direction every
 * other workspace package already keeps. Four lines is cheaper to repeat than
 * to introduce a shared-utils package for.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
