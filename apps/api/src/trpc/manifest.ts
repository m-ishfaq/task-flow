import type { AnyRouter } from '@trpc/server';
import { isPermission, type Permission } from '@taskflow/policy';
import type { RouteMeta } from './builder.js';

/**
 * The router manifest — the second half of guardrail 4, and the input to
 * guardrail 8 (PLAN.md §2.1).
 *
 * Walking the finished router and reading each procedure's declared metadata
 * gives one list that three things consume:
 *
 *   1. The boot assertion below. A route with no declaration stops the process.
 *   2. The tenancy isolation fuzz test, which enrolls every entry automatically
 *      — so a new endpoint is covered by cross-tenant tests the moment it
 *      exists, rather than when someone remembers to add it.
 *   3. The admin route listing, which is how "what is public?" gets answered
 *      without reading every router file.
 *
 * Point 2 is why this is derived rather than hand-maintained. A checklist of
 * endpoints to test goes stale silently, and always in the direction of less
 * coverage.
 */

export type RouteKind = 'query' | 'mutation' | 'subscription';

export interface RouteEntry {
  /** Dot path as a client calls it, e.g. `cards.move`. */
  readonly path: string;
  readonly kind: RouteKind;
  /**
   * The permission required, `null` for a route declared public, or `undefined`
   * for one that declares NOTHING.
   *
   * The three-way distinction is the whole point. A boolean would merge "open on
   * purpose" with "nobody said", and those are the two cases the boot assertion
   * exists to tell apart.
   */
  readonly permission: Permission | null | undefined;
  readonly publicReason?: string;
  readonly selfReason?: string;
  readonly stepUp: boolean;
}

/**
 * How a route is reached.
 *
 * `self` is authenticated but carries no org permission — see `selfRoute`. It is
 * separated from `public` because the manifest is what answers "what is
 * reachable without credentials", and merging the two would make that answer
 * wrong in the direction that matters.
 */
export type RouteAccess = 'public' | 'self' | 'permission' | 'undeclared';

export function accessOf(entry: RouteEntry): RouteAccess {
  if (entry.permission === undefined) return 'undeclared';
  if (typeof entry.permission === 'string') return 'permission';
  return entry.selfReason === undefined ? 'public' : 'self';
}

interface ProcedureLike {
  _def?: { procedure?: boolean; type?: string; meta?: unknown };
}

function isProcedure(value: unknown): value is ProcedureLike {
  return (
    typeof value === 'function' &&
    typeof (value as ProcedureLike)._def === 'object' &&
    (value as ProcedureLike)._def?.procedure === true
  );
}

/**
 * Reads a procedure's declaration, returning undefined for anything that is not
 * a well-formed one.
 *
 * A permission string that is not in the catalog counts as NO declaration rather
 * than as a declaration to be trusted. A typo'd permission that nobody grants
 * would deny every caller, which reads as a broken feature; a typo that happens
 * to collide with a real permission would grant the wrong thing. Refusing to
 * boot is the only outcome that is obviously wrong to the person who caused it.
 */
function readDeclaration(value: unknown): RouteMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const meta = value as Partial<RouteMeta>;

  if (!('permission' in meta)) return undefined;
  if (meta.permission === null) return meta as RouteMeta;
  if (typeof meta.permission === 'string' && isPermission(meta.permission)) {
    return meta as RouteMeta;
  }
  return undefined;
}

/** Flattens a router into one entry per procedure. */
export function routeManifest(appRouter: AnyRouter): readonly RouteEntry[] {
  const entries: RouteEntry[] = [];

  const walk = (record: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(record)) {
      // Depending on how routers were merged, tRPC keys are dot-joined at some
      // levels and nested at others. Handling both is cheaper than depending on
      // which, and a manifest that quietly missed a branch would take the fuzz
      // test's coverage with it.
      const path = prefix === '' ? key : `${prefix}.${key}`;

      if (isProcedure(value)) {
        const meta = readDeclaration(value._def?.meta);
        entries.push({
          path,
          kind: (value._def?.type ?? 'query') as RouteKind,
          permission: meta === undefined ? undefined : meta.permission,
          ...(meta?.publicReason === undefined ? {} : { publicReason: meta.publicReason }),
          ...(meta?.selfReason === undefined ? {} : { selfReason: meta.selfReason }),
          stepUp: meta?.stepUp === true,
        });
        continue;
      }

      if (typeof value === 'object' && value !== null) {
        walk(value as Record<string, unknown>, path);
      }
    }
  };

  walk(appRouter._def.procedures as Record<string, unknown>, '');
  return entries;
}

export class UndeclaredRouteError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(
      `${String(paths.length)} route(s) declare no permission:\n` +
        paths.map((path) => `  - ${path}`).join('\n') +
        '\n\nEvery route must be built with route({ permission }) or publicRoute({ publicReason }).\n' +
        'See PLAN.md §2.1 guardrail 4.',
    );
    this.name = 'UndeclaredRouteError';
  }
}

/**
 * Refuses to start with an undeclared route.
 *
 * Called from server startup rather than from a test, and that placement is the
 * point: a test can be skipped or never written, while a process that will not
 * boot cannot be ignored. The failure being prevented — a handler reachable with
 * no authorization check at all — returns 200 and looks completely healthy.
 */
export function assertRoutesDeclarePermissions(appRouter: AnyRouter): readonly RouteEntry[] {
  const entries = routeManifest(appRouter);
  const undeclared = entries.filter((entry) => entry.permission === undefined);

  if (undeclared.length > 0) {
    throw new UndeclaredRouteError(undeclared.map((entry) => entry.path));
  }
  return entries;
}

/**
 * Every route reachable WITHOUT credentials. For review and the admin page.
 *
 * Excludes self-scoped routes, which also leave `permission` null but do require
 * authentication. Counting those as public would overstate the attack surface
 * and, worse, train whoever reviews this list to skim it.
 */
export function publicRoutes(entries: readonly RouteEntry[]): readonly RouteEntry[] {
  return entries.filter((entry) => accessOf(entry) === 'public');
}

/** Authenticated routes that carry no org permission. */
export function selfRoutes(entries: readonly RouteEntry[]): readonly RouteEntry[] {
  return entries.filter((entry) => accessOf(entry) === 'self');
}

/** Every route that requires authentication — what the fuzz test enrolls. */
export function protectedRoutes(entries: readonly RouteEntry[]): readonly RouteEntry[] {
  return entries.filter((entry) => typeof entry.permission === 'string');
}
