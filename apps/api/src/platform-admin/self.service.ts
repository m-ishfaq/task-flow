import { eq, schema, withGlobalScope } from '@taskflow/db';
import type { UserId } from '@taskflow/contracts';

/**
 * Whether a platform operator is calling (Phase 12 §3.1, §3.6).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — this is the check `platformRoute`
 * (trpc/builder.ts) runs before every cross-tenant handler in this module,
 * and the check `platformAdmin.self.check` exposes to `apps/web` so the
 * account menu can decide whether to render a link at all.
 *
 * `platform.operators` carries no `org_id` and no RLS (migration 0032's
 * header) — the identical shape `identity.users` already has, and for the
 * same reason: a platform operator's authority is relative to no org, so no
 * value of `app.org_id` or `app.user_id` is the right scope. Reached through
 * `withGlobalScope`, restricted by lint to `apps/api/src/identity/**`,
 * `apps/api/src/people/**`, and (this file's own directory)
 * `apps/api/src/platform-admin/**` — see
 * `packages/config/eslint/security.js`'s `exempt-global-scope-consumers`
 * block.
 *
 * `taskflow_app` holds SELECT only on `platform.operators` — no route,
 * including this one, can write it. See migration 0032's own header for why
 * that is deliberate and stricter than every other cross-tenant table in
 * this system.
 */
export async function isPlatformOperator(userId: UserId): Promise<boolean> {
  const rows = await withGlobalScope(async (tx) =>
    tx
      .select({ userId: schema.operators.userId })
      .from(schema.operators)
      .where(eq(schema.operators.userId, userId))
      .limit(1),
  );

  return rows.length > 0;
}
