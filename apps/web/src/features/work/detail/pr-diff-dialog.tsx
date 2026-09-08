import { useState } from 'react';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { useQuery } from '@tanstack/react-query';
import { FileDiff } from 'lucide-react';
import { Button, SkeletonRows } from '../../../components/primitives.js';
import { ErrorView } from '../../../components/error-view.js';
import { DiffView } from '../../ai/diff-view.js';
import { pullRequestDiffQuery } from '../api.js';

/**
 * "View diff" straight from the card — the same `DiffView` and
 * `getPullRequestDiff` the AI assistant's `get_pr_diff` tool already uses
 * (ai/phase-15-ai-copilot-and-permissions.md §7), reached without a chat
 * detour. A trigger button plus its own small dialog, not a route: a diff
 * is scratch viewing, not a destination worth its own URL.
 */
export function PrDiffButton({
  orgId,
  providerScope,
  prNumber,
}: {
  readonly orgId: string;
  readonly providerScope: string;
  readonly prNumber: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <ModalRoot open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 px-1.5 text-[11px]"
        title="View diff"
        onClick={() => {
          setOpen(true);
        }}
      >
        <FileDiff aria-hidden="true" className="size-3" strokeWidth={2} />
      </Button>
      {open && <PrDiffDialogBody orgId={orgId} providerScope={providerScope} prNumber={prNumber} />}
    </ModalRoot>
  );
}

/* A separate component, mounted only while `open` — the diff query has no
   reason to run (or stay cached against a stale card session) before
   someone actually clicks the button, the same "fetch on demand" instinct
   `pullRequestDiffQuery`'s own header states. */
function PrDiffDialogBody({
  orgId,
  providerScope,
  prNumber,
}: {
  readonly orgId: string;
  readonly providerScope: string;
  readonly prNumber: number;
}) {
  const diff = useQuery(pullRequestDiffQuery(orgId, providerScope, prNumber));

  return (
    <ModalContent size="xl" className="flex max-h-[85vh] flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
        <ModalTitle className="text-sm font-medium text-ink">
          {providerScope}#{prNumber}
        </ModalTitle>
      </div>
      <ModalDescription className="sr-only">
        The diff for {providerScope}#{prNumber}.
      </ModalDescription>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {diff.isPending ? (
          <SkeletonRows rows={6} />
        ) : diff.isError ? (
          <ErrorView error={diff.error} title="Could not load the diff" />
        ) : (
          <DiffView diff={diff.data.diff} truncated={diff.data.truncated} />
        )}
      </div>
    </ModalContent>
  );
}
