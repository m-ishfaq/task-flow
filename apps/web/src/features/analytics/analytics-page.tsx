import { useNavigate, useSearch } from '@tanstack/react-router';
import { BarChart3 } from 'lucide-react';
import { useSession } from '../../lib/session.js';
import { PageHeader } from '../../components/primitives.js';
import { OverviewPanel } from './overview-panel.js';
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
 * back-button-correct.
 *
 * `Overview` (Design Bible §10) is a new, DEFAULT first tab — a single-page
 * summary (a KPI row + the velocity chart, then Burndown and Workload side
 * by side) composed from the same panels the other tabs already show in
 * full. Additive, not a replacement: every dashboard that existed before it
 * is still one click away, unchanged, for anyone who wants one metric's own
 * full-width view. See `overview-panel.tsx`'s own header for what each KPI
 * tile actually measures and why.
 */

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'velocity', label: 'Velocity' },
  { id: 'burndown', label: 'Burndown' },
  { id: 'cfd', label: 'Flow' },
  { id: 'cycle-time', label: 'Cycle Time' },
  { id: 'workload', label: 'Workload' },
  { id: 'volume', label: 'Volume' },
  { id: 'status', label: 'Status' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function AnalyticsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();
  const tab = useSearch({ from: '/analytics', select: (value) => value.tab }) ?? 'overview';

  const selectTab = (next: TabId) => {
    void navigate({ to: '/analytics', search: { tab: next } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line/50 px-4 pt-4 pb-2">
        <PageHeader
          title="Analytics"
          description="KPIs and charts over the transitions projection — velocity, burndown, flow, and where the org's effort is going."
          icon={<BarChart3 aria-hidden="true" className="size-4" strokeWidth={2.25} />}
        />
        <div className="mt-3 flex gap-1 overflow-x-auto" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => {
                selectTab(t.id);
              }}
              className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                tab === t.id
                  ? 'bg-accent/10 text-accent'
                  : 'text-ink-faint hover:bg-surface-hover hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4">
        {tab === 'overview' && <OverviewPanel orgId={orgId} />}
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
