/**
 * @taskflow/security — every cryptographic primitive the system uses.
 *
 * Guardrail 7 (PLAN.md §2.1): `Math.random()` and direct `node:crypto` imports
 * are both banned workspace-wide, so anything security-relevant has to come
 * through here. That is the whole design goal — not that these implementations
 * are clever, but that there is exactly one place to audit and one place a
 * mistake can live.
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2). Changes here need the author to read every
 * line, plus a second adversarial AI pass in a fresh context. Cryptographic code
 * fails silently: a broken nonce, a skipped tag check, or a comparison that
 * short-circuits all produce output that looks completely correct.
 */

export {
  secureBytes,
  secureInt,
  secureToken,
  secureHex,
  secureCode,
  secureEqual,
  wipe,
  HUMAN_ALPHABET,
} from './random.js';

export { uuidv7, newId, timestampOf } from './uuid.js';

export {
  hashPassword,
  verifyPassword,
  fakeVerifyPassword,
  needsRehash,
  ARGON2_PARAMS,
  MAX_PASSWORD_LENGTH,
} from './password.js';

export {
  issueToken,
  issueNumericCode,
  issueHumanCode,
  hashToken,
  verifyToken,
  isTokenKind,
  TOKEN_PREFIX,
  type TokenKind,
  type IssuedToken,
} from './tokens.js';

export {
  encrypt,
  decrypt,
  encryptString,
  decryptString,
  fieldAad,
  identityFieldAad,
  DecryptionError,
  AES_KEY_BYTES,
} from './encryption.js';

export {
  SoftwareKeyProvider,
  masterKeysFromBase64,
  generateMasterKeyBase64,
  type MasterKey,
  type SoftwareKeyProviderConfig,
} from './software-key-provider.js';

export { checkPasswordBreached, type BreachResult, type BreachCheckOptions } from './breach.js';

export {
  signAccessToken,
  verifyAccessToken,
  signTotpChallenge,
  verifyTotpChallenge,
  signOAuthState,
  verifyOAuthState,
  InvalidTokenError,
  ACCESS_TOKEN_TTL_SECONDS,
  type AccessTokenClaims,
  type TotpChallengeClaims,
  type OAuthStateClaims,
  type JwtConfig,
} from './jwt.js';

export {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  completePasskeyAuthentication,
  completePasskeyRegistration,
  relyingPartyFrom,
  PasskeyVerificationError,
  type AuthenticationResponseJSON,
  type PasskeyAssertion,
  type PasskeyUser,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegisteredCredential,
  type RegistrationResponseJSON,
  type RelyingParty,
  type StoredCredential,
} from './webauthn.js';

export {
  auditEntryHash,
  verifyAuditChain,
  type AuditChainEntry,
  type ChainBreak,
  type ChainVerification,
  type StoredAuditEntry,
} from './audit-chain.js';

/**
 * Upload pipeline primitives (§8.4).
 *
 * Both live here rather than in the API for the reason the crypto ban exists:
 * one file per security concern, on the human-review list, instead of a
 * hand-rolled byte comparison in whatever service happened to need it.
 */
export {
  verifyMagicBytes,
  isAcceptedContentType,
  ACCEPTED_CONTENT_TYPES,
  MAGIC_BYTE_PREFIX_LENGTH,
  type SniffResult,
} from './magic-bytes.js';

export {
  scanBuffer,
  isScannerReady,
  EICAR_TEST_SIGNATURE,
  type ScanResult,
  type ScanVerdict,
  type ScannerConfig,
} from './virus-scan.js';

/**
 * Outbound URL safety (§8.7) — the SSRF control behind link unfurls.
 *
 * Here rather than in the API for the same reason the crypto ban exists: one
 * file per security concern, on the human-review list, instead of a private-IP
 * regex in whatever service happened to need one.
 */
export { isAllowedUrl, isBlockedAddress, isIpAddress, type UrlVerdict } from './outbound-url.js';

/** TOTP — a second factor (Phase 12 Wave 2 §3.2). */
export { generateTotpSecret, totpProvisioningUri, verifyTotpCode } from './totp.js';

/** OAuth sign-in (Phase 12 Wave 2 §3.3). */
export {
  generatePkcePair,
  verifyGoogleIdToken,
  type PkcePair,
  type GoogleIdentity,
} from './oauth.js';

/**
 * Web Push — VAPID signing and RFC 8291 payload encryption (Phase 9 Wave 2,
 * ai/phase-9-notifications.md §3.7).
 *
 * Here rather than in apps/api or behind a push library for the reason the
 * crypto ban exists: one file per primitive, on the human-review list,
 * instead of a hand-rolled ECDH/HKDF composition in whatever service
 * happened to need one. See `web-push.ts`'s own header for why VAPID and the
 * per-subscription ECDH key are deliberately different keys.
 *
 * Note: `encryptWithFixedInputs` and `RFC8291_VECTOR` are deliberately NOT
 * re-exported — they exist for the RFC test vector in this package only, and
 * the package index is the public surface.
 */
export {
  generateVapidKeys,
  vapidAuthorization,
  encryptPushPayload,
  isValidSubscriptionKeys,
  type VapidKeyPair,
  type EncryptedPushPayload,
} from './web-push.js';

/**
 * Twilio webhook signature verification (Phase 7 Wave 1,
 * ai/phase-7-voice.md §3.11; PLAN.md §8.5 — "Reject unsigned. Non-negotiable.").
 *
 * The one primitive standing between an unauthenticated POST from the open
 * internet and a write to this database. Here rather than in
 * `packages/telephony` because that package cannot import `node:crypto` at all,
 * and because a constant-time HMAC comparison belongs on the human-review list
 * with the rest of them.
 */
export {
  verifyTwilioSignature,
  signTwilioRequest,
  twilioSignaturePayload,
} from './twilio-signature.js';

/**
 * Outbound webhook signing (Phase 10 Wave 2, ai/phase-10-automation.md §5).
 *
 * The mirror image of `twilio-signature.ts`: that file verifies THEM, this
 * one computes the signature WE send so the receiver can do the same. Same
 * primitive — HMAC keyed by a shared secret — opposite direction, and on the
 * human-review list for the same reason.
 */
export { buildWebhookSignature, verifyWebhookSignature } from './webhook-signing.js';

/**
 * Blind indexes — equality lookup over an encrypted column (Phase 7 Wave 2).
 *
 * Here rather than in the slice that needs it because the tempting shortcuts
 * are both cryptographic mistakes — plaintext "just for the index", or
 * deterministic encryption — and this is the file where that argument gets
 * reviewed once instead of re-litigated per column.
 */
export { blindIndex, blindIndexEquals } from './blind-index.js';

/**
 * TURN credentials — coturn's `use-auth-secret` REST scheme (Phase 13 Wave 1,
 * ai/phase-13-webrtc.md §3.3).
 *
 * Here rather than in the rtc module because a static TURN secret in a client
 * bundle is the whole vulnerability this scheme exists to remove, and because
 * "which hash, keyed how, over what string" is a question that should be
 * answered once, in a reviewed file, rather than inlined next to the route that
 * needed a credential.
 */
export {
  mintTurnCredential,
  type MintTurnCredentialOptions,
  type TurnCredential,
} from './turn-credential.js';
