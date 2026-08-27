import {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  digestStringAsync,
  getRandomBytesAsync,
} from 'expo-crypto';
import { base64ToBase64Url, bytesToHex } from './oauth.js';

/**
 * The device half of the client-held PKCE binding (ai/phase-14-mobile.md
 * §4.4) — see `oauth.ts`'s own section header for what this defends and why
 * the server-held RFC 7636 verifier cannot.
 *
 * Its own file rather than inside `oauth.ts` for the reason that file states:
 * everything in `src/lib/` stays Expo-free and importable under plain vitest,
 * and `expo-crypto` is a native module that exists in neither Node nor Expo
 * Go. The same split `device-key.native.ts` and `device-secure-store.ts`
 * already use.
 *
 * `getRandomBytesAsync` is the platform CSPRNG — `Math.random()` is banned
 * repo-wide (guardrail 7) and would be catastrophic here specifically: a
 * predictable verifier is one an interceptor can simply recompute, which
 * turns this control back off without changing a line of its shape.
 */
export interface PkceChallenge {
  /** Held in memory only, for the life of one sign-in; sent at `callback`. */
  readonly verifier: string;
  /** S256 of `verifier`, base64url — the only half that crosses to `start`. */
  readonly challenge: string;
}

export async function createPkceChallenge(): Promise<PkceChallenge> {
  const verifier = bytesToHex(await getRandomBytesAsync(32));
  const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: CryptoEncoding.BASE64,
  });
  return { verifier, challenge: base64ToBase64Url(digest) };
}
