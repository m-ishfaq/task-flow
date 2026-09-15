import { useQuery } from '@tanstack/react-query';
import { formatCents } from '../../lib/format.js';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
import { orgDetailQuery } from '../org/api.js';
import { spendCurrentQuery, spendReportQuery } from './api.js';

/**
 * Spend visibility (ai/phase-7-voice.md §3.3-3.4, Wave 4's cost-attribution
 * half).
 *
 * Two different reads, deliberately not merged: "current" is
 * `phoneNumber:read` (Member) — the same figure `checkOutboundAllowed`
 * enforces against, via `readSpendState` rather than the full gate, so
 * looking at this page never consumes the viewer's own velocity budget
 * (`spend-gate.ts`'s own comment). "report" is `recording:read`
 * (Admin-and-Owner only by role, no tuple, no member grant) — the itemized
 * breakdown by kind. Gated on `capabilities.readRecordings` (Phase 15 §1's
 * sweep, the same field `recording-section.tsx` reads) rather than shown
 * unconditionally and left to answer FORBIDDEN.
 */

const SINCE_DAYS = 30;

type GaugeTone = 'ok' | 'warning' | 'danger';

function toneOf(ratio: number): GaugeTone {
  if (ratio > 1) return 'danger';
  if (ratio > 0.8) return 'warning';
  return 'ok';
}

/* The bar's own tone-to-fill map, richer than a flat color: a gradient
   reads with more depth than a single hue, and `danger` additionally
   glows via `shadow-glow-danger` (styles.css) — a new sibling to
   `--shadow-glow-accent`, since this is the moment the meter is actively
   trying to get someone's attention. Warm-dark rebuild's own
   Voice & Messaging module pass (ai/design-rebuild-warm-dark.md §5). */
const GAUGE_FILL: Readonly<Record<GaugeTone, string>> = {
  ok: 'bg-gradient-to-r from-accent/80 to-accent',
  warning: 'bg-gradient-to-r from-warning/80 to-warning',
  danger: 'bg-gradient-to-r from-danger/80 to-danger shadow-glow-danger',
};

/**
 * The fill bar half of a spend meter — extracted, along with `SpendBadge`
 * below, from two near-identical blocks that had grown genuinely
 * duplicated in this file (the org cap, and the automation sub-budget one
 * level down). `height` is the one real difference between the two:
 * the automation bar sits one level down, visually subordinate to the org
 * cap bar above it.
 */
function SpendGaugeBar({
  ratio,
  ariaLabel,
  height = 'normal',
}: {
  readonly ratio: number;
  readonly ariaLabel: string;
  readonly height?: 'normal' | 'thin';
}) {
  const tone = toneOf(ratio);
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.min(Math.round(ratio * 100), 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
      className={cn(
        'overflow-hidden rounded-full bg-surface-sunken',
        height === 'thin' ? 'h-1.5' : 'h-2.5',
      )}
    >
      <div
        className={cn('h-full rounded-full transition-all duration-500 ease-out', GAUGE_FILL[tone])}
        style={{ width: `${String(Math.min(ratio * 100, 100))}%` }}
      />
    </div>
  );
}

/**
 * The percentage badge half of a spend meter (see `SpendGaugeBar` above
 * for the fill bar half, and why both were extracted). `healthyTone`
 * differs only for the automation sub-budget: it reads `neutral` rather
 * than `success` while healthy, since it is "in addition to the org cap"
 * (its own caller's comment) — a secondary figure whose good news is
 * already covered by the org cap badge above it, not a second "all clear"
 * worth repeating in green.
 */
