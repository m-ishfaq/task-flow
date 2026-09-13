import { BarChart3 } from 'lucide-react';
import { useSession } from '../../lib/session.js';
import { PageHeader } from '../../components/primitives.js';
import { OverviewPanel } from './overview-panel.js';

/**
 * Analytics: one consolidated dashboard (Phase 11, ai/phase-11-analytics.md
 * §3, §5; Design Bible §10).
 *
 * REDESIGNED — this page used to be seven per-metric tabs (Velocity,
 * Burndown, Flow, Cycle Time, Workload, Volume, Status) plus a separate
 * "Overview" summary tab in front of them. Reported back directly against
 * a screenshot: the bible shows every metric on ONE screen, not a tab
 * strip, and that Overview tab was itself still fragmenting the other six
 * away from it. There is no tab strip here anymore — `OverviewPanel` is the
 * entire page, and every one of the seven dashboards is a section on it.
 * See `overview-panel.tsx`'s own header for the full account of what moved
 * where and why.
 *
 * Admin-and-Owner only — the server enforces this via `analytics:read`;
 * this page renders for everyone the route lets through and lets the
 * server refuse per §8.2 (`CapabilityGate`/`FeatureGate` wrap the route
 * itself in `router.tsx`, before this component ever mounts).
 */
export function AnalyticsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line/50 px-4 pt-4 pb-2">
        <PageHeader
          title="Analytics"
          description="Velocity, burndown, flow, workload, and activity — every metric on one screen."
          icon={<BarChart3 aria-hidden="true" className="size-4" strokeWidth={2.25} />}
        />
      </header>

      <div className="flex-1 overflow-auto p-4">
        <OverviewPanel orgId={orgId} />
      </div>
    </div>
  );
}
