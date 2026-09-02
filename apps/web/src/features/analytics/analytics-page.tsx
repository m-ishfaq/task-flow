import { useNavigate, useSearch } from '@tanstack/react-router';
import { useSession } from '../../lib/session.js';
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
 */

const TABS = [
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
  const tab = useSearch({ from: '/analytics', select: (value) => value.tab }) ?? 'velocity';

  const selectTab = (next: TabId) => {
    void navigate({ to: '/analytics', search: { tab: next } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line/50 px-4 pt-4 pb-2">
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
          Analytics
        </h1>
        <nav className="mt-2 flex gap-1 overflow-x-auto" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => selectTab(t.id)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'bg-accent/10 text-accent'
                  : 'text-ink/60 hover:bg-surface-hover hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="flex-1 overflow-auto p-4">
        {tab === 'velocity' && <VelocityPanel orgId={orgId} />}
        {tab === 'burndown' && <BurndownPanel orgId={orgId} />}
        {tab === 'cfd' && <CfdPanel orgId={orgId} />}
        {tab === 'cycle-time' && <CycleTimePanel orgId={orgId} />}
        {tab === 'workload' && <WorkloadPanel orgId={orgId} />}
        {tab === 'volume' && <VolumePanel orgId={orgId} />}
        {tab === 'status' && <StatusPanel />}
      </div>
    </div>
  );
}
