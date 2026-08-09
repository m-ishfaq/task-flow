import { TRPCError, initTRPC } from '@trpc/server';
import { ZodError } from 'zod';
import { AppError, isAppError, type ApiError } from '@taskflow/contracts';
import { couldGrant, type Permission } from '@taskflow/policy';
import { appendOperatorAuditEntry } from '@taskflow/db';
import { isPlatformOperator } from '../platform-admin/self.service.js';
import {
  subjectOf,
  type AuthenticatedContext,
  type OrgScopedContext,
  type RequestContext,
} from './context.js';

/**
 * The fail-closed route builder — guardrail 4 (PLAN.md §2.1, §8.2 layer 1).
 *
 * "A procedure without `.meta({ permission })` is a type error. The router
 * additionally throws at boot if any registered route lacks a declared
 * permission."
 *
 * Both halves are here, and they catch different mistakes:
 *
 *   - The TYPE error is `route()` taking its metadata as a required ARGUMENT.
 *     There is no bare `procedure` export to reach for, so "I forgot the
 *     permission" is not a state you can get into. This is the half that works
 *     while you are writing the code.
 *   - The BOOT check (manifest.ts) walks the finished router and refuses to
 *     start if anything lacks a declaration. This is the half that catches a
 *     raw `t.procedure` imported from somewhere clever, or a procedure built
 *     before this module existed.
 *
 * The alternative — remembering to add an auth middleware to each route — fails
 * silently in exactly one direction. A forgotten middleware is a public
 * endpoint, it returns 200, and nothing anywhere goes red.
 */

/**
 * Three kinds of access, and every route declares exactly one.
 *
 * The third kind exists because "signed in" and "allowed to do X in this
 * organization" are genuinely different questions, and collapsing them was the
 * first thing that went wrong when the identity routes arrived. Signing your own
 * other devices out is not an org capability — a guest can do it, and no
 * permission in the catalog describes it — but calling it PUBLIC would be a lie
 * in the one document that answers "what is reachable without credentials".
 */
export interface RouteMeta {
  /** The permission a caller must hold, or null when access is public or self-scoped. */
  readonly permission: Permission | null;
  /**
   * Why this route is public. Required by `publicRoute`.
   *
   * A sentence, not a flag: making someone write the justification into the diff
   * is the entire mechanism. `public: true` is invisible in review; "this is how
   * a user signs in" is not.
   */
  readonly publicReason?: string;
  /**
   * Why this route needs authentication but no org permission. Required by
   * `selfRoute`. Its presence is what distinguishes a self-scoped route from a
   * public one, since both leave `permission` null.
   */
  readonly selfReason?: string;
  /**
   * Why this route needs an org resolved but no specific permission. Required
   * by `memberRoute`. Distinguishes an any-member route from `self` (no org
   * at all) and from `public` (no auth at all) — all three leave `permission`
   * null, and the reason field is what tells them apart in the manifest.
   */
  readonly memberReason?: string;
  /**
   * Why this route is a platform-operator route. Required by `platformRoute`
   * (Phase 12 §3.2). Distinguishes a cross-tenant operator route — no org
   * resolved at all, `isPlatformOperator` gated, unconditionally step-up —
   * from every other kind that also leaves `permission` null.
   */
  readonly platformReason?: string;
  /** Requires a recent credential proof, e.g. role changes, recording export (§8.1). */
  readonly stepUp?: boolean;
}

