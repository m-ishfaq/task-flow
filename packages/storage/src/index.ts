/**
 * @taskflow/storage — object storage (PLAN.md §5, §8.4).
 *
 * One S3-compatible implementation covers MinIO in development, Cloudflare R2
 * on the free tier, and S3 past 10 GB. Swapping between them is configuration,
 * which is the whole reason `StorageProvider` is an interface in
 * @taskflow/contracts rather than a class here.
 *
 * The security behaviour this package is responsible for:
 *   - The API never handles upload bytes; the browser PUTs to a presigned URL.
 *   - Object keys are SERVER-GENERATED. Nothing from a client reaches a key.
 *   - Downloads are short-lived presigned URLs issued after an authorization
 *     check, never public objects.
 *
 * The magic-byte and virus-scan steps of the upload pipeline live in
 * @taskflow/security, where every security primitive is reviewed together.
 */

export { S3StorageProvider, readPrefix, readAll, type S3Config } from './s3.js';

export { newStorageKey, isGeneratedKey, orgOfKey, safeDispositionName } from './keys.js';
