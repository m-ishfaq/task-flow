import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped context (PLAN.md §14).
 *
 * Carried implicitly through the async call tree so every log line, error
 * report, and audit entry can be correlated without threading a context object
 * through every function signature.
 *
 * `orgId` is present for observability only. It must NEVER be read to make an
 * authorization or tenant-scoping decision — those come from the verified token
 * via the request context in the data layer (§8.3). Reading tenancy from an
 * ambient store is exactly how cross-tenant bugs get introduced.
 */
export interface RequestContext {
  /** Correlates logs, error reports, and the API error envelope. */
  readonly requestId: string;
  readonly userId?: string;
  readonly orgId?: string;
  readonly sessionId?: string;
  /** tRPC procedure path or HTTP route, for grouping in dashboards. */
  readonly route?: string;
  readonly ip?: string;
  readonly userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` available to everything it awaits. */
export function withRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The active request context, or undefined outside a request (jobs, boot). */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Adds fields to the active context.
 *
 * Used when identity is established mid-request — the request ID exists before
 * authentication, but userId and orgId only appear after the token is verified.
 * Returns false when called outside a request rather than throwing, so that
 * background jobs sharing service code are not forced to fabricate a context.
 */
export function enrichRequestContext(fields: Partial<Omit<RequestContext, 'requestId'>>): boolean {
  const current = storage.getStore();
  if (!current) return false;
  Object.assign(current, fields);
  return true;
}
