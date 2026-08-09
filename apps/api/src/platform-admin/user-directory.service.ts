import {
  and,
  countRows,
  desc,
  eq,
  lt,
  or,
  schema,
  withGlobalScope,
  withPlatformAdminScope,
} from '@taskflow/db';
import { recordOperatorAction } from './audit.js';
import { encodeCreatedCursor, parseCreatedCursor } from './pagination.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * The user directory — read-only in this wave (ai/phase-12-admin.md §3.6;
 * §7 decision 5 defers user suspension deliberately).
 *
 * ## Two scopes in one file, and why that is correct rather than sloppy
 *
 * `identity.users` carries NO RLS at all — the same property that lets login
 * resolve any email to an account before any org is known — so the users read
 * runs in `withGlobalScope`, the one legitimately non-tenant read in this
 * module. But `orgCount` needs `identity.memberships`, which IS tenant-scoped
 * under FORCE RLS, and the only connection that can see it across every org
 * is `taskflow_platform_admin` (migration 0035's `memberships_platform_admin_read`
 * policy). So the count runs in its own `withPlatformAdminScope` query and the
 * two are merged in JavaScript. The alternative — reading users through the
 * platform-admin connection too — would work, but it is the wrong tool for a
 * table RLS was never applied to, and mixing the two tools in one file with
 * each used where it belongs is exactly what a later reader can trust.
 */
export interface UserDirectoryRow {
  readonly userId: string;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly status: string;
  readonly orgCount: number;
  readonly createdAt: Date;
}

/**
 * Every account, newest first, keyset-paginated. No per-user actions — this
 * wave's console can freeze an org; it cannot freeze a person.
 */
export async function listUsers(
  operator: PlatformOperator,
  input: { readonly cursor: string | null; readonly limit: number },
): Promise<{ readonly users: readonly UserDirectoryRow[]; readonly nextCursor: string | null }> {
  const cursor = parseCreatedCursor(input.cursor);

  const rows = await withGlobalScope(async (tx) => {
    const query = tx
      .select({
        userId: schema.users.id,
        email: schema.users.email,
        emailVerifiedAt: schema.users.emailVerifiedAt,
        status: schema.users.status,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .orderBy(desc(schema.users.createdAt), desc(schema.users.id))
      .limit(input.limit + 1);

    if (cursor !== null) {
      /* The same (created_at, id) < (cursorDate, cursorId) tuple comparison
         org-directory uses, expressed as a disjunction. */
      query.where(
        or(
          lt(schema.users.createdAt, cursor.createdAt),
          and(eq(schema.users.createdAt, cursor.createdAt), lt(schema.users.id, cursor.rowId)),
        ),
      );
    }
    return query;
  });

  /* The count query: one aggregate per user over ACTIVE memberships, as the
     platform-admin role (see the file header for why it cannot run in the
     same scope as the users read). */
  const counts = await withPlatformAdminScope(async (tx) =>
    tx
      .select({
        userId: schema.memberships.userId,
        count: countRows(schema.memberships.id),
      })
      .from(schema.memberships)
      .where(eq(schema.memberships.status, 'active'))
      .groupBy(schema.memberships.userId),
  );
  const countByUser = new Map(counts.map((row) => [row.userId, Number(row.count)]));

  await recordOperatorAction(operator.userId, 'users.list', null);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];

  return {
    users: page.map((row) => ({
      userId: row.userId,
      email: row.email,
      emailVerifiedAt: row.emailVerifiedAt,
      status: row.status,
      orgCount: countByUser.get(row.userId) ?? 0,
      createdAt: row.createdAt,
    })),
    nextCursor: hasMore && last !== undefined ? encodeCreatedCursor(last.createdAt, last.userId) : null,
  };
}
