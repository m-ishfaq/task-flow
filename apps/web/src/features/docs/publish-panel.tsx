import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PageId } from '@taskflow/contracts';
import { useToast } from '../../lib/toast-context.js';
import { formatRelative } from '../../lib/format.js';
import { Badge, Button, ConfirmButton, Input } from '../../components/primitives.js';
import { exportPagePdf, invalidatePages, publishPage, unpublishPage } from './api.js';

/**
 * Publish-to-public, and PDF export (ai/phase-6-docs.md §3.9, Wave 4).
 *
 * ## The public link's shape
 *
 * `/public/docs/{orgId}/{pageId}` is served by `public-page.tsx`, an
 * UNAUTHENTICATED route registered alongside every other route in
 * `router.tsx` — `Shell`'s own `bare` rendering already covers any route
 * reached with `status !== 'authenticated'` (`components/shell.tsx`'s own
 * header), so no separate "public layout" was needed. `orgId` is a plain,
 * visible path segment, matching `public.service.ts`'s own header on why
 * that is safe: it is never written to `app.org_id` and never derives a
 * role, and `getPublishedPage` re-checks `published_version_id IS NOT NULL`
 * on every request regardless of what the URL claims.
 *
 * ## PDF bytes travel as base64
 *
 * `pages.exportPdf`'s own router comment explains why: tRPC's wire format is
 * plain JSON, so there is no streaming response the way attachment download
 * has. Decoding happens here, entirely client-side, into a `Blob` download —
 * nothing round-trips through a data URL big enough to matter for a page-
 * sized document.
 */

export function PublishPanel({
  orgId,
  spaceId,
  pageId,
  publishedAt,
}: {
  readonly orgId: string;
  readonly spaceId: string;
  readonly pageId: PageId;
  readonly publishedAt: string | null;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const publish = useMutation({
    mutationFn: () => publishPage({ pageId }),
    onSuccess: () => {
      invalidatePages(queryClient, orgId, spaceId);
      toast.show('Published', { tone: 'success' });
    },
    onError: (error) => {
      toast.failure('The page was not published', error);
    },
  });

  const unpublish = useMutation({
    mutationFn: () => unpublishPage({ pageId }),
    onSuccess: () => {
      invalidatePages(queryClient, orgId, spaceId);
      toast.show('Unpublished', { tone: 'success' });
    },
    onError: (error) => {
      toast.failure('The page was not unpublished', error);
    },
  });

  const exportPdf = useMutation({
    mutationFn: () => exportPagePdf({ pageId, versionId: null }),
    onSuccess: (result) => {
      downloadBase64Pdf(result.filename, result.contentBase64);
    },
    onError: (error) => {
      toast.failure('The PDF was not exported', error);
    },
  });

  const publicUrl = `${window.location.origin}/public/docs/${orgId}/${pageId}`;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      toast.failure('The link could not be copied', error);
    }
  };

  return (
    <div className="space-y-2">
      {/* No own heading — the tab strip above already labels this
          "Publish"; see `docs-page.tsx`'s `DOC_TOOLS`. */}
      {publishedAt !== null && (
        <div>
          <Badge tone="success">published</Badge>
        </div>
      )}

      {publishedAt !== null ? (
        <div className="space-y-1.5">
          <p className="text-xs text-ink-faint">
            Published {formatRelative(publishedAt)} — anyone with the link can view it.
          </p>
          <div className="flex gap-1.5">
            <Input readOnly value={publicUrl} className="h-7 flex-1 text-xs" />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void copyLink();
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
          <ConfirmButton
            label="Unpublish"
            confirmLabel="Take it offline"
            disabled={unpublish.isPending}
            onConfirm={() => {
              unpublish.mutate();
            }}
          />
        </div>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          disabled={publish.isPending}
          onClick={() => {
            publish.mutate();
          }}
        >
          Publish
        </Button>
      )}

      <div>
        <Button
          size="sm"
          variant="ghost"
          disabled={exportPdf.isPending}
          onClick={() => {
            exportPdf.mutate();
          }}
        >
          {exportPdf.isPending ? 'Exporting…' : 'Export as PDF'}
        </Button>
      </div>
    </div>
  );
}

function downloadBase64Pdf(filename: string, base64: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Deferred, not immediate: revoking synchronously after `click()` can race
  // the browser's own (asynchronous) download start in some engines.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
