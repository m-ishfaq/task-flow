import pino, { type Logger, type LoggerOptions } from 'pino';
import { getRequestContext } from './context.js';
import { REDACTION_CENSOR, REDACTION_PATHS } from './redaction.js';

export type { Logger };

export interface LoggerConfig {
  /** Service name — becomes the `service` field on every line. */
  readonly name: string;
  readonly level?: string;
  /** Human-readable output. Enable in local dev only; it is slow. */
  readonly pretty?: boolean;
}

/**
 * Creates the root logger for a service.
 *
 * Every service in the workspace imports from @taskflow/observability rather than
 * constructing pino directly — that is what guarantees redaction is applied
 * uniformly. A service that builds its own logger silently opts out of §8.7.
 */
export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    name: config.name,
    level: config.level ?? 'info',

    // The security control. See redaction.ts before editing.
    redact: {
      paths: [...REDACTION_PATHS],
      censor: REDACTION_CENSOR,
    },

    // Attach request correlation to every line automatically.
    mixin() {
      const ctx = getRequestContext();
      if (!ctx) return {};
      return {
        requestId: ctx.requestId,
        ...(ctx.userId !== undefined && { userId: ctx.userId }),
        ...(ctx.orgId !== undefined && { orgId: ctx.orgId }),
        ...(ctx.route !== undefined && { route: ctx.route }),
      };
    },

    formatters: {
      // `level: "info"` rather than `level: 30` — log aggregators handle the
      // string form far better.
      level: (label) => ({ level: label }),
    },

    timestamp: pino.stdTimeFunctions.isoTime,

    // Error objects must serialize with stack and cause intact.
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
  };

  if (config.pretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(options);
}

/**
 * Child logger bound to a subsystem, e.g. `logger.child({ module: 'auth' })`.
 * Inherits redaction and the request-context mixin.
 */
export function childLogger(parent: Logger, bindings: Record<string, string>): Logger {
  return parent.child(bindings);
}
