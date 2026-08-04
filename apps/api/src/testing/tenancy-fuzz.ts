import type { AnyRouter } from '@trpc/server';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import type { RelationshipTuple, Role } from '@taskflow/policy';
import { protectedRoutes, routeManifest, type RouteEntry } from '../trpc/manifest.js';
import type { AuthenticatedPrincipal, RequestContext } from '../trpc/context.js';

/**
 * GUARDRAIL 8 — the tenancy isolation fuzz test (PLAN.md §2.1).
 *
 * "CI creates two orgs and calls every registered endpoint cross-tenant,
 * asserting 403/404. New endpoints are enrolled automatically from the router
 * manifest."
 *
 * Cross-tenant data exposure is the most common serious SaaS breach, and it is
 * almost never introduced deliberately. It arrives as one handler that takes an
 * id from the request and looks it up without scoping — a change that is three
 * lines long, passes review, and works perfectly for the tenant who reported the
 * bug it was fixing.
 *
 * The enrolment is the load-bearing part. A hand-written list of endpoints to
 * check goes stale in the direction of less coverage, and nothing announces it.
 * Deriving the list from the router means the only way to add an untested
 * endpoint is to add one that the manifest cannot see — which the boot assertion
 * already refuses to start with.
 *
 * WHAT THIS PROVES, precisely: that org A's credentials cannot act on org B's
 * ids at the HTTP boundary. It does not replace the RLS tests in @taskflow/db,
 * which prove the same property one layer down against real Postgres. Both
 * matter: this one catches a handler that forgot to scope, and those catch a
 * query that bypassed the scoped client.
 */

export interface FuzzOrg {
  readonly orgId: OrgId;
  readonly userId: UserId;
  readonly role: Role;
  readonly tuples?: readonly RelationshipTuple[];
  /**
   * Ids belonging to this org, keyed by the input field name a route expects
   * (`cardId`, `boardId`). The harness feeds org B's ids to org A's session.
   *
   * Values are `unknown` rather than `string` because a cross-tenant id is not
   * always a bare id. `cards.assign` takes an ARRAY of user ids and
   * `cards.update` requires a numeric `version`; with only strings available,
   * both routes would reject the bag on shape and answer BAD_REQUEST — which
   * this harness counts as a refusal. They would pass without the tenant
   * boundary ever being consulted, which is a false negative in the one
   * direction that matters.
   */
  readonly resourceIds: Readonly<Record<string, unknown>>;
}

export interface FuzzResult {
  readonly path: string;
  readonly kind: RouteEntry['kind'];
  /**
   * `not-applicable` is not a pass — it is an honest "this route cannot be
   * tested by this technique". See `runTenancyFuzz`.
   */
  readonly outcome: 'denied' | 'leaked' | 'errored' | 'skipped' | 'not-applicable';
  readonly detail?: string;
}

/**
 * A fixed session id for every fuzz principal.
 *
 * The attacker's session is not what is under test — the org boundary is — and a
 * fresh id per run would make a failure report harder to reproduce.
 */
const FUZZ_SESSION_ID = '018f4d1e-7c3a-7b2e-8f1a-0000000000fa';

/** Error codes that count as a correct refusal. */
const ACCEPTABLE = new Set(['FORBIDDEN', 'NOT_FOUND', 'UNAUTHENTICATED', 'BAD_REQUEST']);

/**
 * A resolved tRPC caller procedure.
 *
 * The input is `unknown` on purpose. The harness feeds every route the victim's
 * id bag and lets the route's own Zod schema reject what it does not want — a
 * BAD_REQUEST is a refusal, and typing this more precisely would mean the
 * harness needed to know each route's shape, which is exactly the
 * hand-maintained coupling it exists to avoid.
 */
type RouteCall = (input: unknown) => Promise<unknown>;

export interface FuzzOptions {
  readonly router: AnyRouter;
  readonly attacker: FuzzOrg;
  readonly victim: FuzzOrg;
  /**
   * Builds a caller bound to a subject. Supplied by the test so the harness
   * needs no knowledge of how sessions are made.
   */
  readonly callerFor: (context: RequestContext) => Record<string, unknown>;
  /**
   * Routes deliberately excluded, each with a reason.
   *
   * Requiring a reason string rather than accepting a bare list is the same
   * mechanism as `publicRoute`: an exclusion that nobody can justify in a
   * sentence is an exclusion that should not exist, and this makes it visible in
   * the diff instead of in a config array.
   */
  readonly exclude?: Readonly<Record<string, string>>;
}

