import { eq, schema, withPlatformAdminScope } from '@taskflow/db';
import { createEvent, type EventBus } from '@taskflow/events';
import { FLAGS, FLAG_NAMES, type FlagName } from '@taskflow/feature-flags';
import { SYSTEM_ORG } from '../identity/identity.service.js';
import { buildFlags } from './flag-evaluator.js';
import { flagOverrideCleared, flagOverrideSet } from './events.js';
import { recordOperatorAction } from './audit.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * Feature-flag overrides — the store the evaluator never had
 * (ai/phase-12-admin.md §3.8).
 *
 * `packages/feature-flags`' evaluator resolves per-org overrides from an
 * input it expects a caller to load; nothing persisted a set override
 * anywhere. `platform.flag_overrides` is this wave's deliberately narrow
 * first cut: a single GLOBAL table, no per-org row shape yet.
 *
 * ## What this does, and where the resolution lives
 *
 * A row here changes what every organization resolves until the override is
 * reset. Since 2026-08-09 the resolution goes through the REAL evaluator
 * (`flag-evaluator.ts`): `listFlags` builds a `FeatureFlags` instance with
 * this table's rows merged into the env tier and reads each flag's value
 * from it — the store finally feeds `FeatureFlags.evaluate()`, and the
 * evaluator's precedence (environment beats default, with overrides in the
 * environment tier) is the single source of truth rather than the inline
 * `override ?? default` this file used to reimplement. The client snapshot
 * route (`flags.snapshot`) serves the same evaluator, cached, to the web
 * bootstrap. The per-org tier stays unused until per-org targeting exists.
 */

export interface FlagRow {
  readonly flagName: string;
  readonly description: string;
  readonly phase: number;
  readonly perOrg: boolean;
  readonly defaultValue: boolean;
  readonly value: boolean;
  readonly source: 'override' | 'default';
  readonly overrideSetAt: Date | null;
}

/** Every registry flag, with its resolved value and where it came from. */
export async function listFlags(operator: PlatformOperator): Promise<readonly FlagRow[]> {
  const overrides = await withPlatformAdminScope(async (tx) =>
    tx.select().from(schema.flagOverrides),
  );

  await recordOperatorAction(operator.userId, 'flags.list', null);

  /* Resolved from the real evaluator built on THIS read's rows (fresh even
     immediately after a toggle), not the shared cache — the tab must never
     show a value the operator just changed. `source` stays store-driven: it
     answers "is there an override row?" for display, which is a question
     about the store, while the VALUE is the evaluator's answer. */
  const evaluator = buildFlags(overrides);

  return FLAG_NAMES.map((flagName) => {
    const definition = FLAGS[flagName];
    const override = overrides.find((row) => row.flagName === flagName);
    return {
      flagName,
      description: definition.description,
      phase: definition.phase,
      perOrg: definition.perOrg,
      defaultValue: definition.defaultValue,
      value: evaluator.isEnabled(flagName),
      source: override === undefined ? ('default' as const) : ('override' as const),
      overrideSetAt: override?.updatedAt ?? null,
    };
  });
}

/**
 * Sets, clears, or changes a global override.
 *
 * `value: null` deletes the row, falling back to the environment/registry
 * precedence. The primary key makes the upsert idempotent — two operators
 * racing on the same flag settle on the last writer, which is exactly the
 * resolution a single-row-per-flag store should have.
 */
export async function setFlag(
  deps: { readonly events: EventBus },
  operator: PlatformOperator,
  input: { readonly flagName: FlagName; readonly value: boolean | null },
): Promise<{ readonly flagName: FlagName; readonly value: boolean | null }> {
  const now = new Date();

  await withPlatformAdminScope(async (tx) => {
    if (input.value === null) {
      await tx
        .delete(schema.flagOverrides)
        .where(eq(schema.flagOverrides.flagName, input.flagName));
    } else {
      await tx
        .insert(schema.flagOverrides)
        .values({
          flagName: input.flagName,
          value: input.value,
          setBy: operator.userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.flagOverrides.flagName,
          set: { value: input.value, setBy: operator.userId, updatedAt: now },
        });
    }
  });

  /* Clearing is its own action in both records, though one route produces
     both. `null` means the override ROW IS GONE and the flag falls back to
     its compiled default — a different fact from "the override says false",
     with different consequences for anyone later reconstructing why a flag
     behaved as it did. A null in a `flags.set` payload technically carries
     that, but only to a reader who knows to interpret it. */
  const clearing = input.value === null;

  await recordOperatorAction(operator.userId, clearing ? 'flags.clear' : 'flags.set', {
    flagName: input.flagName,
    value: input.value,
  });

  /* Guardrail 11, and the flag-governance record (see events.ts's header for
     why the bus carries the SYSTEM_ORG envelope — flag overrides are global,
     true of every org, like the table they live in). */
  const envelope = {
    orgId: SYSTEM_ORG,
    actorId: operator.userId,
    requestId: operator.requestId,
    occurredAt: now,
  };

  await deps.events.publish([
    clearing
      ? createEvent(
          flagOverrideCleared,
          { flagName: input.flagName, operatorUserId: operator.userId },
          envelope,
        )
      : createEvent(
          flagOverrideSet,
          {
            flagName: input.flagName,
            value: input.value,
            operatorUserId: operator.userId,
          },
          envelope,
        ),
  ]);

  return { flagName: input.flagName, value: input.value };
}
