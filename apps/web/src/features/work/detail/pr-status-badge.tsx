import { useQuery } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  GitMerge,
  GitPullRequestClosed,
  Loader2,
} from 'lucide-react';
import { pullRequestStatusQuery } from '../api.js';

/**
 * A live GitHub state icon plus a CI dot for one linked PR
 * (ai/phase-15-ai-copilot-and-permissions.md §7.2's own "PR state on the
 * chip" / "CI status badge" follow-ups). Reads `work.pullRequests.status`
 * (`pr:view`-gated — see that route's own header), and renders NOTHING at
 * all on any error, including FORBIDDEN — a caller without `pr:view` still
 * sees the plain PR chip `card-identity-bar.tsx`/`development-section.tsx`
 * already render, just without this decoration, per Phase 15 §1's "hide,
 * don't disable" rule applied to a decorative status dot rather than an
 * action control (there is nothing here to disable — a query either
 * answers or it doesn't).
 *
 * Each icon is wrapped in its own `<span title="…">` rather than passed a
 * `title` prop directly — the same "put the tooltip on a real DOM element,
 * not the icon" convention `card-identity-bar.tsx`'s own `IdentityChip`
 * already follows, since an SVG `title` ATTRIBUTE (as opposed to a child
 * `<title>` element) is not reliably rendered as a hover tooltip.
 */
export function PrStatusBadge({
  orgId,
  providerScope,
  prNumber,
}: {
  readonly orgId: string;
  readonly providerScope: string;
  readonly prNumber: number;
}) {
  const status = useQuery(pullRequestStatusQuery(orgId, providerScope, prNumber));
  if (!status.isSuccess) return null;

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <StateIcon
        state={status.data.state}
        merged={status.data.merged}
        isDraft={status.data.isDraft}
      />
      <ChecksDot checksStatus={status.data.checksStatus} />
    </span>
  );
}

function StateIcon({
  state,
  merged,
  isDraft,
}: {
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  readonly isDraft: boolean;
}) {
  if (merged) {
    return (
      <span title="Merged">
        {/* No dedicated "merged purple" token exists — `text-accent` is
            already the closest hue this design system has (285°, the same
            family GitHub's own merged-PR purple sits in), reused rather
            than inventing a one-off literal color nobody else uses. */}
        <GitMerge aria-hidden="true" className="size-3 text-accent" strokeWidth={2} />
      </span>
    );
  }
  if (state === 'closed') {
    return (
      <span title="Closed">
        <GitPullRequestClosed aria-hidden="true" className="size-3 text-danger" strokeWidth={2} />
      </span>
    );
  }
  if (isDraft) {
    return (
      <span title="Draft">
        <CircleDashed aria-hidden="true" className="size-3 text-ink-faint" strokeWidth={2} />
      </span>
    );
  }
  return (
    <span title="Open">
      <CircleDot aria-hidden="true" className="size-3 text-success" strokeWidth={2} />
    </span>
  );
}

function ChecksDot({
  checksStatus,
}: {
  readonly checksStatus: 'success' | 'failure' | 'pending' | 'none';
}) {
  if (checksStatus === 'none') return null;
  if (checksStatus === 'success') {
    return (
      <span title="Checks passing">
        <CircleCheck aria-hidden="true" className="size-3 text-success" strokeWidth={2} />
      </span>
    );
  }
  if (checksStatus === 'failure') {
    return (
      <span title="Checks failing">
        <CircleX aria-hidden="true" className="size-3 text-danger" strokeWidth={2} />
      </span>
    );
  }
  return (
    <span title="Checks running">
      <Loader2 aria-hidden="true" className="size-3 animate-spin text-warning" strokeWidth={2} />
    </span>
  );
}
