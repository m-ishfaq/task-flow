import { TRPCError, initTRPC } from '@trpc/server';
import { AppError, isAppError, type ApiError } from '@taskflow/contracts';
import { can, type Permission } from '@taskflow/policy';
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
        : fromTrpcError(error.code).toResponse(requestId);

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
function fromTrpcError(code: string): AppError {
  switch (code) {
    case 'BAD_REQUEST':
      return new AppError('VALIDATION_FAILED', 'The request was not valid.');
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
 * The check here is the ORG-LEVEL capability gate — "may a member of this role
 * do this kind of thing at all". It runs before the handler and therefore before
 * any row is loaded, which is exactly why it cannot be the whole story:
 * per-resource authorization needs the resource, so a handler that touches one
 * calls `enforce()` from @taskflow/policy once it has loaded the row. Layer 1
 * narrows; layer 2 decides.
 */
export function route(meta: { permission: Permission; stepUp?: boolean }) {
  return procedure.meta(meta).use(async ({ ctx, next, meta: routeMeta }) => {
    const scoped = requireOrg(requireAuth(ctx, routeMeta));

    const decision = can(subjectOf(scoped.principal), meta.permission);
    if (!decision.allowed) {
      // The trace goes on the audit entry, never to the client — telling a
      // caller which rule denied them is a map of the permission model.
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
  const { org } = ctx.principal;

  if (org === null) {
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
