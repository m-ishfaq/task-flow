import { useQuery } from '@tanstack/react-query';
import { formatCents } from '../../lib/format.js';
import { Empty, Section, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { spendCurrentQuery, spendReportQuery } from './api.js';

/**
 * Spend visibility (ai/phase-7-voice.md §3.3-3.4, Wave 4's cost-attribution
 * half).
 *
 * Two different reads, deliberately not merged: "current" is
 * `phoneNumber:read` (Member) — the same figure `checkOutboundAllowed`
 * enforces against, via `readSpendState` rather than the full gate, so
 * looking at this page never consumes the viewer's own velocity budget
 * (`spend-gate.ts`'s own comment). "report" is `recording:read` (Admin) —
 * the itemized breakdown by kind. A Member sees the first card and a
 * FORBIDDEN, rendered as an ordinary error, on the second — not a hidden
 * section.
 */

const SINCE_DAYS = 30;

const KIND_LABELS: ReadonlyMap<string, string> = new Map([
  ['call', 'Calls'],
  ['sms', 'SMS'],
  ['number_purchase', 'Number purchases'],
  ['verification', 'Verification'],
]);

export function SpendPanel({ orgId }: { readonly orgId: string }) {
  const current = useQuery(spendCurrentQuery(orgId));
  const report = useQuery(spendReportQuery(orgId, SINCE_DAYS));

  return (
    <div className="space-y-6">
      <Section title="This organization's spend">
        {current.isPending ? (
          <SkeletonRows rows={1} />
        ) : current.isError ? (
          <ErrorView error={current.error} title="Could not load spend" />
        ) : (
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-semibold text-ink">
              {formatCents(current.data.spentCents)}
            </p>
            <p className="text-xs text-ink-muted">of {formatCents(current.data.capCents)} cap</p>
          </div>
        )}
      </Section>

      <Section title={`Cost attribution — last ${String(SINCE_DAYS)} days`}>
        {report.isPending ? (
          <SkeletonRows rows={3} />
        ) : report.isError ? (
          <ErrorView error={report.error} title="Could not load the itemized report" />
        ) : report.data.length === 0 ? (
          <Empty title="No spend recorded in this window" />
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line text-ink-faint">
                <th className="py-1.5 font-medium">Kind</th>
                <th className="py-1.5 text-right font-medium">Count</th>
                <th className="py-1.5 text-right font-medium">Estimated</th>
                <th className="py-1.5 text-right font-medium">Billed</th>
              </tr>
            </thead>
            <tbody>
              {report.data.map((row) => (
                <tr key={row.kind} className="border-b border-line/60 text-ink">
                  <td className="py-1.5">{KIND_LABELS.get(row.kind) ?? row.kind}</td>
                  <td className="py-1.5 text-right">{row.count}</td>
                  <td className="py-1.5 text-right">{formatCents(row.estimatedCents)}</td>
                  <td className="py-1.5 text-right">{formatCents(row.billedCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