const t = initTRPC
  .context<RequestContext>()
  .meta<RouteMeta>()
  .create({
    /**
     * Maps every failure onto the error envelope from @taskflow/contracts.
     *
     * The shape is REPLACED, not extended. tRPC's default includes a `stack`
     * field outside production, and the first time this server was booted it
     * duly returned absolute filesystem paths and dependency versions to an
     * unauthenticated caller on a 404 — from an errorFormatter that spread
     * `...shape` believing it was only adding to it.
     *
     * So the allowed fields are listed rather than filtered. A denylist has to
     * be updated every time the library adds a field; an allowlist does not
     * (§8.7).
     */
    errorFormatter({ shape, error, ctx }) {
      const requestId = ctx?.requestId ?? 'unknown';

      const envelope: ApiError = isAppError(error.cause)
        ? error.cause.toResponse(requestId)
        : fromTrpcError(error.code, error.cause).toResponse(requestId);

      /* tRPC has its own transport envelope — it wraps whatever this returns as
         `{ error: <shape> }` — so returning our `{ error: ... }` verbatim would
         nest it as `error.error` and no client would find it. The domain fields
         go in `data`, which is exactly where a tRPC client looks for them. The
         REST surface still uses ApiError directly; both agree on the codes,
         which is what the shared contract is for. */
      return {
        message: envelope.error.message,
        code: shape.code,
        data: {
          code: envelope.error.code,
          httpStatus: shape.data.httpStatus,
          requestId,
          ...(envelope.error.details === undefined ? {} : { details: envelope.error.details }),
          ...(envelope.error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: envelope.error.retryAfterSeconds }),
        },
      };
    },
  });

/**
 * Translates a failure raised by tRPC itself into our error vocabulary.
 *
 * Not everything reaches the formatter as an `AppError`: an unroutable path, a
 * Zod input rejection, and a payload over the body limit are all produced by the
 * framework before any of our code runs. Collapsing those to INTERNAL_ERROR
 * would report a 404 as a server fault, which is wrong for the client and worse
 * for alerting — a dashboard counting 5xx would light up on every mistyped URL.
 *
 * Anything genuinely unexpected still becomes INTERNAL_ERROR with a generic
 * message, because that is the branch where the details are ours, not the
 * caller's (§8.7).
 */
function fromTrpcError(code: string, cause: unknown): AppError {
  switch (code) {
    case 'BAD_REQUEST': {
      /* Field-level detail, when the failure was a Zod input rejection.
         `ApiError` has always had a `details` slot documented as "field-level
         detail for VALIDATION_FAILED" and nothing ever filled it, so every
         input rejection reached the browser as the bare sentence below. A
         registration form would answer "The request was not valid." to a
         password one character short — the server knew exactly which field and
         why, and threw it away at the last step. */
      const details = fieldErrorsOf(cause);
      return new AppError(
        'VALIDATION_FAILED',
        'The request was not valid.',
        details === undefined ? {} : { details },
      );
    }
    case 'UNAUTHORIZED':
      return new AppError('UNAUTHENTICATED', 'Authentication required.');
    case 'FORBIDDEN':
      return new AppError('FORBIDDEN', 'You do not have permission to perform this action.');
    case 'NOT_FOUND':
      return new AppError('NOT_FOUND', 'Not found.');
    case 'CONFLICT':
      return new AppError('CONFLICT', 'The resource changed since you loaded it.');
    case 'PAYLOAD_TOO_LARGE':
      return new AppError('PAYLOAD_TOO_LARGE', 'The request body is too large.');
    case 'UNSUPPORTED_MEDIA_TYPE':
      return new AppError('UNSUPPORTED_MEDIA_TYPE', 'Unsupported content type.');
    case 'TOO_MANY_REQUESTS':
      return new AppError('RATE_LIMITED', 'Too many requests.');
    case 'NOT_IMPLEMENTED':
      return new AppError('NOT_IMPLEMENTED', 'Not implemented.');
    default:
      return new AppError('INTERNAL_ERROR', 'Something went wrong.');
  }
}

/**
 * Turns a Zod rejection into `{ field: reason }`.
 *
 * ## Why this is safe to return, when §8.7 says to reveal nothing
 *
 * Because it describes the CALLER'S OWN REQUEST, which they already have. A
 * message like `password: String must contain at least 12 character(s)` states
 * a published constraint about data the caller just sent. That is categorically
 * different from a stack trace or a database error, which describe US.
 *
 * The gate is that this is reached only from the `BAD_REQUEST` branch above,
 * and BAD_REQUEST is tRPC's code for INPUT validation. An OUTPUT schema failure
 * — where the paths would describe our own response shape, and the values would
 * be another user's data — arrives as INTERNAL_SERVER_ERROR and falls through
 * to the generic message. Do not widen this to other codes.
 *
 * Only the FIRST issue per path is kept: Zod reports a union failure once per
 * member, and a form field with five contradictory explanations is worse than
 * one.
 */
