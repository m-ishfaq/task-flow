import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

/**
 * Passkeys / WebAuthn (PLAN.md §8.1).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2).
 *
 * ## Why this file exists at all
 *
 * @simplewebauthn does the cryptography. What it does NOT do is stop a call site
 * from passing the wrong options, and in WebAuthn the options ARE the security
 * model. Three of them decide whether any of this is worth having:
 *
 *   - **`expectedOrigin`** — the anti-phishing property. The browser puts the
 *     origin it was on into the signed client data, so a credential registered
 *     for `rinavai.io` cannot be asserted to `r1navai.io`. Take the expected
 *     origin from the request and that property is gone; it must come from
 *     configuration, which is why `RelyingParty` is built once at boot.
 *   - **`expectedRPID`** — same idea, one level down. Without it a credential
 *     scoped to a sibling subdomain is accepted.
 *   - **`requireUserVerification`** — the difference between one factor and two.
 *     With it off, a passkey proves possession of an unlocked device and nothing
 *     more; §8.1 makes passkeys the PRIMARY factor, so it stays on.
 *
 * Everything here pins those. A caller supplies who is registering, never how
 * the verification is done. That is the same reason `node:crypto` is banned
 * outside this package: one file to audit beats a convention to remember.
 */

export interface RelyingParty {
  /** Shown by the authenticator's UI when the user picks a passkey. */
  readonly name: string;
  /** The registrable domain. A credential is bound to it and to nothing else. */
  readonly id: string;
  /** Full origin the ceremony must have happened on, scheme included. */
  readonly origin: string;
}

export interface PasskeyUser {
  /** Our own user id. Goes to the authenticator, so it must not be a secret. */
  readonly id: string;
  /** Shown in the account chooser — the email. */
  readonly name: string;
  readonly displayName: string;
}

export interface StoredCredential {
  /** Base64URL, as the browser reports it. Stored in that form to avoid re-encoding. */
  readonly id: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports?: readonly AuthenticatorTransportFuture[];
}

export interface RegisteredCredential {
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: readonly string[];
  readonly aaguid: string;
  /** `singleDevice` never leaves the authenticator; `multiDevice` syncs. */
  readonly deviceType: 'singleDevice' | 'multiDevice';
  readonly backedUp: boolean;
}

/**
 * How long a ceremony may take, in milliseconds.
 *
 * A hint to the browser, not a security control — the server's own challenge
 * expiry is what actually bounds the window. Long enough to find a security key
 * in a bag.
 */
const CEREMONY_TIMEOUT_MS = 120_000;

/**
 * Ed25519, ES256, RS256.
 *
 * Pinned rather than left to the library default, which is the same list today.
 * An algorithm list that silently grows is a supply-chain path into the
 * signature verification of the primary authentication factor.
 */
const SUPPORTED_ALGORITHMS = [-8, -7, -257];

/**
 * Attestation is deliberately NOT requested.
 *
 * Verifying it means maintaining the FIDO Metadata Service blob and a set of
 * root certificates, and the only thing it buys is the ability to refuse
 * specific authenticator models. Asking for `direct` without verifying it — the
 * common shape — records an attestation nobody checks, which reads like
 * assurance and is not. Enterprise attestation policy belongs with the
 * device-management features in Phase 12.
 */
const ATTESTATION = 'none' as const;

/**
 * Derives the relying party from the web origin.
 *
 * Refuses anything that is not a secure context, because the browser will refuse
 * it too — and failing at boot with a clear message beats a WebAuthn call that
 * silently does nothing in a deployed environment.
 */
export function relyingPartyFrom(webOrigin: string, name: string): RelyingParty {
  const url = new URL(webOrigin);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  if (url.protocol !== 'https:' && !isLocal) {
    throw new Error(
      `WebAuthn requires a secure context: ${webOrigin} is neither https nor localhost. ` +
        'The browser will refuse every ceremony, so there is nothing to be gained by continuing.',
    );
  }

  return {
    name,
    /* The HOSTNAME, not the origin. A credential is scoped to a registrable
       domain; including the port or scheme here produces an rpID no browser
       will match, and the failure surfaces as "no passkeys available" rather
       than as an error. */
    id: url.hostname,
    // Normalized: `new URL()` drops a default port and a trailing slash, and the
    // origin in signed client data will not have them either.
    origin: url.origin,
  };
}

