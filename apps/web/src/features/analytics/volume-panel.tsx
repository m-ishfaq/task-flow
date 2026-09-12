import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { volumeQuery } from './api.js';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/**
 * §3.6 — Volume: messages, calls, and in-app calls per day.
 *
 * Renders no title of its own — `overview-panel.tsx`'s `DashboardCard`
 * supplies it now that the standalone Volume tab is gone.
 */
export function VolumePanel() {
  const [days] = useState(30);
  const { start, end } = useMemo(() => {
    const e = new Date();
    const s = new Date();
    s.setDate(s.getDate() - days);
    return { start: s, end: e };
  }, [days]);

  const { data, isLoading, error } = useQuery(volumeQuery(start, end));

  if (error) return <ErrorView error={error} />;
  if (isLoading) return <SkeletonRows rows={5} />;

  const points = data ?? [];
  if (points.length === 0) {
    return (
      <Empty
        title="No volume data"
        description="Messages and calls will appear here once activity begins."
      />
    );
  }

  const totalMessages = points.reduce((s, p) => s + p.messages, 0);
  const totalCalls = points.reduce((s, p) => s + p.calls, 0);
  const totalInApp = points.reduce((s, p) => s + p.inAppCalls, 0);
  const totalDuration = points.reduce((s, p) => s + p.callDurationMinutes, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Messages" value={String(totalMessages)} />
        <StatCard label="PSTN Calls" value={String(totalCalls)} />
        <StatCard label="In-App Calls" value={String(totalInApp)} />
        <StatCard label="Call Minutes" value={Math.round(totalDuration).toString()} />
      </div>

      {/* Recent daily breakdown */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line/50 text-left text-ink/50">
              <th className="pb-1 font-medium">Date</th>
              <th className="pb-1 font-medium">Messages</th>
              <th className="pb-1 font-medium">Calls</th>
              <th className="pb-1 font-medium">In-App</th>
            </tr>
          </thead>
          <tbody>
            {points
              .filter((p) => p.messages > 0 || p.calls > 0 || p.inAppCalls > 0)
              .slice(-14)
              .map((p) => (
                <tr key={p.date} className="border-b border-line/30">
                  <td className="py-1 text-ink/60">{p.date}</td>
                  <td className="py-1">{p.messages}</td>
                  <td className="py-1">{p.calls}</td>
                  <td className="py-1">{p.inAppCalls}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-lg border border-line/50 p-3">
      <div className="text-xs text-ink/50">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
    </div>
  );
}
