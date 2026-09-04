import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACTION_CENSOR, REDACTION_PATHS, isSecretEnvVar } from './redaction.js';

/**
 * These tests exist because log redaction is a security control (§8.7), and a
 * redaction path that silently stops matching leaks credentials into a log store
 * that is retained for months and readable by people who would never be granted
 * database access.
 */

/** Captures a single log line as a parsed object. */
function captureLog(fn: (logger: pino.Logger) => void): Record<string, unknown> {
  let captured = '';
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      captured += chunk.toString();
      cb();
    },
  });

  const logger = pino({ redact: { paths: [...REDACTION_PATHS], censor: REDACTION_CENSOR } }, sink);
  fn(logger);

  return JSON.parse(captured) as Record<string, unknown>;
}

describe('log redaction', () => {
  it('redacts credentials nested in a logged object', () => {
    const line = captureLog((log) => {
      log.info({
        user: {
          email: 'moosa@example.com',
          password: 'hunter2',
          passwordHash: '$argon2id$v=19$...',
        },
      });
    });

    const user = line['user'] as Record<string, unknown>;
    expect(user['password']).toBe(REDACTION_CENSOR);
    expect(user['passwordHash']).toBe(REDACTION_CENSOR);
    // Non-secret fields must survive — over-redaction destroys debuggability.
    expect(user['email']).toBe('moosa@example.com');
  });

  it('redacts authorization and cookie headers', () => {
    const line = captureLog((log) => {
      log.info({
        req: {
          headers: {
            authorization: 'Bearer eyJhbGciOi...',
            cookie: '__Host-refresh=abc123',
            'user-agent': 'Mozilla/5.0',
          },
        },
      });
    });

    const headers = (line['req'] as Record<string, Record<string, unknown>>)['headers']!;
    expect(headers['authorization']).toBe(REDACTION_CENSOR);
    expect(headers['cookie']).toBe(REDACTION_CENSOR);
    expect(headers['user-agent']).toBe('Mozilla/5.0');
  });

  it('redacts tokens, keys, and telephony PII', () => {
    const line = captureLog((log) => {
      log.info({
        session: { refreshToken: 'rt_live_xyz', accessToken: 'at_live_xyz' },
        crypto: { dataKey: 'base64key==' },
        call: { phoneNumber: '+15551234567', recordingUrl: 'https://api.twilio.com/rec/abc' },
      });
    });

    const session = line['session'] as Record<string, unknown>;
    const cryptoFields = line['crypto'] as Record<string, unknown>;
    const call = line['call'] as Record<string, unknown>;

    expect(session['refreshToken']).toBe(REDACTION_CENSOR);
    expect(session['accessToken']).toBe(REDACTION_CENSOR);
    expect(cryptoFields['dataKey']).toBe(REDACTION_CENSOR);
    expect(call['phoneNumber']).toBe(REDACTION_CENSOR);
    expect(call['recordingUrl']).toBe(REDACTION_CENSOR);
  });

  it('DOES NOT redact secrets interpolated into a message string', () => {
    // Documents a real, permanent limitation: pino redacts by object path, so a
    // secret concatenated into the message text passes straight through.
    // Redaction is a backstop — never deliberately log a secret and rely on it.
    const leakedSecret = 'rt_live_xyz';
    const line = captureLog((log) => {
      log.info(`token is ${leakedSecret}`);
    });

    expect(line['msg']).toContain(leakedSecret);
  });
});

describe('isSecretEnvVar', () => {
  it.each([
    'JWT_PRIVATE_KEY',
    'JWT_PUBLIC_KEY',
    'JWT_STATE_SECRET',
    'MASTER_KEY_BASE64',
    'STORAGE_SECRET_ACCESS_KEY',
    'DATABASE_URL',
    'TWILIO_AUTH_TOKEN',
    'ADMIN_PASSWORD',
  ])('treats %s as secret', (name) => {
    expect(isSecretEnvVar(name)).toBe(true);
  });

  it.each(['NODE_ENV', 'LOG_LEVEL', 'API_PORT', 'STORAGE_BUCKET_ATTACHMENTS'])(
    'treats %s as safe to print',
    (name) => {
      expect(isSecretEnvVar(name)).toBe(false);
    },
  );
});
