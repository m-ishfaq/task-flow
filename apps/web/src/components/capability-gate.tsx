import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useSession } from '../lib/session.js';
import { orgDetailQuery, type SettingsCapabilities } from '../features/org/api.js';

/**
 * Renders `children` when the caller holds `capability`, and a plain "not
 * for your role" page otherwise — the route-level half of the fix
 * `sidebar.tsx`'s own `capability` field applies to nav links. Without this,
 * hiding the sidebar link was not enough: a direct URL, a bookmark, or the
 * browser's back button still reached the real page, which then tried to
 * load its data and surfaced a raw FORBIDDEN with a request-id reference —
 * technically correct and a poor way for a Member to learn a page is not
 * for them.
 *
 * Distinct from `FeatureGate` on purpose, not a shared `flag`/`capability`
 * union prop on one component. `FeatureGate` gates a PLAN entitlement — an
 * org's own money can turn it on, so a locked module with an upgrade link is
 * the honest, sellable state. A capability like `analytics:read` is
 * Admin-and-Owner-only by ROLE; no plan purchase ever changes what a
 * Member's role grants, so an upgrade CTA here would point at a door money
 * cannot open. Same reasoning `org.service.ts`'s `viewAnalytics`/
 * `viewAutomations` comment gives for why the sidebar treats the two
 * differently.
 *
 * This is still a COSMETIC gate, not the authorization decision — the same
 * reasoning `FeatureGate`'s own doc comment gives: every route behind this
 * still declares its own `permission` and the server re-resolves it on every
 * request regardless of what this component decided, so a stale or wrong
 * capability snapshot here costs a wrongly-shown "not for your role" page,
 * never wrongly-granted access. Reading one pre-computed boolean the server
 * already decided (`can()`, via `tenancy.orgs.get`) is not the same act as
 * the UI computing a role decision itself.
 */
export function CapabilityGate({
  capability,
  children,
}: {
  readonly capability: keyof SettingsCapabilities;
  readonly children: ReactNode;
}) {
  const orgId = useSession((state) => state.orgId);
  const org = useQuery({ ...orgDetailQuery(orgId ?? ''), enabled: orgId !== null });

  // Undefined (not yet loaded) renders nothing, same as `FeatureGate` — a
  // flash of "not for your role" immediately replaced by the real page is
  // worse than a brief blank beat.
  if (org.data === undefined) return null;
  if (org.data.capabilities[capability]) return <>{children}</>;

  return <NotForYourRole />;
}

function NotForYourRole() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-surface-hover text-ink-faint">
          <Lock className="size-6" strokeWidth={2} />
        </span>
        <div>
          <p className="text-sm font-semibold text-ink">This isn’t part of your role</p>
          <p className="mt-1.5 text-sm text-ink-muted">
            An admin or owner can grant you access, or you can ask them to make this change for you.
          </p>
        </div>
      </div>
    </div>
  );
}
