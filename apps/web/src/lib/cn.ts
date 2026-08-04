import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Conditional class names, with later Tailwind utilities winning.
 *
 * `clsx` alone produces `"px-2 px-4"`, where which one applies depends on their
 * order in the generated stylesheet rather than in the call — so a component's
 * `className` override works or does not depending on which utility Tailwind
 * emitted first. `twMerge` resolves the conflict by keeping the last.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
