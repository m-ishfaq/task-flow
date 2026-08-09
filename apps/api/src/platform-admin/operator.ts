import { withGlobalScope, schema, eq } from '@taskflow/db';
import type { UserId } from '@taskflow/contracts';

/**
 * Whether `userId` holds platform-operator access (Phase 12 Wave 1,
 * ai/phase-12-admin.md §3.1).
 *
 * A flat flag, not a role — `platform.operators` has no `role` column, and
 * everyone in it can do everything this wave's console offers.
 *
 * ## Why this lives here rather than in packages/policy
 *
 * `platform.operators` is a non-tenant table (no `org_id`, no RLS), and the
 * check must answer before any org is known — the whole point of the operator
 * flag is that it is relative to NO org. The read therefore uses
 * `withGlobalScope`, the same escape hatch `people.profiles` established, and
 * the file sits in `apps/api/src/platform-admin` for the identical structural
 * reason that module does: keeping the escape-hatch consumer in the API layer
 * (covered by the eslint carve-out in packages/config/eslint/security.js) keeps
 * `packages/policy` free of a database dependency. It is consumed by
 * `platformRoute` (trpc/builder.ts) and by `platformAdmin.self.check`.
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