/**
 * Options for creating a passkey.
 *
 * `excludeCredentials` carries the user's existing credentials so the
 * authenticator refuses to enroll one it already holds. Without it a user
 * "adding a second passkey" silently overwrites the first on the same device and
 * believes they have two.
 */
export async function beginPasskeyRegistration(input: {
  rp: RelyingParty;
  user: PasskeyUser;
  existing: readonly { id: string; transports?: readonly string[] }[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: input.rp.name,
    rpID: input.rp.id,
    userID: new TextEncoder().encode(input.user.id),
    userName: input.user.name,
    userDisplayName: input.user.displayName,
    timeout: CEREMONY_TIMEOUT_MS,
    attestationType: ATTESTATION,
    supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    excludeCredentials: input.existing.map((credential) => ({
      id: credential.id,
      ...(credential.transports === undefined
        ? {}
        : { transports: [...credential.transports] as AuthenticatorTransportFuture[] }),
    })),
    authenticatorSelection: {
      /* Discoverable, so signing in never has to ask "who are you?" first. That
         removes the username-enumeration problem from the login page entirely:
         there is no field to probe. */
      residentKey: 'required',
      requireResidentKey: true,
      // See the file header: this is what makes a passkey two factors.
      userVerification: 'required',
    },
  });
}

export class PasskeyVerificationError extends Error {
  constructor() {
    // One message for every failure, as with access tokens. Which check failed
    // is useful only to someone probing the ceremony.
    super('Passkey verification failed.');
    this.name = 'PasskeyVerificationError';
  }
}

/** Verifies a newly created passkey and returns what must be stored. */
export async function completePasskeyRegistration(input: {
  rp: RelyingParty;
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}): Promise<RegisteredCredential> {
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.id,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    });
  } catch {
    throw new PasskeyVerificationError();
  }

  if (!verification.verified) throw new PasskeyVerificationError();

  const { credential, aaguid, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;

  return {
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports ?? [],
    aaguid,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  };
}

/**
 * Options for signing in with a passkey.
 *
 * `allowCredentials` is deliberately omitted. Supplying it means the server has
 * to be told WHO is signing in before the ceremony starts, and answering "which
 * credentials does this email have" is an account-existence oracle on the login
 * page — the exact disclosure the rest of the identity slice works to avoid. The
 * credential is discoverable, so the authenticator already knows.
 */
export async function beginPasskeyAuthentication(input: {
  rp: RelyingParty;
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: input.rp.id,
    timeout: CEREMONY_TIMEOUT_MS,
    userVerification: 'required',
  });
}

export interface PasskeyAssertion {
  /** Store this. A value that does not increase across uses means a clone. */
  readonly newCounter: number;
  readonly userVerified: boolean;
}

/**
 * Verifies a passkey assertion.
 *
 * The signature counter check is inside the library and is the reason `counter`
 * has to be persisted: an authenticator that reports a value at or below the one
 * already stored has been cloned, because a genuine one only ever counts up.
 * Many platform authenticators report 0 forever, which is why the check applies
 * only once a nonzero count has been seen.
 */
export async function completePasskeyAuthentication(input: {
  rp: RelyingParty;
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  credential: StoredCredential;
}): Promise<PasskeyAssertion> {
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.rp.origin,
      expectedRPID: input.rp.id,
      requireUserVerification: true,
      credential: {
        id: input.credential.id,
        /* Copied rather than passed through. The library's `Uint8Array_` is
           `Uint8Array<ArrayBuffer>` — it will not accept a view that might be
           backed by a SharedArrayBuffer — and a copy of a public key costs
           nothing next to a `as` cast in the middle of signature verification. */
        publicKey: new Uint8Array(input.credential.publicKey),
        counter: input.credential.counter,
        ...(input.credential.transports === undefined
          ? {}
          : { transports: [...input.credential.transports] }),
      },
    });
  } catch {
    throw new PasskeyVerificationError();
  }

  if (!verification.verified) throw new PasskeyVerificationError();

  return {
    newCounter: verification.authenticationInfo.newCounter,
    userVerified: verification.authenticationInfo.userVerified,
  };
}

export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
};
