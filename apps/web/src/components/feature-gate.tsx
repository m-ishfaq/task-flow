import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Lock } from 'lucide-react';
import { useFeatureGranted } from '../lib/entitlements.js';
import { featureDescription, featureLabel } from '../lib/feature-labels.js';

/**
 * Renders `children` when the selected org's plan grants `flag`, and a
 * locked-module page otherwise — the client-side half of the fix for
 * "the sidebar linked to Calls, the org was on Free, and the only thing that
 * ever said so was an error toast after the page tried to load its data."
 *
 * Wraps a ROUTE's component (`router.tsx`), not a query result — this catches
 * a direct URL/bookmark to a gated page exactly the same way clicking a
 * locked sidebar item does, one component instead of a check duplicated into
 * every gated page.
 *
 * This is a cosmetic gate, same as the sidebar's own locked state
 * (`sidebar.tsx`'s `useFeatureGranted` usage) — `useEntitlements`'s own doc
 * comment says why that is fine: the server re-resolves the same entitlement
 * on every gated route regardless of what this component decided, so a stale
 * or wrong snapshot here costs a wrongly-shown page, never wrongly-granted
 * access. That is also why this does NOT follow §8.2's "never re-derive
 * authorization" rule the way a permission check would — a plan is not a
 * permission, and unlike a hidden button for a role the caller lacks, a
 * locked-but-visible module with an upgrade path is the whole point of a
 * paid tier existing at all.
 *
 * Renders nothing (not a flash of the locked state) while the snapshot is
 * still loading — `useFeatureGranted` returns `undefined` for that case
 * specifically so this can tell "not yet known" from "known false" apart.
 */
export function FeatureGate({
  flag,
  children,
}: {
  readonly flag: string;
  readonly children: ReactNode;
}) {
  const granted = useFeatureGranted(flag);

  if (granted === undefined) return null;
  if (granted) return <>{children}</>;

  return <LockedFeature flag={flag} />;
}

function LockedFeature({ flag }: { readonly flag: string }) {
  const label = featureLabel(flag);
  const description = featureDescription(flag);

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Lock className="size-6" strokeWidth={2} />
        </span>
        <div>
          <p className="text-sm font-semibold text-ink">{label} isn’t on your plan</p>
          <p className="mt-1.5 text-sm text-ink-muted">
            {description ?? `Your current plan doesn't include ${label}.`} An owner can upgrade from
            Billing settings to turn it on.
          </p>
        </div>
        <Link
          to="/settings"
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-colors duration-(--motion-fast) hover:bg-accent-hover"
        >
          View plans
        </Link>
      </div>
    </div>
  );
}
