import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Calendar,
  CalendarCheck,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  GitPullRequest,
} from 'lucide-react';
import type { CardId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { cn } from '../../../lib/cn.js';
import { cardBranchesQuery, cardCalendarSyncQuery, cardPullRequestsQuery } from '../api.js';
import { PrStatusBadge } from './pr-status-badge.js';

/**
 * The card's identity line — reference, linked PRs, linked branches, all in
 * one glanceable, clickable row next to the card title (ai/phase-15-ai-
 * copilot-and-permissions.md §7.2). Found necessary from a direct report:
 * both were buried in a "Pull requests" section far down the panel, with no
 * way to tell a PR chip from a branch chip at a glance and no way to copy
 * the card's own reference the way ClickUp's card id is copyable.
 *
 * Reads the SAME two queries `development-section.tsx`'s body renders below
 * — React Query dedupes by key, so this costs no extra request beyond
 * whichever of the two mounts first. Nothing here can WRITE; creating a
 * branch or linking a PR stays in the expanded section, which is where the
 * confirmation/error surface for those actions already lives.
 */

export function CardIdentityBar({
  orgId,
  cardId,
  reference,
}: {
  readonly orgId: string;
  readonly cardId: CardId;
  readonly reference: string;
}) {
  const prs = useQuery(cardPullRequestsQuery(orgId, cardId));
  const branches = useQuery(cardBranchesQuery(orgId, cardId));

  return (
    /* `flex-1` so this row — not the fixed-height header around it — is what
       claims the space between the modal's left edge and the Archive/Close
       buttons pinned to `ml-auto` on the right; `overflow-x-auto` alongside
       `min-w-0` is what lets it actually SHRINK to that space rather than
       forcing the header wider. Every chip inside stays `shrink-0`, so a
       card carrying several linked PRs and branches scrolls horizontally
       within its own row instead of pushing Close off the edge of the
       panel — the failure mode a plain `flex` row with no wrap and no
       overflow handling has no way to avoid once the content is wider than
       the space, which a genuinely active card reaches sooner than it
       looks. */
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
      <CopyableReference reference={reference} />

      {prs.data?.map((pr) => (
        <span
          key={`pr-${pr.providerScope}#${String(pr.prNumber)}`}
          className="inline-flex shrink-0 items-center gap-1"
        >
          <IdentityChip
            href={`https://github.com/${pr.providerScope}/pull/${String(pr.prNumber)}`}
            icon={<GitPullRequest aria-hidden="true" className="size-3" strokeWidth={2} />}
            label={`#${String(pr.prNumber)}`}
            title={`${pr.providerScope}#${String(pr.prNumber)} — open on GitHub`}
          />
          <PrStatusBadge orgId={orgId} providerScope={pr.providerScope} prNumber={pr.prNumber} />
        </span>
      ))}

      {branches.data?.map((branch) => (
        <IdentityChip
          key={`branch-${branch.providerScope}-${branch.branchName}`}
          href={`https://github.com/${branch.providerScope}/tree/${branch.branchName}`}
          icon={<GitBranch aria-hidden="true" className="size-3" strokeWidth={2} />}
          label={branch.branchName}
          title={`${branch.providerScope}@${branch.branchName} — open on GitHub`}
          truncate
        />
      ))}

      <CalendarSyncToggle orgId={orgId} cardId={cardId} />
    </div>
  );
}

/**
 * The opt-in-per-event calendar icon (product brainstorm: "no external
 * calendar sync" — fixed as a simple per-card toggle, per the project
 * owner's own explicit choice, never a default "assigned to me" scope).
 * `work.cards.calendarSync.status`/`.toggle` are `card:read`-gated and
 * self-referential — this is the CURRENT viewer's own subscription, not a
 * setting anyone else can see or change from here.
 */
function CalendarSyncToggle({
  orgId,
  cardId,
}: {
  readonly orgId: string;
  readonly cardId: CardId;
}) {
  const queryClient = useQueryClient();
  const status = useQuery(cardCalendarSyncQuery(orgId, cardId));

  const toggle = useMutation({
    mutationFn: (synced: boolean) => api.work.cards.calendarSync.toggle.mutate({ cardId, synced }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: keys.cardCalendarSync(orgId, cardId) }),
  });

  const synced = status.data?.synced ?? false;

  return (
    <button
      type="button"
      disabled={toggle.isPending}
      title={synced ? 'Remove from your calendar' : 'Add to your calendar'}
      aria-pressed={synced}
      onClick={() => {
        toggle.mutate(!synced);
      }}
      className={cn(
        'press inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium transition-colors duration-(--motion-fast) disabled:opacity-50',
        synced
          ? 'border-accent/30 bg-accent/10 text-accent hover:border-accent/50'
          : 'border-line/30 bg-surface-hover/80 text-ink-muted hover:border-line-strong hover:text-ink',
      )}
    >
      {synced ? (
        <CalendarCheck aria-hidden="true" className="size-3" strokeWidth={2} />
      ) : (
        <Calendar aria-hidden="true" className="size-3" strokeWidth={2} />
      )}
    </button>
  );
}

/**
 * Click-to-copy, ClickUp-style — copies the bare reference (`WEB-142`), the
 * exact string a person would paste into another card, a commit message, or
 * a Slack thread. Swaps to a checkmark for 1.5s rather than relying on a
 * tooltip this component tree has no primitive for.
 */
function CopyableReference({ reference }: { readonly reference: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      title="Copy reference"
      onClick={() => {
        void navigator.clipboard.writeText(reference).then(() => {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
          }, 1500);
        });
      }}
      className="press inline-flex shrink-0 items-center gap-1 rounded-md border border-line/50 bg-surface-sunken px-1.5 py-0.5 font-mono text-xs font-medium text-ink-muted transition-colors duration-(--motion-fast) hover:border-line-strong hover:bg-surface-hover hover:text-ink"
    >
      {reference}
      {copied ? (
        <Check aria-hidden="true" className="size-3 text-success" strokeWidth={2.5} />
      ) : (
        <Copy aria-hidden="true" className="size-3 opacity-60" strokeWidth={2} />
      )}
    </button>
  );
}

function IdentityChip({
  href,
  icon,
  label,
  title,
  truncate = false,
}: {
  readonly href: string;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly title: string;
  readonly truncate?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md border border-line/30 bg-surface-hover/80 px-1.5 py-0.5 text-xs font-medium text-ink-muted transition-colors duration-(--motion-fast) hover:border-line-strong hover:bg-surface-hover hover:text-accent',
        truncate && 'max-w-[9rem]',
      )}
    >
      {icon}
      <span className={cn(truncate && 'truncate')}>{label}</span>
      <ExternalLink aria-hidden="true" className="size-2.5 shrink-0 opacity-50" strokeWidth={2} />
    </a>
  );
}
