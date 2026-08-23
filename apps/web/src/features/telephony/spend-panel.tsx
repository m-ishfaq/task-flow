import { useQuery } from '@tanstack/react-query';
import { formatCents } from '../../lib/format.js';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
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
  /* Phase 10 Wave 4 (§5.5) — the automation-attributed kinds. Separate rows so
     a reader can see what the rules are costing without doing the addition. */
  ['automation_call', 'Automation calls'],
  ['automation_sms', 'Automation SMS'],
]);

export function SpendPanel({ orgId }: { readonly orgId: string }) {
  const current = useQuery(spendCurrentQuery(orgId));
  const report = useQuery(spendReportQuery(orgId, SINCE_DAYS));

  const spentCents = current.data?.spentCents;
  const capCents = current.data?.capCents;
  const ratio = capCents === undefined || capCents === 0 ? 0 : (spentCents ?? 0) / capCents;
  const over = ratio > 1;

  /* The automation sub-budget (§5.5): the org's separate ceiling for what a
     RULE may spend, checked IN ADDITION to the org cap. Null means the org has
     configured no separate ceiling — the org cap alone bounds automation — and
     the section is hidden entirely: a rule's spend still appears in the report
     below, so nothing is invisible, and a phantom bar saying “no ceiling”
     would be noise. */
  const automationCapCents = current.data?.automationCapCents ?? null;
  const automationSpentCents = current.data?.automationSpentCents ?? 0;
  const automationRatio =
    automationCapCents === null || automationCapCents === 0
      ? 0
      : automationSpentCents / automationCapCents;
  const automationOver = automationRatio > 1;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-ink">This organization's spend</h2>
        </div>

        {current.isPending ? (
          <SkeletonRows rows={1} />
        ) : current.isError ? (
          <ErrorView error={current.error} title="Could not load spend" />
        ) : (
          <div className="rounded-lg border border-line bg-surface-raised p-4">
            <div className="flex items-baseline gap-2">
              <p className="text-2xl font-semibold text-ink">{formatCents(spentCents ?? 0)}</p>
              <p className="text-xs text-ink-muted">
                of {formatCents(capCents ?? 0)} cap · rolling 30 days
              </p>
              <span
                className={cn(
                  'ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium',
                  over
                    ? 'bg-danger/15 text-danger'
                    : ratio > 0.8
                      ? 'bg-warning/15 text-warning'
                      : 'bg-success/15 text-success',
                )}
              >
                {over ? 'Cap reached' : `${String(Math.round(ratio * 100))}% used`}
              </span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={Math.min(Math.round(ratio * 100), 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Spend against cap"
              className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
            >
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  over ? 'bg-danger' : ratio > 0.8 ? 'bg-warning' : 'bg-accent',
                )}
                style={{ width: `${String(Math.min(ratio * 100, 100))}%` }}
              />
            </div>

            {automationCapCents !== null && (
              /* The sub-budget is the same shape as the org cap, one level
                 down — same figures that `checkOutboundAllowed` enforces
                 against (`readSpendState` feeds both), so what this bar shows
                 and what a rule's refusal cites cannot drift. */
              <div className="mt-3 border-t border-line/60 pt-2.5">
                <div className="flex items-baseline gap-2">
                  <p className="text-[11px] font-medium text-ink-muted">Automation allowance</p>
                  <p className="text-[11px] text-ink-faint">
                    {formatCents(automationSpentCents)} of {formatCents(automationCapCents)} · rules
                    only, in addition to the org cap
                  </p>
                  <span
                    className={cn(
                      'ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium',
                      automationOver
                        ? 'bg-danger/15 text-danger'
                        : automationRatio > 0.8
                          ? 'bg-warning/15 text-warning'
                          : 'bg-surface-sunken text-ink-faint',
                    )}
                  >
                    {automationOver
                      ? 'Allowance reached'
                      : `${String(Math.round(automationRatio * 100))}% used`}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-valuenow={Math.min(Math.round(automationRatio * 100), 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Automation spend against allowance"
                  className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-sunken"
                >
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      automationOver
                        ? 'bg-danger'
                        : automationRatio > 0.8
                          ? 'bg-warning'
                          : 'bg-accent',
                    )}
                    style={{ width: `${String(Math.min(automationRatio * 100, 100))}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-ink">
            Cost attribution — last {String(SINCE_DAYS)} days
          </h2>
        </div>

        {report.isPending ? (
          <SkeletonRows rows={3} />
        ) : report.isError ? (
          <ErrorView error={report.error} title="Could not load the itemized report" />
        ) : report.data.length === 0 ? (
          <Empty
            title="No spend recorded in this window"
            description="Place a call or send an SMS to see it itemized here."
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-line/50">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-line bg-surface-raised text-ink-faint">
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 text-right font-medium">Count</th>
                  <th className="px-3 py-2 text-right font-medium">Estimated</th>
                  <th className="px-3 py-2 text-right font-medium">Billed</th>
                </tr>
              </thead>
              <tbody className="bg-surface">
                {report.data.map((row) => (
                  <tr
                    key={row.kind}
                    className="border-b border-line/60 text-ink transition-colors last:border-b-0 hover:bg-surface-hover"
                  >
                    <td className="px-3 py-2">{KIND_LABELS.get(row.kind) ?? row.kind}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.count}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCents(row.estimatedCents)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCents(row.billedCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