function SpendBadge({
  ratio,
  reachedLabel,
  healthyTone = 'success',
}: {
  readonly ratio: number;
  readonly reachedLabel: string;
  readonly healthyTone?: 'success' | 'neutral';
}) {
  const tone = toneOf(ratio);
  return (
    <span
      className={cn(
        'ml-auto rounded-full px-2.5 py-1 text-[11px] font-medium whitespace-nowrap',
        tone === 'danger'
          ? 'bg-danger/15 text-danger'
          : tone === 'warning'
            ? 'bg-warning/15 text-warning'
            : healthyTone === 'success'
              ? 'bg-success/15 text-success'
              : 'bg-surface-sunken text-ink-faint',
      )}
    >
      {tone === 'danger' ? reachedLabel : `${String(Math.round(ratio * 100))}% used`}
    </span>
  );
}

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
  const canReadRecordings =
    useQuery(orgDetailQuery(orgId)).data?.capabilities.readRecordings === true;
  const report = useQuery({ ...spendReportQuery(orgId, SINCE_DAYS), enabled: canReadRecordings });

  const spentCents = current.data?.spentCents;
  const capCents = current.data?.capCents;
  const ratio = capCents === undefined || capCents === 0 ? 0 : (spentCents ?? 0) / capCents;

  /* The automation sub-budget (§5.5): the org's separate ceiling for what a
     RULE may spend, checked IN ADDITION to the org cap. Null means the org has
     configured no separate ceiling — the org cap alone bounds automation — and
     the section is hidden entirely: a rule's spend still appears in the report
     below, so nothing is invisible, and a phantom bar saying "no ceiling"
     would be noise. */
  const automationCapCents = current.data?.automationCapCents ?? null;
  const automationSpentCents = current.data?.automationSpentCents ?? 0;
  const automationRatio =
    automationCapCents === null || automationCapCents === 0
      ? 0
      : automationSpentCents / automationCapCents;

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
          <div className="rounded-lg border border-line bg-surface-raised p-5">
            <div className="flex items-baseline gap-3">
              <p className="text-3xl font-semibold tabular-nums tracking-tight text-ink">
                {formatCents(spentCents ?? 0)}
              </p>
              <p className="text-xs text-ink-muted">
                of {formatCents(capCents ?? 0)} cap · rolling 30 days
              </p>
              <SpendBadge ratio={ratio} reachedLabel="Cap reached" />
            </div>
            <div className="mt-4">
              <SpendGaugeBar ratio={ratio} ariaLabel="Spend against cap" />
            </div>

            {automationCapCents !== null && (
              /* The sub-budget is the same shape as the org cap, one level
                 down — same figures that `checkOutboundAllowed` enforces
                 against (`readSpendState` feeds both), so what this bar shows
                 and what a rule's refusal cites cannot drift. */
              <div className="mt-4 border-t border-line/60 pt-3">
                <div className="flex items-baseline gap-2">
                  <p className="text-[11px] font-medium text-ink-muted">Automation allowance</p>
                  <p className="text-[11px] text-ink-faint">
                    {formatCents(automationSpentCents)} of {formatCents(automationCapCents)} · rules
                    only, in addition to the org cap
                  </p>
                  <SpendBadge
                    ratio={automationRatio}
                    reachedLabel="Allowance reached"
                    healthyTone="neutral"
                  />
                </div>
                <div className="mt-2">
                  <SpendGaugeBar
                    ratio={automationRatio}
                    ariaLabel="Automation spend against allowance"
                    height="thin"
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {canReadRecordings && (
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
            <div className="overflow-hidden rounded-lg border border-line/50 bg-surface-raised">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-line bg-surface-raised text-ink-faint">
                    <th className="px-4 py-2.5 font-medium">Kind</th>
                    <th className="px-4 py-2.5 text-right font-medium">Count</th>
                    <th className="px-4 py-2.5 text-right font-medium">Estimated</th>
                    <th className="px-4 py-2.5 text-right font-medium">Billed</th>
                  </tr>
                </thead>
                <tbody className="bg-surface">
                  {report.data.map((row, index) => (
                    <tr
                      key={row.kind}
                      className={cn(
                        'border-b border-line/60 text-ink transition-colors last:border-b-0 hover:bg-surface-hover',
                        index % 2 === 1 && 'bg-surface-raised/30',
                      )}
                    >
                      <td className="px-4 py-2.5 font-medium">
                        {KIND_LABELS.get(row.kind) ?? row.kind}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{row.count}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatCents(row.estimatedCents)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                        {formatCents(row.billedCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
