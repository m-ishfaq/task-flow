import { countRows, gte, schema, sumColumn, sumWithFallback, withOrgScope } from '@taskflow/db';
import type { OrgId, OutboundKind } from '@taskflow/contracts';

/**
 * Per-org cost attribution (ai/phase-7-voice.md §5, Wave 4 — "the full
 * call/message log with per-org cost attribution reporting ... admin-facing
 * spend visibility").
 *
 * Reads the SAME `comms.spend_ledger` rows the outbound gate sums, rather
 * than a second table computed from it — the identical reasoning
 * `readSpendState` gives for being split out of `checkOutboundAllowed`: one
 * place computes the arithmetic, so the number an admin is SHOWN and the
 * number the cap ENFORCES cannot drift apart. This groups those rows by
 * `kind`; it does not reinterpret them.
 *
 * `billedCents` is `COALESCE(actual, estimated)` per row, summed — never
 * `SUM(actual)` — for the exact reason `sumWithFallback`'s own comment
 * gives: a ledger row the carrier has not billed yet has a NULL
 * `actual_cents`, and summing that column alone would report it as free
 * rather than at its conservative estimate. That understates spend on
 * exactly the entries a report is most likely to be read about — the ones
 * from the last few minutes.
 */

export interface SpendReportRow {
  readonly kind: OutboundKind;
  readonly count: number;
  readonly estimatedCents: number;
  readonly billedCents: number;
}

export async function spendReport(
  orgId: OrgId,
  input: { readonly sinceDays: number },
): Promise<readonly SpendReportRow[]> {
  const since = new Date(Date.now() - input.sinceDays * 24 * 60 * 60 * 1000);

  const rows = await withOrgScope(orgId, async (tx) =>
    tx
      .select({
        kind: schema.spendLedger.kind,
        count: countRows(schema.spendLedger.id),
        estimatedCents: sumColumn(schema.spendLedger.estimatedCents),
        billedCents: sumWithFallback(
          schema.spendLedger.actualCents,
          schema.spendLedger.estimatedCents,
        ),
      })
      .from(schema.spendLedger)
      .where(gte(schema.spendLedger.occurredAt, since))
      .groupBy(schema.spendLedger.kind),
  );

  /* Parsed explicitly, same as `readSpendState` — a Postgres `bigint`
     aggregate arrives as a string, and `Number(undefined)` is `NaN`, which a
     careless render would show as "NaN cents" rather than fail loudly. */
  return rows.map((row) => ({
    kind: row.kind as OutboundKind,
    count: Math.max(0, Number.parseInt(row.count, 10) || 0),
    estimatedCents: Math.max(0, Number.parseInt(row.estimatedCents, 10) || 0),
    billedCents: Math.max(0, Number.parseInt(row.billedCents, 10) || 0),
  }));
}
