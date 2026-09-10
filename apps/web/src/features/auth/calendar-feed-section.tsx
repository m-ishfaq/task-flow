import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { AddPanel, Badge, Button, Section, SkeletonRows } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { useStepUp } from './use-step-up.js';

/**
 * The personal calendar feed (product brainstorm: per-card opt-in calendar
 * sync). Mirrors `TotpSection`/`PasskeySection`'s enroll-and-show-once
 * shape: the URL is a bearer credential, shown exactly once, then masked —
 * the identical contract this codebase already uses for TOTP recovery
 * codes and a GitHub connector's verify secret.
 *
 * ⚠ A genuinely new security-surface CLASS — see
 * `apps/api/src/identity/calendar-feed.service.ts`'s own header for the
 * accepted tradeoff (a long-lived bearer token in a URL, a deliberate
 * exception to this codebase's otherwise-consistent "re-validate against
 * RLS" stance for public reads).
 *
 * "Generate" and "Regenerate" are the SAME mutation — `auth.calendarFeed
 * .mint` always mints a fresh URL, revoking whatever was active before.
 * There is no "get my existing URL back": the raw token was never stored,
 * so a second visit to this section only ever offers a NEW one.
 */
export function CalendarFeedSection() {
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const status = useQuery({
    queryKey: keys.calendarFeedStatus(),
    queryFn: () => api.auth.calendarFeed.status.query(),
  });

  const mint = useMutation({
    mutationFn: () => api.auth.calendarFeed.mint.mutate(),
    onSuccess: (result) => {
      setMintedUrl(result.url);
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: keys.calendarFeedStatus() });
    },
    onError: (error) => {
      guard(error, () => {
        mint.mutate();
      });
    },
  });

  return (
    <Section
      title="Calendar sync"
      description="Add a card's due date to your own calendar by clicking the calendar icon on it — this feed is what your calendar app subscribes to for those cards."
    >
      {status.isPending && <SkeletonRows rows={1} className="*:h-12" />}
      {status.isError && (
        <ErrorView error={status.error} title="Could not load your calendar feed status" />
      )}

      {status.data !== undefined && mintedUrl === null && (
        <>
          <div className="flex items-center justify-between">
            {status.data.active ? <Badge tone="success">Active</Badge> : <Badge>Not set up</Badge>}
            <Button
              variant="secondary"
              size="sm"
              disabled={mint.isPending}
              onClick={() => {
                mint.mutate();
              }}
            >
              {mint.isPending
                ? 'Generating…'
                : status.data.active
                  ? 'Regenerate'
                  : 'Generate calendar feed'}
            </Button>
          </div>
          {status.data.active && (
            <p className="mt-1 text-[11px] text-ink-faint">
              Regenerating replaces your existing feed — the old link stops working immediately.
            </p>
          )}
          {mint.isError && <ErrorText error={mint.error} />}
        </>
      )}

      {mintedUrl !== null && (
        <AddPanel>
          <p className="text-xs text-ink-muted">
            Copy this link now — it is shown only this once. Add it to Google, Outlook, or Apple
            Calendar as a &ldquo;subscribe by URL&rdquo; calendar, and it will stay up to date with
            whichever cards you sync.
          </p>
          <p className="mt-2 select-all break-all rounded bg-surface-hover px-2 py-1.5 font-mono text-xs text-ink">
            {mintedUrl}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(mintedUrl).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setMintedUrl(null);
              }}
            >
              Done
            </Button>
          </div>

          {/* "Subscribe by URL" is not a control most people have used before,
              and naming the destination calendar apps without saying where
              the option lives inside each one left a real gap — a person
              copies the link and then has nowhere obvious to paste it. Open
              by default: this is exactly the information needed the moment
              the link is on screen, not something to go looking for. */}
          <details open className="mt-3 border-t border-line pt-3">
            <summary className="cursor-pointer text-[11px] font-medium text-ink-muted">
              Where do I paste this?
            </summary>
            <ul className="mt-2 space-y-2 text-[11px] text-ink-faint">
              <li>
                <span className="font-medium text-ink-muted">Google Calendar (web):</span> in the
                left sidebar, next to &ldquo;Other calendars&rdquo;, click <strong>+</strong> →{' '}
                <strong>From URL</strong>, paste the link, then <strong>Add calendar</strong>.
              </li>
              <li>
                <span className="font-medium text-ink-muted">Outlook (web):</span>{' '}
                <strong>Add calendar</strong> → <strong>Subscribe from web</strong>, paste the link,
                then <strong>Import</strong>.
              </li>
              <li>
                <span className="font-medium text-ink-muted">Apple Calendar (Mac):</span>{' '}
                <strong>File</strong> → <strong>New Calendar Subscription…</strong>, paste the link,
                then <strong>Subscribe</strong>.
              </li>
              <li>
                <span className="font-medium text-ink-muted">Apple Calendar (iPhone/iPad):</span>{' '}
                <strong>Settings</strong> → <strong>Calendar</strong> → <strong>Accounts</strong> →{' '}
                <strong>Add Account</strong> → <strong>Other</strong> →{' '}
                <strong>Add Subscribed Calendar</strong>, then paste the link.
              </li>
            </ul>
            <p className="mt-2 text-[11px] text-ink-faint">
              Every calendar app polls this link on its own schedule — a card you sync will usually
              appear within a few hours, not instantly.
            </p>
          </details>
        </AddPanel>
      )}

      {dialog}
    </Section>
  );
}
