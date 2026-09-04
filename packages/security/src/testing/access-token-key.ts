import { generateKeyPair, type CryptoKey } from 'jose';

/**
 * A software RS256 key pair, for tests that need a SECOND key distinct from
 * whatever fixture (`TEST_JWT_PRIVATE_KEY`/`TEST_JWT_PUBLIC_KEY` in
 * `apps/api/src/testing/fixtures.ts`, for instance) signs the tokens under
 * test — e.g. proving a token signed by a different key is refused.
 * Exported from `@taskflow/security/testing` rather than the package root,
 * mirroring `generateTestDeviceKey`, so nothing outside a test can reach it.
 */
export interface TestAccessTokenKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

export async function generateTestAccessTokenKeyPair(): Promise<TestAccessTokenKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  return { privateKey, publicKey };
}