/**
 * Calls every authenticated route as the attacker, using the victim's ids.
 *
 * Any 2xx is a leak. Anything in ACCEPTABLE is a correct refusal. An unexpected
 * error is reported as `errored` rather than quietly passing — a 500 means the
 * handler did not refuse on purpose, it fell over, and the next change to it
 * could just as easily fall over into success.
 */
export async function runTenancyFuzz(options: FuzzOptions): Promise<readonly FuzzResult[]> {
  const entries = protectedRoutes(routeManifest(options.router));
  const results: FuzzResult[] = [];

  const attackerContext: RequestContext = {
    requestId: 'fuzz-request' as RequestContext['requestId'],
    principal: principalOf(options.attacker),
    refreshToken: null,
    ip: '203.0.113.1',
    userAgent: 'tenancy-fuzz',
    setRefreshCookie: () => undefined,
  };
  const caller = options.callerFor(attackerContext);

  for (const entry of entries) {
    const excuse = options.exclude?.[entry.path];
    if (excuse !== undefined) {
      results.push({ path: entry.path, kind: entry.kind, outcome: 'skipped', detail: excuse });
      continue;
    }

    /* A route that accepts no input takes no identifier from the caller: its
       scope comes entirely from the principal's org. There is no id to
       substitute, so calling it with the victim's bag proves nothing — it
       returns the ATTACKER's own rows and succeeds, which this harness would
       otherwise report as a leak. A permanent false positive is worse than a
       gap, because it trains whoever reads the output to skim past it.

       What covers these instead: the RLS tests in packages/db, which prove
       `withOrgScope` returns only the scoped org's rows, and the per-slice
       integration tests. Derived from the manifest rather than listed here, so
       a route that later gains an input is enrolled again automatically. */
    if (!entry.acceptsInput) {
      results.push({
        path: entry.path,
        kind: entry.kind,
        outcome: 'not-applicable',
        detail: 'takes no caller-supplied input; scope comes from the principal',
      });
      continue;
    }

    const procedure = resolve(caller, entry.path) as RouteCall | undefined;
    if (typeof procedure !== 'function') {
      results.push({
        path: entry.path,
        kind: entry.kind,
        outcome: 'errored',
        detail: 'route present in the manifest but not callable — the manifest and router disagree',
      });
      continue;
    }

    try {
      await procedure(options.victim.resourceIds);
      results.push({
        path: entry.path,
        kind: entry.kind,
        outcome: 'leaked',
        detail: "returned successfully for another tenant's ids",
      });
    } catch (error) {
      const code = codeOf(error);
      results.push(
        ACCEPTABLE.has(code)
          ? { path: entry.path, kind: entry.kind, outcome: 'denied', detail: code }
          : { path: entry.path, kind: entry.kind, outcome: 'errored', detail: code },
      );
    }
  }

  return results;
}

/** Throws with a readable report if anything leaked or errored. */
export function assertNoTenancyLeaks(results: readonly FuzzResult[]): void {
  const bad = results.filter(
    (result) => result.outcome === 'leaked' || result.outcome === 'errored',
  );
  if (bad.length === 0) return;

  const lines = bad.map(
    (result) => `  ${result.outcome.toUpperCase()}  ${result.path} — ${result.detail ?? ''}`,
  );

  throw new Error(
    `Cross-tenant isolation failed on ${String(bad.length)} route(s):\n${lines.join('\n')}\n\n` +
      "A LEAKED route accepted another tenant's id. An ERRORED route did not refuse on\n" +
      'purpose — it fell over, and the next change could just as easily fall over into\n' +
      'success. See PLAN.md §2.1 guardrail 8.',
  );
}

function principalOf(org: FuzzOrg): AuthenticatedPrincipal {
  return {
    userId: org.userId,
    sessionId: unsafeAsId<'SessionId'>(FUZZ_SESSION_ID),
    authenticatedAt: new Date(),
    org: { orgId: org.orgId, role: org.role, tuples: org.tuples ?? [] },
  };
}

/**
 * Walks a dot path through a tRPC caller.
 *
 * The `typeof === 'function'` branch is load-bearing: a caller's namespaces are
 * callable proxies, not plain objects, so a naive object-only walk resolves
 * `cards.get` to undefined. That failure is quiet in the worst way — every route
 * reports "not callable", which is an ERRORED outcome, and a fuzz run that never
 * reached a single handler still looks like it did some work.
 */
function resolve(caller: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null) return undefined;
    if (typeof current !== 'object' && typeof current !== 'function') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, caller);
}

function codeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'UNKNOWN';

  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof candidate.cause?.code === 'string') return candidate.cause.code;
  if (typeof candidate.code === 'string') return candidate.code;
  return 'UNKNOWN';
}
