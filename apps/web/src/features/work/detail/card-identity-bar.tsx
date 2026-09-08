import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, GitBranch, GitPullRequest } from 'lucide-react';
import type { CardId } from '@taskflow/contracts';
import { cn } from '../../../lib/cn.js';
import { cardBranchesQuery, cardPullRequestsQuery } from '../api.js';
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
    <div className="flex min-w-0 items-center gap-1.5">
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
    </div>
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
      className="press inline-flex shrink-0 items-center gap-1 rounded-md border border-line/50 bg-surface-sunken px-1.5 py-0.5 font-mono text-xs font-medium text-ink-muted transition-colors hover:border-line-strong hover:bg-surface-hover hover:text-ink"
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
        'inline-flex shrink-0 items-center gap-1 rounded-md border border-line/30 bg-surface-hover/80 px-1.5 py-0.5 text-xs font-medium text-ink-muted transition-colors hover:border-line-strong hover:bg-surface-hover hover:text-accent',
        truncate && 'max-w-[9rem]',
      )}
    >
      {icon}
      <span className={cn(truncate && 'truncate')}>{label}</span>
      <ExternalLink aria-hidden="true" className="size-2.5 shrink-0 opacity-50" strokeWidth={2} />
    </a>
  );
}