function fieldErrorsOf(cause: unknown): Record<string, string> | undefined {
  if (!(cause instanceof ZodError)) return undefined;

  const fields: Record<string, string> = {};
  for (const issue of cause.issues) {
    // A top-level failure — the body was not an object at all — has no path.
    const key = issue.path.length === 0 ? '_' : issue.path.join('.');
    fields[key] ??= issue.message;
  }

  return Object.keys(fields).length === 0 ? undefined : fields;
}

/**
 * The inverse of `fromTrpcError`: our error code to tRPC's.
 *
 * Needed because a service throws `AppError` directly — it has no business
 * importing a transport library — and tRPC, seeing an exception it does not
 * recognize, defaults to INTERNAL_SERVER_ERROR. Without this mapping every
 * domain failure answered 500: a wrong password, an unverified email, an expired
 * link. The error CODE in the body was right, which is what made it survive the
 * service-level tests; only the HTTP status was wrong, and only a test that went
 * through HTTP could see it.
 *
 * That is not cosmetic. A 500 tells a client to retry, tells a load balancer the
 * instance is sick, and lights up every 5xx alert on the dashboard — for a user
 * mistyping their password.
 */
function toTrpcCode(code: string): TRPCError['code'] {
  switch (code) {
    case 'UNAUTHENTICATED':
    case 'INVALID_CREDENTIALS':
    case 'TOKEN_EXPIRED':
    case 'TOKEN_REUSED':
    case 'MFA_REQUIRED':
    case 'STEP_UP_REQUIRED':
      return 'UNAUTHORIZED';
    case 'EMAIL_NOT_VERIFIED':
    case 'FORBIDDEN':
    case 'NOT_A_MEMBER':
    case 'ORG_SUSPENDED':
      return 'FORBIDDEN';
    case 'NOT_FOUND':
    case 'GONE':
      return 'NOT_FOUND';
    case 'ALREADY_EXISTS':
    case 'CONFLICT':
      return 'CONFLICT';
    case 'VALIDATION_FAILED':
      return 'BAD_REQUEST';
    case 'PAYLOAD_TOO_LARGE':
      return 'PAYLOAD_TOO_LARGE';
    case 'UNSUPPORTED_MEDIA_TYPE':
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 'RATE_LIMITED':
    case 'QUOTA_EXCEEDED':
      return 'TOO_MANY_REQUESTS';
    case 'NOT_IMPLEMENTED':
      return 'NOT_IMPLEMENTED';
    case 'SERVICE_UNAVAILABLE':
      // No dedicated tRPC code. TIMEOUT maps to 408, which at least tells the
      // client to retry rather than reporting our own fault.
      return 'TIMEOUT';
    default:
      return 'INTERNAL_SERVER_ERROR';
  }
}

/**
 * Converts an `AppError` escaping a handler into the matching TRPCError.
 *
 * Applied to EVERY procedure below, including public ones — a login failure is
 * exactly the case that must not be a 500.
 */
const mapErrors = t.middleware(async ({ next }) => {
  // `next()` RESOLVES with `{ ok: false, error }` rather than rejecting — a
  // tRPC middleware contract that a try/catch silently misses. The first version
  // of this was a try/catch, it compiled, and it did nothing at all.
  let result: Awaited<ReturnType<typeof next>>;
  try {
    result = await next();
  } catch (error) {
    const thrown = asAppError(error);
    if (thrown) throw new TRPCError({ code: toTrpcCode(thrown.code), cause: thrown });
    throw error;
  }

  if (!result.ok) {
    const appError = asAppError(result.error);
    if (appError) {
      throw new TRPCError({ code: toTrpcCode(appError.code), cause: appError });
    }
  }
  return result;
});

