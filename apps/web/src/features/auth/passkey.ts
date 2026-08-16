import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from '@simplewebauthn/browser';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { api } from '../../lib/trpc.js';
import type { SessionBody } from '../../lib/session.js';

/**
 * The browser half of WebAuthn (PLAN.md §8.1).
 *
 * Every trust decision — `expectedOrigin`, `expectedRPID`, `requireUserVerification`,
 * algorithm pinning, challenge single-use — is already made in
 * `packages/security/src/webauthn.ts` and `apps/api/src/identity/passkey.service.ts`,
 * both ⚠ human-review surfaces reviewed in Phase 1. This file adds no new trust
 * decision of its own; it is the plumbing between `@simplewebauthn/browser` and the
 * two already-verified `start*`/`finish*` mutation pairs.
 */

export { browserSupportsWebAuthn };

/**
 * Why a ceremony did not produce a credential.
 *
 * A closed set, never the raw `DOMException`/`WebAuthnError`. `cancelled` covers
 * the overwhelming majority of real failures: a dismissed prompt, a timeout, and
 * (per spec) "no matching authenticator" are all reported as the SAME
 * `NotAllowedError` by every browser, with an overloaded, implementation-specific
 * `.message` — so they collapse to one reason rather than being surfaced as text,
 * and the UI treats it as "nothing happened", not an error to report. The others
 * are genuine, worth a message, but still never `error.message` verbatim: which
 * check failed is exactly the kind of detail `passkey.service.ts` already keeps
 * server-side-only for sign-in (§8.1 property 2), and leaking it through the
 * browser error text on enrollment would reopen that door from the other side.
 */
export type PasskeyCeremonyReason = 'cancelled' | 'already_registered' | 'unsupported' | 'unknown';

/**
 * The message for a ceremony failure, or `null` for one worth showing nothing.
 *
 * `cancelled` is `null`: a dismissed prompt or a timeout is not a failure to
 * report, it is the user closing a dialog, and a red banner for that trains
 * people to ignore the ones that matter. The rest translate the closed reason
 * set into a sentence a person can act on, never `error.message` — see
 * `PasskeyCeremonyReason`'s own comment for why.
 */
export function passkeyCeremonyMessage(
  reason: PasskeyCeremonyReason,
  productName = 'TaskFlow',
): string | null {
  switch (reason) {
    case 'cancelled':
      return null;
    case 'already_registered':
      return 'This device already has a passkey for this account.';
    case 'unsupported':
      return `This device or browser does not support the passkey features ${productName} requires.`;
    case 'unknown':
      return 'That passkey could not be used. Try again.';
  }
}

export class PasskeyCeremonyError extends Error {
  readonly reason: PasskeyCeremonyReason;

  constructor(reason: PasskeyCeremonyReason) {
    super(`Passkey ceremony did not complete (${reason}).`);
    this.name = 'PasskeyCeremonyError';
    this.reason = reason;
  }
}

/**
 * Maps `@simplewebauthn/browser`'s error into the closed set above.
 *
 * `startAuthentication`/`startRegistration` already run the raw `DOMException`
 * through the library's own `identify*Error` — see its source — so what reaches
 * here is a `WebAuthnError` with a `.code` rather than a bare browser exception,
 * except for the one case the library throws before ever calling the browser:
 * `browserSupportsWebAuthn()` failing inside the library itself, as a plain
 * `Error`. `kind` only matters for
 * `ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED`, which the library raises solely
 * from `startRegistration` (a device refusing to create a SECOND credential that
 * matches `excludeCredentials`) — the authentication ceremony has no exclude
 * list, so the same code there would indicate a library change worth surfacing
 * as `unknown` rather than a confident but wrong `already_registered`.
 */
function translate(error: unknown, kind: 'registration' | 'authentication'): PasskeyCeremonyError {
  if (error instanceof WebAuthnError) {
    switch (error.code) {
      // ERROR_CEREMONY_ABORTED is a genuine abort signal; ERROR_PASSTHROUGH is
      // the library's name for NotAllowedError, which every browser also uses
      // for a dismissed prompt or a timeout. Both read the same to the person:
      // nothing happened.
      case 'ERROR_CEREMONY_ABORTED':
      case 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY':
        return new PasskeyCeremonyError('cancelled');

      case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
        return new PasskeyCeremonyError(kind === 'registration' ? 'already_registered' : 'unknown');

      case 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT':
      case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT':
      case 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG':
      case 'ERROR_MALFORMED_PUBKEYCREDPARAMS':
        return new PasskeyCeremonyError('unsupported');

      // The rest are configuration/environment problems (RP ID or domain
      // mismatch, a malformed user id, an opaque authenticator failure) rather
      // than anything the person did — there is nothing more specific to tell
      // them than "that did not work".
      case 'ERROR_INVALID_DOMAIN':
      case 'ERROR_INVALID_RP_ID':
      case 'ERROR_INVALID_USER_ID_LENGTH':
      case 'ERROR_AUTHENTICATOR_GENERAL_ERROR':
      case 'ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE':
        return new PasskeyCeremonyError('unknown');
    }
  }

  return new PasskeyCeremonyError('unknown');
}

/**
 * Signs in with a passkey, end to end.
 *
 * Takes no argument, deliberately — `startAuthentication` on the server takes
 * none either, because a discoverable credential means the browser already
 * knows which accounts it holds and there is nothing here to ask the user for
 * first (§8.1).
 */
export async function signInWithPasskey(): Promise<SessionBody> {
  // `startAuthentication`'s output is `z.unknown()` on the router — the shape is
  // the library's, per its own spec, not ours to restate (passkey.router.ts).
  const options =
    (await api.auth.passkeys.startAuthentication.mutate()) as PublicKeyCredentialRequestOptionsJSON;

  let response: AuthenticationResponseJSON;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (error) {
    throw translate(error, 'authentication');
  }

  // The router's Zod input is structurally the library's response type; `as
  // never` is the client-side mirror of the same cast passkey.router.ts makes
  // crossing this boundary in the other direction.
  return api.auth.passkeys.finishAuthentication.mutate({ response: response as never });
}

/**
 * Enrolls a new passkey on the signed-in account.
 *
 * Only callable while already authenticated — `startRegistration` is a
 * `selfRoute` server-side, and the user comes from the verified access token,
 * never from an argument here.
 */
export async function enrollPasskey(name?: string): Promise<{ credentialId: string }> {
  const options =
    (await api.auth.passkeys.startRegistration.mutate()) as PublicKeyCredentialCreationOptionsJSON;

  let response: RegistrationResponseJSON;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (error) {
    throw translate(error, 'registration');
  }

  return api.auth.passkeys.finishRegistration.mutate(
    name === undefined ? { response: response as never } : { response: response as never, name },
  );
}
