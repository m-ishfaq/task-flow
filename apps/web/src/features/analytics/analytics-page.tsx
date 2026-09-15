import { useNavigate, useSearch } from '@tanstack/react-router';
import { useSession } from '../../lib/session.js';
import { PageHeader, TabBar } from '../../components/primitives.js';
import { VelocityPanel } from './velocity-panel.js';
import { BurndownPanel } from './burndown-panel.js';
import { CfdPanel } from './cfd-panel.js';
import { CycleTimePanel } from './cycle-time-panel.js';
import { WorkloadPanel } from './workload-panel.js';
import { VolumePanel } from './volume-panel.js';
import { StatusPanel } from './status-panel.js';

/**
 * Analytics dashboards (Phase 11, ai/phase-11-analytics.md §3, §5).
 *
 * Six fixed dashboards over the transitions projection, plus a status
 * panel showing rollup freshness. Admin-and-Owner only — the server
 * enforces this via `analytics:read`; the UI shows the page to everyone
 * and lets the server refuse, per §8.2.
 *
 * Tab-based navigation (same pattern as telephony-page.tsx): a search
 * param rather than nested routes, so the open tab is shareable and
 * back-button-correct. The tab row itself is `primitives.tsx`'s shared
 * `TabBar` (moved there during the warm-dark rebuild's own component-
 * consolidation pass, `ai/design-rebuild-warm-dark.md` §3) rather than a
 * hand-rolled `role="tablist"` — this page's own version had drifted from
 * platform-admin's copy in exactly the small ways duplication always drifts
 * (a template-literal className instead of `cn()`, `text-ink/60` instead of
 * the shared `text-ink-muted`, no `shadow-sm ring-1 ring-accent/20` on the
 * active tab).
 *
 * Header uses `PageHeader` to match the consistent page-title pattern
 * across People, Calls, and Analytics — large bold title, optional
 * description, same spacing.
 */

const TABS = [
  { value: 'velocity', label: 'Velocity' },
  { value: 'burndown', label: 'Burndown' },
  { value: 'cfd', label: 'Flow' },
  { value: 'cycle-time', label: 'Cycle Time' },
  { value: 'workload', label: 'Workload' },
  { value: 'volume', label: 'Volume' },
  { value: 'status', label: 'Status' },
] as const;

type TabId = (typeof TABS)[number]['value'];

export function AnalyticsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();
  const tab = useSearch({ from: '/analytics', select: (value) => value.tab }) ?? 'velocity';

  const selectTab = (next: TabId) => {
    void navigate({ to: '/analytics', search: { tab: next } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line/50 px-4 pt-4 pb-2">
        <PageHeader
          title="Analytics"
          description="Velocity, burndown, flow metrics, and more — see how your projects are progressing."
        />
        <TabBar
          ariaLabel="Analytics dashboards"
          value={tab}
          onChange={selectTab}
          className="mt-3 flex overflow-x-auto"
          items={TABS}
        />
      </header>

      <div className="flex-1 overflow-auto p-4">
        {tab === 'velocity' && <VelocityPanel />}
        {tab === 'burndown' && <BurndownPanel orgId={orgId} />}
        {tab === 'cfd' && <CfdPanel orgId={orgId} />}
        {tab === 'cycle-time' && <CycleTimePanel />}
        {tab === 'workload' && <WorkloadPanel />}
        {tab === 'volume' && <VolumePanel />}
        {tab === 'status' && <StatusPanel />}
      </div>
    </div>
  );
}
