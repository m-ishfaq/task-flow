/**
 * @taskflow/observability — the single entry point for logging, correlation,
 * and (from Phase 9) metrics and tracing.
 *
 * Nothing in the workspace imports `pino`, `@sentry/*`, or OpenTelemetry
 * directly. Routing everything through this package is what guarantees log
 * redaction (§8.7) is applied uniformly — a service that builds its own logger
 * silently opts out of it.
 */

export { createLogger, childLogger, type Logger, type LoggerConfig } from './logger.js';

export {
  withRequestContext,
  getRequestContext,
  enrichRequestContext,
  type RequestContext,
} from './context.js';

export {
  REDACTION_PATHS,
  REDACTION_CENSOR,
  isSecretEnvVar,
  SECRET_ENV_PATTERN,
} from './redaction.js';

/*
 * Deferred, with their import sites already fixed so adding them is additive:
 *
 *   Phase 4  — `metrics`: Prometheus counters/histograms for request duration,
 *              socket connections, queue depth (§14).
 *   Phase 9  — `trace`:   OpenTelemetry spans exported to Grafana Tempo (§14).
 *   Phase 13 — `errors`:  Sentry wrapper with release tagging and the same
 *              redaction paths applied to event payloads.
 */
