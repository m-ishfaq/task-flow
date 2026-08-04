import { S3StorageProvider } from '@taskflow/storage';
import type { Env } from '../config/env.js';
import type { WorkRouterDeps } from './router.js';

/**
 * Wiring for the Work module's external dependencies.
 *
 * Only attachments need any. Everything else in Work reaches the tenant-scoped
 * database and the policy engine, both of which are module-level and stateless.
 *
 * Built from the validated environment rather than read from `process.env`
 * (guardrail 7), and constructed once at boot rather than per request: the S3
 * client holds a connection pool, and building one per upload would open a new
 * TLS session for every attachment.
 */
export function buildWorkDeps(env: Env): WorkRouterDeps {
  const storage = new S3StorageProvider({
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    bucket: env.STORAGE_BUCKET_ATTACHMENTS,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
  });

  return {
    attachments: {
      storage,
      scanner: { host: env.CLAMAV_HOST, port: env.CLAMAV_PORT },
      /* One limit, used twice: pinned into the upload signature so storage
         refuses a larger body, and as the ceiling on the server-side read
         during scanning so a lying backend cannot exhaust memory. */
      maxBytes: env.STORAGE_MAX_UPLOAD_BYTES,
    },
  };
}
