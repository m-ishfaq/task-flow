import { z } from 'zod';

/**
 * The API error contract (PLAN.md §7).
 *
 * EVERY failure response has this shape, without exception. A consistent
 * envelope is what lets the client handle errors generically instead of
 * pattern-matching on strings, and what makes `requestId` reliably present when
 * a user reports a problem.
 */

/**
 * Machine-readable error codes.
 *
 * Codes are part of the public contract: clients branch on them, so renaming one
 * is a breaking change. Messages are for humans and may change freely.
 */
export const ERROR_CODES = [
  /* --- Authentication (§8.1) ------------------------------------------- */
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'TOKEN_REUSED', // refresh-token reuse detected; family revoked
  'EMAIL_NOT_VERIFIED',
  'MFA_REQUIRED',
  'STEP_UP_REQUIRED', // re-authenticate for a sensitive operation

  /* --- Authorization (§8.2) -------------------------------------------- */
  'FORBIDDEN',
  'NOT_A_MEMBER',
  // Distinct from NOT_A_MEMBER on purpose: "the org itself is suspended" is
  // not "you were never in this org", and a member who is still legitimately
  // a member deserves to be told what happened and what to do next (Phase 12
  // Wave 1, ai/phase-12-admin.md §3.3).
  'ORG_SUSPENDED',
  // Distinct from ORG_SUSPENDED too: a lapsed trial/subscription and an
  // operator's manual suspension are different columns, different writers,
  // and different next steps for an Owner (Phase 12 Wave 3,
  // ai/phase-12-wave3.md §3.2).
  'ORG_BILLING_LAPSED',

  /* --- Resource --------------------------------------------------------- */
  // NOT_FOUND is deliberately returned for resources that exist but are not
  // visible to the caller. Distinguishing "does not exist" from "exists but you
  // may not see it" leaks the existence of other tenants' data.
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'CONFLICT', // optimistic concurrency: `version` mismatch
  'GONE', // hard-deleted

  /* --- Input ------------------------------------------------------------ */
  'VALIDATION_FAILED',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',

  /* --- Limits ----------------------------------------------------------- */
  'RATE_LIMITED',
  'QUOTA_EXCEEDED', // includes telephony spend caps (§8.5)

  /* --- Server ----------------------------------------------------------- */
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'NOT_IMPLEMENTED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    /**
     * Human-readable, safe to display.
     *
     * Must never contain internal detail — table names, SQL, stack traces, other
     * users' data, or whether a record exists in another tenant (§8.7).
     */
    message: z.string(),
    /** Field-level detail for VALIDATION_FAILED. Never contains secrets. */
    details: z.record(z.string(), z.unknown()).optional(),
    /** Correlates with server logs and the audit trail (§14). */
    requestId: z.string(),
    /** Present on RATE_LIMITED and QUOTA_EXCEEDED. */
    retryAfterSeconds: z.number().int().positive().optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Default HTTP status per code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REUSED: 401,
  EMAIL_NOT_VERIFIED: 403,
  MFA_REQUIRED: 401,
  STEP_UP_REQUIRED: 401,

  FORBIDDEN: 403,
  NOT_A_MEMBER: 403,
  ORG_SUSPENDED: 403,
  ORG_BILLING_LAPSED: 403,

  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  CONFLICT: 409,
  GONE: 410,

  VALIDATION_FAILED: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,

  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,

  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  NOT_IMPLEMENTED: 501,
};

export interface AppErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

/**
 * The only error type the API layer serializes to a client.
 *
 * Anything else that escapes a handler becomes INTERNAL_ERROR with a generic
 * message, so an unexpected exception cannot leak internals through its message.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (options.details !== undefined) this.details = options.details;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }

  /** Serializes to the wire contract. */
  toResponse(requestId: string): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        ...(this.details !== undefined && { details: this.details }),
        ...(this.retryAfterSeconds !== undefined && {
          retryAfterSeconds: this.retryAfterSeconds,
        }),
      },
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/* -------------------------------------------------------------------------- *
 * Constructors for the common cases
 * -------------------------------------------------------------------------- */

export const errors = {
  unauthenticated: (message = 'Authentication required.') =>
    new AppError('UNAUTHENTICATED', message),

  /**
   * The single answer for every credential failure at login.
   *
   * Wrong password, unknown address, locked account and suspended account all
   * return this. Distinguishing them tells an attacker which addresses are
   * registered and whether their guessing is making progress — and for a B2B
   * product the account list is the customer list.
   */
  invalidCredentials: (message = 'Incorrect email or password.') =>
    new AppError('INVALID_CREDENTIALS', message),

  /**
   * Deliberately distinct from `invalidCredentials`: the caller has already
   * proven they know the password, so there is nothing left to disclose, and
   * "check your email" is the only useful thing to say.
   */
  emailNotVerified: (message = 'Please verify your email address before signing in.') =>
    new AppError('EMAIL_NOT_VERIFIED', message),

  tokenExpired: (message = 'Your session has expired. Please sign in again.') =>
    new AppError('TOKEN_EXPIRED', message),

  /**
   * A refresh token was presented twice (§8.1).
   *
   * By the time this is thrown the entire session has been revoked. The message
   * is deliberately plain — the interesting half of this event goes to the audit
   * log and an alert, not to whoever is holding the token.
   */
  tokenReused: (message = 'Your session has ended. Please sign in again.') =>
    new AppError('TOKEN_REUSED', message),

  stepUpRequired: (message = 'Please re-authenticate to continue.') =>
    new AppError('STEP_UP_REQUIRED', message),

  forbidden: (message = 'You do not have permission to perform this action.') =>
    new AppError('FORBIDDEN', message),

  orgSuspended: (message = 'This organization has been suspended.') =>
    new AppError('ORG_SUSPENDED', message),

  /**
   * Distinct from `orgSuspended` on purpose (Phase 12 Wave 3,
   * ai/phase-12-wave3.md §3.2) — an Owner staring at a locked-out org needs
   * to know WHICH wall they hit ("pay us" vs. "call support"). Thrown by
   * `resolveOrgMembership` only when `billing_status = 'canceled'`, never
   * for `trialing`/`active`/`past_due`.
   */
  orgBillingLapsed: (
    message = 'This organization’s trial or subscription has ended. An owner can resolve this from Billing settings.',
  ) => new AppError('ORG_BILLING_LAPSED', message),

  /**
   * Use for resources the caller may not see, as well as those that do not
   * exist. Returning FORBIDDEN for an inaccessible resource confirms it exists,
   * which is an information leak across tenants (§8.7).
   */
  notFound: (message = 'Not found.') => new AppError('NOT_FOUND', message),

  conflict: (message = 'The resource was modified by someone else. Reload and try again.') =>
    new AppError('CONFLICT', message),

  validation: (details: Record<string, unknown>, message = 'The request was invalid.') =>
    new AppError('VALIDATION_FAILED', message, { details }),

  rateLimited: (retryAfterSeconds: number, message = 'Too many requests. Please slow down.') =>
    new AppError('RATE_LIMITED', message, { retryAfterSeconds }),

  quotaExceeded: (message = 'Quota exceeded for this organization.') =>
    new AppError('QUOTA_EXCEEDED', message),

  serviceUnavailable: (message = 'Temporarily unavailable. Please try again.') =>
    new AppError('SERVICE_UNAVAILABLE', message),

  internal: (cause?: unknown, message = 'Something went wrong.') =>
    new AppError('INTERNAL_ERROR', message, { cause }),
} as const;
