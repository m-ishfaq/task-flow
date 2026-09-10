import { useState } from 'react';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, FileDiff, FileText } from 'lucide-react';
import { Button, SkeletonRows } from '../../../components/primitives.js';
import { ErrorView } from '../../../components/error-view.js';
import { DiffView, singleFileDiffText } from '../../ai/diff-view.js';
import { pullRequestDiffQuery, pullRequestFileDiffQuery, pullRequestFilesQuery } from '../api.js';

/**
 * "View diff" straight from the card — the same `DiffView` and
 * `getPullRequestDiff` the AI assistant's `get_pr_diff` tool already uses
 * (ai/phase-15-ai-copilot-and-permissions.md §7), reached without a chat
 * detour. A trigger button plus its own small dialog, not a route: a diff
 * is scratch viewing, not a destination worth its own URL.
 *
 * ## Falling back to one file at a time on a genuinely large PR
 *
 * A whole-PR diff has a real, unavoidable ceiling: GitHub itself refuses to
 * render one as `.diff` text past a certain size (406, the identical answer
 * `get_pr_diff` documents), and even under that ceiling `getPullRequestDiff`
 * still truncates a large one (`fitDiffToBudget`). Before `get_pr_file_diff`
 * existed for the AI assistant, this dialog had no way to recover from
 * either case beyond a bare `ErrorView` — found directly, from a real report
 * ("it shows just the error incase of large commit diff"). `PrFileBrowser`
 * is the same fix reused here: `pullRequestFilesQuery` never truncates (it
 * lists paths, not content), and `pullRequestFileDiffQuery` fetches one
 * file's own change on demand, easily fitting even when the whole diff did
 * not. `showFiles` folds BOTH triggers — a manual "Browse by file" click and
 * an outright `diff.isError` — into one derived boolean rather than two
 * separate render branches, so the error case does not need its own copy of
 * the file-browsing UI.
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
        className="h-6 px-1.5 text-xs"
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
  const [browseFiles, setBrowseFiles] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  /* Derived, not synced via an effect: a query's own error state is already
     the fact this needs, and re-deriving it on every render is what keeps
     "the whole diff failed" and "I clicked Browse by file" from needing two
     separate code paths below. */
  const showFiles = browseFiles || diff.isError;
  const canShowFullDiff = !diff.isError;

  return (
    <ModalContent size="xl" className="flex max-h-[85vh] flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
        <ModalTitle className="text-sm font-medium text-ink">
          {providerScope}#{prNumber}
        </ModalTitle>
        {canShowFullDiff && !diff.isPending && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            onClick={() => {
              setBrowseFiles((previous) => !previous);
              setSelectedPath(null);
            }}
          >
            {showFiles ? 'View full diff' : 'Browse by file'}
          </Button>
        )}
      </div>
      <ModalDescription className="sr-only">
        The diff for {providerScope}#{prNumber}.
      </ModalDescription>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {diff.isPending ? (
          <SkeletonRows rows={6} />
        ) : showFiles ? (
          <PrFileBrowser
            orgId={orgId}
            providerScope={providerScope}
            prNumber={prNumber}
            fallbackError={diff.isError ? diff.error : null}
            selectedPath={selectedPath}
            onSelectPath={setSelectedPath}
          />
        ) : (
          <div className="space-y-2">
            <DiffView diff={diff.data.diff} truncated={diff.data.truncated} />
            {diff.data.truncated && (
              <p className="text-xs text-ink-faint">
                This diff was too large to show in full.{' '}
                <button
                  type="button"
                  className="text-accent underline"
                  onClick={() => {
                    setBrowseFiles(true);
                  }}
                >
                  Browse by file
                </button>{' '}
                to see any one file&apos;s own change in full.
              </p>
            )}
          </div>
        )}
      </div>
    </ModalContent>
  );
}

/**
 * The list of files a PR touches — `pullRequestFilesQuery` never truncates,
 * so this always has an answer even when the whole diff could not be
 * fetched at all. `fallbackError` renders the reason the caller landed here
 * involuntarily (a 406, most commonly); it is `null` when someone reached
 * this by choice via "Browse by file" on a diff that loaded fine.
 */
function PrFileBrowser({
  orgId,
  providerScope,
  prNumber,
  fallbackError,
  selectedPath,
  onSelectPath,
}: {
  readonly orgId: string;
  readonly providerScope: string;
  readonly prNumber: number;
  readonly fallbackError: unknown;
  readonly selectedPath: string | null;
  readonly onSelectPath: (path: string | null) => void;
}) {
  const files = useQuery(pullRequestFilesQuery(orgId, providerScope, prNumber));

  if (selectedPath !== null) {
    return (
      <PrSingleFileDiff
        orgId={orgId}
        providerScope={providerScope}
        prNumber={prNumber}
        path={selectedPath}
        onBack={() => {
          onSelectPath(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-3">
      {fallbackError !== null && (
        <ErrorView error={fallbackError} title="Could not load the full diff" />
      )}
      {files.isPending ? (
        <SkeletonRows rows={6} />
      ) : files.isError ? (
        <ErrorView error={files.error} title="Could not load the file list" />
      ) : files.data.length === 0 ? (
        <p className="text-sm text-ink-faint">This pull request changes no files.</p>
      ) : (
        <ul className="space-y-1">
          {files.data.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => {
                  onSelectPath(file.path);
                }}
                className="flex w-full items-center gap-2 rounded border border-line px-2 py-1.5 text-left hover:bg-surface-hover"
              >
                <FileText aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">
                  {file.path}
                </span>
                <span className="shrink-0 text-xs uppercase tracking-wide text-ink-faint">
                  {file.status}
                </span>
                <span className="shrink-0 font-mono text-xs text-success">
                  +{file.additions}
                </span>
                <span className="shrink-0 font-mono text-xs text-danger">
                  -{file.deletions}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One file's own diff — reuses `DiffView`/`singleFileDiffText`, the
    identical pipeline `tool-results.tsx`'s `get_pr_file_diff` renderer
    already uses for the assistant's own version of this same view. */
function PrSingleFileDiff({
  orgId,
  providerScope,
  prNumber,
  path,
  onBack,
}: {
  readonly orgId: string;
  readonly providerScope: string;
  readonly prNumber: number;
  readonly path: string;
  readonly onBack: () => void;
}) {
  const fileDiff = useQuery(pullRequestFileDiffQuery(orgId, providerScope, prNumber, path));

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
      >
        <ChevronLeft aria-hidden="true" className="size-3.5" strokeWidth={2} />
        All files
      </button>
      {fileDiff.isPending ? (
        <SkeletonRows rows={4} />
      ) : fileDiff.isError ? (
        <ErrorView error={fileDiff.error} title="Could not load this file's diff" />
      ) : (
        <DiffView
          diff={singleFileDiffText(fileDiff.data.path, fileDiff.data.patch)}
          truncated={fileDiff.data.truncated}
        />
      )}
    </div>
  );
}