/**
 * Finds the `AppError` behind whatever tRPC hands back.
 *
 * Checking `isAppError(error)` alone is NOT enough, and this was wrong the first
 * time: tRPC wraps an exception thrown by a resolver in a `TRPCError` before it
 * propagates back through the middleware chain, so by the time this sees it the
 * AppError is the `cause`, not the error. The version that only checked the top
 * level compiled, passed every unit test, and left every domain failure
 * answering HTTP 500 — visible only by calling the running server.
 */
function asAppError(error: unknown): AppError | undefined {
  if (isAppError(error)) return error;
  if (error instanceof TRPCError && isAppError(error.cause)) return error.cause;
  return undefined;
}

const procedure = t.procedure.use(mapErrors);

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;

/** How long a credential proof counts as recent, for step-up routes (§8.1). */
const STEP_UP_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Authenticated route requiring `permission`.
 *
 * The check here is a COARSE capability gate — "could a principal like this
 * one ever do this kind of thing at all". It runs before the handler and
 * therefore before any row is loaded, which is exactly why it cannot be the
 * whole story: per-resource authorization needs the resource, so a handler
 * that touches one calls `enforce()` from @taskflow/policy once it has
 * loaded the row. Layer 1 narrows; layer 2 decides.
 *
 * `couldGrant`, not `can(...).allowed` with no target. `can()` with no
 * target answers from ROLE alone — correct for every role except `guest`,
 * which grants nothing by itself and gains access entirely through a tuple
 * on one specific channel (`packages/policy/src/roles.ts`). Asking `can()`
 * here refused every guest on every chat route before the handler ever
 * loaded the channel that would have granted them the permission through
 * that tuple — layer 2 never got a chance to run. `couldGrant` accounts for
 * "or holds a tuple that could grant it, on SOMETHING" — coarser than a real
 * decision, which is fine, because layer 2 is what actually decides once it
 * has the resource. See `couldGrant`'s own comment for why widening layer 1
 * this way costs nothing.
 */
export function route(meta: { permission: Permission; stepUp?: boolean }) {
  return procedure.meta(meta).use(async ({ ctx, next, meta: routeMeta }) => {
    const scoped = requireOrg(requireAuth(ctx, routeMeta));

    if (!couldGrant(subjectOf(scoped.principal), meta.permission)) {
      // No decision trace in the message — telling a caller which rule
      // denied them is a map of the permission model. `enforce()` at layer
      // 2, once it has a resource, is what a decision trace belongs to.
      throw new TRPCError({
        code: 'FORBIDDEN',
        cause: new AppError('FORBIDDEN', 'You do not have permission to perform this action.'),
      });
    }

    return next({ ctx: scoped });
  });
}

/**
 * Authenticated route with NO org permission — a user acting on themselves.
 *
 * Signing your own other devices out, listing your own sessions, changing your
 * own password. No permission in the catalog describes these, and inventing one
 * would be wrong in a specific way: a guest, who by design holds no role-based
 * permissions at all, must still be able to do them.
 *
 * Kept distinct from `publicRoute` because the manifest is the document that
 * answers "what is reachable without credentials", and it has to be true.
 */
export function selfRoute(meta: { selfReason: string; stepUp?: boolean }) {
  if (meta.selfReason.trim().length === 0) {
    throw new Error('selfRoute requires a non-empty reason.');
  }

  return procedure
    .meta({
      permission: null,
      selfReason: meta.selfReason,
      ...(meta.stepUp === undefined ? {} : { stepUp: meta.stepUp }),
    })
    .use(async ({ ctx, next, meta: routeMeta }) => next({ ctx: requireAuth(ctx, routeMeta) }));
}

