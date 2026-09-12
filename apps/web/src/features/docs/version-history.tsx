import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageId } from '@taskflow/contracts';
import { useToast } from '../../lib/toast-context.js';
import { formatRelative } from '../../lib/format.js';
import {
  Avatar,
  Badge,
  Button,
  ConfirmButton,
  Empty,
  SearchInput,
  Skeleton,
} from '../../components/primitives.js';
import { useMembers } from '../org/use-members.js';
import {
  invalidatePageVersions,
  pageVersionsQuery,
  restoreVersion,
  saveVersion,
  type PageVersionSummary,
} from './api.js';

/**
 * Version history (ai/phase-6-docs.md §3.7, Wave 2 backend / Wave 4 UI).
 *
 * ## Restoring does not touch an already-open live session
 *
 * `page-version.service.ts`'s own header names this explicitly: restore
 * writes a fresh `page_versions` snapshot, and a currently-connected
 * `apps/collab` session only picks it up on its NEXT load, not live. So a
 * successful restore here calls `onRestored`, which `docs-page.tsx`'s
 * `PagePanel` uses to remount `DocsEditor` with a fresh key — the same
 * mechanism a page switch already uses to open a clean connection per page
 * (`docs-page.tsx`'s own header). Without it, "Restore" would appear to do
 * nothing until the next reload, which is indistinguishable from having
 * failed.
 *
 * ## "Save a version" vs. autosave
 *
 * `kind` is `'manual' | 'autosave' | 'publish'` — this panel does not filter
 * by kind because a caller deciding "restore to right before I broke it" may
 * well want to reach for an autosave point, not just the manual ones. The
 * `Badge` is the only place the distinction shows.
 */

/** `listPageVersions`'s own `PAGE_VERSION_LIST_LIMIT`
 *  (`apps/api/src/docs/page-version.service.ts`) — restated here because a
 *  route's server-side constant is not something the client imports across
 *  the API boundary, the same trade `notifications.ts`'s own `PAGE_SIZE`
 *  already accepts for its bell. */
const PAGE_VERSION_LIST_LIMIT = 200;

export function VersionHistoryPanel({
  orgId,
  pageId,
  onRestored,
}: {
  readonly orgId: string;
  readonly pageId: PageId;
  /** Called after a successful restore — see the header on why the caller must remount the live editor. */
  readonly onRestored: () => void;
}) {
  const versions = useQuery(pageVersionsQuery(orgId, pageId));
  const queryClient = useQueryClient();
  const toast = useToast();
  const { personOf } = useMembers();
  const [search, setSearch] = useState('');

  const save = useMutation({
    mutationFn: () => saveVersion({ pageId }),
    onSuccess: () => {
      invalidatePageVersions(queryClient, orgId, pageId);
      toast.show('Version saved', { tone: 'success' });
    },
    onError: (error) => {
      toast.failure('The version was not saved', error);
    },
  });

  const restore = useMutation({
    mutationFn: (versionId: string) => restoreVersion({ pageId, versionId }),
    onSuccess: () => {
      invalidatePageVersions(queryClient, orgId, pageId);
      toast.show('Restored — reconnecting to the live document…', { tone: 'success' });
      onRestored();
    },
    onError: (error) => {
      toast.failure('The version was not restored', error);
    },
  });

  const list = versions.data ?? [];
  const needle = search.trim().toLowerCase();
  const visibleList = list.filter((version) => {
    if (needle === '') return true;
    const authorLabel = version.createdBy === null ? '' : personOf(version.createdBy).label;
    return (
      version.kind.toLowerCase().includes(needle) || authorLabel.toLowerCase().includes(needle)
    );
  });

  return (
    <div className="space-y-3">
      {/* No own heading — the tab strip above already labels this "Version
          history"; see `docs-page.tsx`'s `DOC_TOOLS`. */}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          disabled={save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          Save current version
        </Button>
      </div>

      {/* Design Bible §20 — a page saved-and-autosaved for months can
          genuinely accumulate enough versions to need this; below that,
          one more control is clutter for a list a glance already covers. */}
      {list.length > 15 && (
        <SearchInput value={search} onChange={setSearch} placeholder="Filter by kind or author…" />
      )}

      {versions.isPending ? (
        <div aria-busy="true" className="space-y-1.5">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-3/4" />
        </div>
      ) : list.length === 0 ? (
        <Empty
          title="No saved versions yet"
          description="Save one, or wait for the next autosave."
        />
      ) : visibleList.length === 0 ? (
        <p className="text-sm text-ink-faint">No versions match your search.</p>
      ) : (
        <ul className="space-y-1">
          {visibleList.map((version) => (
            <VersionRow
              key={version.versionId}
              version={version}
              authorLabel={version.createdBy === null ? null : personOf(version.createdBy).label}
              onRestore={() => {
                restore.mutate(version.versionId);
              }}
              restorePending={restore.isPending}
            />
          ))}
        </ul>
      )}

      {/* `listPageVersions` takes a hard limit, never a cursor — the
          identical "say where the list stops" disclosure the call log and
          SMS threads give theirs. */}
      {list.length === PAGE_VERSION_LIST_LIMIT && (
        <p className="text-center text-[11px] text-ink-faint">
          Showing the most recent {PAGE_VERSION_LIST_LIMIT} versions.
        </p>
      )}
    </div>
  );
}

function VersionRow({
  version,
  authorLabel,
  onRestore,
  restorePending,
}: {
  readonly version: PageVersionSummary;
  readonly authorLabel: string | null;
  readonly onRestore: () => void;
  readonly restorePending: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 hover:bg-surface-hover">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Badge className={version.kind === 'publish' ? 'text-success' : ''}>{version.kind}</Badge>
        {/* Same fix as `comments-suggestions.tsx` — a version's author was
            text-only here where the identical kind of content (who did
            this) gets a face everywhere else (ai/phase-6.5-ui-polish.md
            Wave 4). An autosave has no human author to show a face for. */}
        {version.createdBy !== null && authorLabel !== null && (
          <Avatar userId={version.createdBy} label={authorLabel} size="xs" />
        )}
        <span className="truncate text-ink-muted">
          {authorLabel ?? (version.kind === 'autosave' ? 'Autosave' : 'Unknown')}
        </span>
        <span className="shrink-0 text-ink-faint">{formatRelative(version.createdAt)}</span>
      </div>

      <ConfirmButton
        label="Restore"
        confirmLabel="Restore this version"
        disabled={restorePending}
        onConfirm={onRestore}
      />
    </li>
  );
}
