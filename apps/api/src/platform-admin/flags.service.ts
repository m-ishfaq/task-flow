import { eq, schema, withPlatformAdminScope } from '@taskflow/db';
import { FLAG_NAMES, FLAGS, FeatureFlags, type FlagName } from '@taskflow/feature-flags';
import type { EventBus } from '@taskflow/events';
import { createEvent } from '@taskflow/events';
import type { UserId } from '@taskflow/contracts';
import { SYSTEM_ORG } from '../identity/identity.service.js';
import { flagOverrideCleared, flagOverrideSet } from './events.js';

/**
 * The feature-flag admin console (Phase 12 §3.8).
 *
 * `packages/feature-flags`' evaluator has always modelled `orgOverrides` as
 * its highest-precedence input, and nothing has ever persisted one — this is
 * that missing store, GLOBAL only (no per-org row shape yet, a real, named,
 * out-of-scope follow-up rather than an oversight).
 *
 * The environment tier is deliberately resolved with an EMPTY env map here:
 * nothing in this codebase parses `TASKFLOW_FLAG_*` into the validated env
 * schema yet (checked — `apps/api/src/config/env.ts` has no such fields, and
 * no route or component constructs a `FeatureFlags` instance today at all).
 * Pretending to support an environment tier this codebase does not actually
 * wire anywhere would be its own kind of half-finished feature; when that
 * wiring exists, this service already calls the real evaluator and picks it
 * up for free.
 */

export interface FlagRow {
  readonly flag: FlagName;
  readonly description: string;
  readonly value: boolean;
  readonly source: 'platform-override' | 'default';
  readonly setBy: string | null;
  readonly updatedAt: Date | null;
}

export async function listFlags(): Promise<readonly FlagRow[]> {
  const overrides = await withPlatformAdminScope(async (tx) =>
    tx
      .select({
        flagName: schema.flagOverrides.flagName,
        value: schema.flagOverrides.value,
        setBy: schema.flagOverrides.setBy,
        updatedAt: schema.flagOverrides.updatedAt,
      })
      .from(schema.flagOverrides),
  );

  const overrideByFlag = new Map(overrides.map((row) => [row.flagName, row]));
  const evaluator = new FeatureFlags();

  return FLAG_NAMES.map((flag): FlagRow => {
    const override = overrideByFlag.get(flag);
    if (override !== undefined) {
      return {
        flag,
        description: FLAGS[flag].description,
        value: override.value,
        source: 'platform-override',
        setBy: override.setBy,
        updatedAt: override.updatedAt,
      };
    }

    return {
      flag,
      description: FLAGS[flag].description,
      value: evaluator.isEnabled(flag),
      source: 'default',
      setBy: null,
      updatedAt: null,
    };
  });
}

export interface FlagActor {
  readonly userId: UserId;
}

export async function setFlag(
  flag: FlagName,
  value: boolean,
  actor: FlagActor,
  events: EventBus,
): Promise<void> {
  await withPlatformAdminScope(async (tx) =>
    tx
      .insert(schema.flagOverrides)
      .values({ flagName: flag, value, setBy: actor.userId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.flagOverrides.flagName,
        set: { value, setBy: actor.userId, updatedAt: new Date() },
      }),
  );

  await events.publish([
    createEvent(
      flagOverrideSet,
      { flagName: flag, value, setBy: actor.userId },
      { orgId: SYSTEM_ORG, actorId: actor.userId, occurredAt: new Date() },
    ),
  ]);
}

export async function clearFlag(flag: FlagName, actor: FlagActor, events: EventBus): Promise<void> {
  await withPlatformAdminScope(async (tx) =>
    tx.delete(schema.flagOverrides).where(eq(schema.flagOverrides.flagName, flag)),
  );

  await events.publish([
    createEvent(
      flagOverrideCleared,
      { flagName: flag, clearedBy: actor.userId },
      { orgId: SYSTEM_ORG, actorId: actor.userId, occurredAt: new Date() },
    ),
  ]);
}