/**
 * Authenticated route, org resolved, no permission beyond MEMBERSHIP (Phase 9,
 * ai/phase-9-notifications.md).
 *
 * Neither `route({ permission })` nor `selfRoute` fits a route like "read your
 * own notifications": the data is genuinely per-org (`platform.notifications`
 * carries `org_id` and is read through `withOrgScope`, unlike `selfRoute`'s
 * usual "answers with no org selected"), but no single `Permission` describes
 * it either. Notifications span three products with three different
 * catalogs — `channel:read`, `card:read`, `page:read` — and a member who
 * holds only one of them (a Work-only guest, say) still has to be able to
 * read a `card.assigned` notification sitting in their own bell.
 * `couldGrant(subject, 'channel:read')` for that guest is `false`: it checks
 * whether ANY tuple the subject holds could grant the named permission
 * somewhere, and a guest with no chat tuple at all holds none that would.
 * Picking any ONE of the three catalogs to gate on would refuse every member
 * who only participates in the other two — this is `chat/router.ts`'s old
 * `channel:read` mistake generalized across three products instead of
 * within one, not a new kind of bug.
 *
 * So this checks membership only: `requireOrg` already answers "is this
 * caller in the org named by the header", the same check `route()` performs
 * before its own `couldGrant`. This route builder stops there.
 */
export function memberRoute(meta: { memberReason: string; stepUp?: boolean }) {
  if (meta.memberReason.trim().length === 0) {
    throw new Error('memberRoute requires a non-empty reason.');
  }

  return procedure
    .meta({
      permission: null,
      memberReason: meta.memberReason,
      ...(meta.stepUp === undefined ? {} : { stepUp: meta.stepUp }),
    })
    .use(async ({ ctx, next, meta: routeMeta }) =>
      next({ ctx: requireOrg(requireAuth(ctx, routeMeta)) }),
    );
}

/**
 * A cross-tenant platform-operator route (Phase 12 §3.2).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — a new privilege-escalation surface of the
 * same shape as `apps/api/src/identity` and `apps/collab/src/auth.ts`.
 *
 * Does NOT call `requireOrg` — a platform-admin request carries no
 * `x-taskflow-org` header and needs none; its authority is relative to no
 * org at all, the same structural fact `packages/policy/src/permissions.ts`
 * makes about `RESOURCE_TYPES` never gaining a `'platform'` entry.
 *
 * Every route built with this requires step-up UNCONDITIONALLY, no
 * per-route opt-out — unlike `route()`, where `stepUp` is an explicit flag
 * because most permissions do not warrant it, everything reachable through
 * this builder is cross-tenant by definition, and PLAN.md §8.1 already
 * treats "acting across tenant boundaries" at the same severity as the
 * operations already on the step-up list.
 *
 * `isPlatformOperator`, not `couldGrant`/`can()` — a platform operator's
 * authority does not come from a membership row or a relationship tuple, so
 * the policy engine has nothing to ask. A `false` here is an honest
 * `FORBIDDEN`, the same shape every other permission boundary in this
 * codebase already returns, never a disguised 404 (§8.2's own "the UI never
 * re-derives authorization" holds here exactly as everywhere else — the
 * `/platform-admin` pages render for anyone who reaches the URL and let the
 * server's answer decide what's visible).
 *
 * `platformAdmin.self.check` deliberately does NOT go through this builder
 * — see that route's own comment in `platform-admin/router.ts` for why
 * routing it through step-up would create a real, avoidable dead-end for
 * every ordinary member's account menu.
 */
export function platformRoute(meta: { platformReason: string }) {
  if (meta.platformReason.trim().length === 0) {
    throw new Error('platformRoute requires a non-empty reason.');
  }

  return procedure
    .meta({
      permission: null,
      platformReason: meta.platformReason,
      stepUp: true,
    })
    .use(async ({ ctx, next, meta: routeMeta, path, input }) => {
      const authed = requireAuth(ctx, routeMeta);

      if (!(await isPlatformOperator(authed.principal.userId))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          cause: new AppError('FORBIDDEN', 'You do not have permission to perform this action.'),
        });
      }

      const result = await next({ ctx: authed });

      /* "Every platformAdmin.* call, read or write, produces a row" (§4) —
         done HERE, once, rather than repeated in every service method or
         router handler, so a new route is covered by construction and
         cannot forget it. Written only on SUCCESS: a caller who is not an
         operator never reaches this line (refused above), and a
         successfully-authorized call that then fails its own business logic
         (a CONFLICT on an already-suspended org, say) did not perform the
         action its name claims — logging it would misrepresent what
         happened. `action` strips the `platformAdmin.` prefix every path
         here shares, matching the short, stable strings migration 0032's
         own header documents ('orgs.suspend', 'orgs.list', ...). */
      if (result.ok) {
        await appendOperatorAuditEntry({
          operatorId: authed.principal.userId,
          action: path.startsWith('platformAdmin.') ? path.slice('platformAdmin.'.length) : path,
          target: inferOperatorTarget(input),
        });
      }

      return result;
    });
}

