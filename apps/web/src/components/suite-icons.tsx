import type { LucideProps } from 'lucide-react';

/**
 * The bespoke product-mark family (design bible §04).
 *
 * The five product surfaces — Work, Chat, Docs, Calls, People — do NOT use a
 * stock icon-pack glyph. They are one geometric family drawn for TaskFlow,
 * sharing a single construction (a node, a connecting flow-line, a 1.75–2px
 * stroke on a 24 grid) so they read as a set, each carrying its own suite hue
 * via `currentColor`. This is the layer §04 calls "what makes the suite feel
 * authored rather than assembled" — the direct answer to a rail of generic
 * icons reading as AI-generated.
 *
 * UTILITY glyphs (search, bell, filter, plus, chevrons…) deliberately stay
 * lucide — §04's own rule: "inventing a novelty glyph for 'search' is worse
 * UX, not better craft." Only the product marks are bespoke.
 *
 * The paths are the exact geometry from the bible so the app matches it
 * pixel-for-pixel. Typed as `LucideProps` so a mark drops straight into any
 * site that renders a lucide icon (the nav, headers) with the same
 * `className`/`strokeWidth` contract; `size`/`color`/other lucide props are
 * accepted and ignored — the mark sizes from `className` (`size-4`) and colours
 * from `currentColor`, exactly as the surrounding lucide icons do.
 */

function Mark({
  className,
  strokeWidth = 2,
  children,
}: {
  readonly className?: string | undefined;
  readonly strokeWidth?: LucideProps['strokeWidth'];
  readonly children: React.ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Work — two ticked task rows flowing into their lines. */
export function WorkMark({ className, strokeWidth }: LucideProps) {
  return (
    <Mark className={className} strokeWidth={strokeWidth}>
      <path d="M4 7.5 6 9.5 9.5 6" />
      <path d="M4 15.5 6 17.5 9.5 14" />
      <path d="M13 8h7" />
      <path d="M13 16h7" />
    </Mark>
  );
}

/** Chat — a speech node with three message dots. */
export function ChatMark({ className, strokeWidth }: LucideProps) {
  return (
    <Mark className={className} strokeWidth={strokeWidth}>
      <path d="M20 14.5a2 2 0 0 1-2 2H8.5L4.5 20V6.5a2 2 0 0 1 2-2H18a2 2 0 0 1 2 2z" />
      <circle cx="9" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="16" cy="10.5" r="1" fill="currentColor" stroke="none" />
    </Mark>
  );
}

/** Docs — a folded page with a flow-line of text. */
export function DocsMark({ className, strokeWidth }: LucideProps) {
  return (
    <Mark className={className} strokeWidth={strokeWidth}>
      <path d="M13 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.5z" />
      <path d="M13 3.5V9.5h6" />
      <path d="M8.5 13.5c1.5-1.4 3-1.4 4 0s2.5 1.4 3.2 0" />
    </Mark>
  );
}

/** Calls — a handset node with two signal arcs. */
export function CallsMark({ className, strokeWidth }: LucideProps) {
  return (
    <Mark className={className} strokeWidth={strokeWidth}>
      <path d="M14.5 4.5c2.4.5 4.5 2.6 5 5" />
      <path d="M14 8c1 .3 1.8 1.1 2 2.2" />
      <path d="M5 5.5h2.4a1.6 1.6 0 0 1 1.6 1.3l.5 2.4a1.6 1.6 0 0 1-.7 1.7l-1 .7a11 11 0 0 0 4.4 4.4l.7-1a1.6 1.6 0 0 1 1.7-.7l2.4.5A1.6 1.6 0 0 1 20 17v2.3a1.6 1.6 0 0 1-1.7 1.6A14.5 14.5 0 0 1 4.6 7.2 1.6 1.6 0 0 1 5 5.5z" />
    </Mark>
  );
}

/** People — two figure nodes, one behind the other. */
export function PeopleMark({ className, strokeWidth }: LucideProps) {
  return (
    <Mark className={className} strokeWidth={strokeWidth}>
      <circle cx="9" cy="8.5" r="2.7" />
      <path d="M3.8 19a5.2 5.2 0 0 1 10.4 0" />
      <path d="M15.5 6a2.7 2.7 0 0 1 0 5.2" />
      <path d="M17 14.2a5.2 5.2 0 0 1 3.2 4.8" />
    </Mark>
  );
}