/**
 * Best-effort target extraction for the operator-log entry, from whatever
 * shape a route's own Zod input already validated.
 *
 * Deliberately narrow — a fixed, known set of id-shaped fields, checked in a
 * fixed order so a route naming more than one (there are none today) is
 * still deterministic — rather than dumping the whole input, which could
 * carry a `note` or a flag `value` nobody asked to have re-logged as a
 * "target". `null` for a route with no such field (a bare list call) is a
 * real, expected answer, not a failure to infer one.
 */
function inferOperatorTarget(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;

  for (const key of ['orgId', 'toUserId', 'userId', 'flagName'] as const) {
    const value = record[key];
    if (typeof value === 'string') return { [key === 'toUserId' ? 'userId' : key]: value };
  }

  return null;
}

/** Shared gate: authentication, then step-up freshness if the route asks for it. */
function requireAuth(ctx: RequestContext, meta: RouteMeta | undefined): AuthenticatedContext {
  if (!ctx.principal) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      cause: new AppError('UNAUTHENTICATED', 'Authentication required.'),
    });
  }

  if (meta?.stepUp === true) {
    const age = Date.now() - ctx.principal.authenticatedAt.getTime();
    if (age > STEP_UP_MAX_AGE_MS) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        cause: new AppError('STEP_UP_REQUIRED', 'Please re-authenticate to continue.'),
      });
    }
  }

  return { ...ctx, principal: ctx.principal };
}

/**
 * Second gate, for permission-bearing routes only: the caller must be acting
 * inside an organization.
 *
 * A valid token with no membership is a real state — a user who has signed up
 * but joined nothing — and it is NOT an authentication failure. Answering 401
 * would send a perfectly good client into a refresh loop it can never satisfy,
 * so it is a 403 saying the resource belongs to an org this caller is not in.
 *
 * Until Phase 2 there is no membership table, so this denies every
 * permission-bearing route. That is deliberate: fabricating an org from a token
 * claim would mean the role came from the caller's own credential rather than
 * from a membership read, which is the one shortcut this design exists to
 * prevent.
 */
function requireOrg(ctx: AuthenticatedContext): OrgScopedContext {
  const { org, orgSuspended } = ctx.principal;

  if (org === null) {
    /* Two different facts, two different codes (Phase 12 §3.3). `orgSuspended`
       is set by server.ts's withOrgContext from the SAME lookup that left
       `org` null, so this is not a second query — just reading what that
       lookup already learned. */
    if (orgSuspended) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        cause: new AppError('ORG_SUSPENDED', 'This organization has been suspended.'),
      });
    }
    throw new TRPCError({
      code: 'FORBIDDEN',
      cause: new AppError('NOT_A_MEMBER', 'You are not a member of this organization.'),
    });
  }

  return { ...ctx, principal: { ...ctx.principal, org } };
}

/**
 * Deliberately public route.
 *
 * Login, registration, password reset, health. The `reason` is required and is
 * carried into the manifest, so the set of unauthenticated endpoints can be
 * listed — and reviewed — without reading every router file.
 */
export function publicRoute(meta: { publicReason: string }) {
  if (meta.publicReason.trim().length === 0) {
    // An empty string would satisfy the type while defeating the point.
    throw new Error('publicRoute requires a non-empty reason.');
  }
  return procedure.meta({ permission: null, publicReason: meta.publicReason });
}
