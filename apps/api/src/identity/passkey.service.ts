import { errors } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  completePasskeyAuthentication,
  completePasskeyRegistration,
  newId,
  PasskeyVerificationError,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type RelyingParty,
} from '@taskflow/security';
import * as repo from './repository.js';
import * as passkeys from './passkey.repository.js';
import * as identityEvents from './events.js';
import {
  SYSTEM_ORG,
  issueSession,
  type IdentityDeps,
  type RequestMeta,
} from './identity.service.js';
import type { TokenPair } from './identity.service.js';

/**
 * Passkeys (PLAN.md §8.1) — WebAuthn as the primary authentication factor.
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2).
 *
 * The cryptography and the option-pinning live in @taskflow/security. What lives
 * here is the part a library cannot do for you: deciding which user a ceremony
 * belongs to, and making sure a challenge is spent exactly once.
 *
 * Three properties, each easy to lose to a change that looks like a
 * simplification:
 *
 *   1. **A challenge is single-use.** Enforced by a conditional UPDATE, not by
 *      reading then deleting. A replayed assertion is a complete authentication
 *      bypass.
 *   2. **Sign-in reveals nothing about who exists.** The ceremony starts with no
 *      email and no `allowCredentials`, so there is nothing to probe. The
 *      failure answer is identical for an unknown credential, a bad signature,
 *      and a suspended account.
 *   3. **A user cannot lock themselves out.** Removing the last way to sign in
 *      is refused rather than confirmed.
 */

/**
 * How long a ceremony challenge stays valid.
 *
 * Five minutes: long enough to find a security key, short enough that a
 * challenge captured from a network log is worthless by the time it is used. The
 * browser has its own shorter timeout; this is the one that is actually enforced.
 */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface PasskeyDeps extends IdentityDeps {
  readonly relyingParty: RelyingParty;
}

const clock = (deps: PasskeyDeps): Date => (deps.now ?? (() => new Date()))();

/* -------------------------------------------------------------------------- *
 * Enrollment — always by an already-authenticated user
 * -------------------------------------------------------------------------- */

/**
 * Starts adding a passkey to the signed-in account.
 *
 * The user comes from the verified access token, never from the request. An
 * endpoint that took a user id here would let anyone enroll their own
 * authenticator against someone else's account, which is account takeover with
 * extra steps.
 */
export async function startRegistration(
  deps: PasskeyDeps,
  input: { userId: string },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const user = await repo.findUserById(input.userId);
  if (!user) throw errors.notFound('Account not found.');

  const existing = await passkeys.listCredentials(user.id);

  const options = await beginPasskeyRegistration({
    rp: deps.relyingParty,
    user: {
      id: user.id,
      name: user.email,
      displayName: user.email,
    },
    existing: existing.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports,
    })),
  });

  const now = clock(deps);
  await passkeys.createChallenge({
    id: newId<'ChallengeId'>(),
    challenge: options.challenge,
    userId: user.id,
    purpose: 'registration',
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  });

  return options;
}

export async function finishRegistration(
  deps: PasskeyDeps,
  input: { userId: string; response: RegistrationResponseJSON; name?: string },
): Promise<{ credentialId: string }> {
  const now = clock(deps);

  const claimed = await passkeys.consumeChallenge({
    challenge: challengeOf(input.response),
    purpose: 'registration',
    now,
  });

  if (!claimed) throw errors.validation({ response: 'That enrollment has expired. Start again.' });

  /* The challenge names the user it was issued to, and it must be the caller.
     Without this, an attacker who is signed in as themselves could start an
     enrollment, then complete it with a challenge issued for a different
     account — binding their authenticator to that account. */
  if (claimed.userId !== input.userId) throw errors.forbidden();

  const credential = await verifyEnrollment(deps, input.response, claimed.challenge);

  const stored = await passkeys.createCredential({
    id: newId<'CredentialId'>(),
    userId: input.userId,
    credentialId: credential.credentialId,
    publicKey: credential.publicKey,
    signCount: credential.counter,
    transports: [...credential.transports],
    aaguid: credential.aaguid,
    deviceType: credential.deviceType,
    backedUp: credential.backedUp,
    name: input.name ?? null,
  });

  /* Already registered — to this account or to another. Both answer the same:
     saying "that key belongs to someone else" confirms a credential id maps to
     an account, and a credential id is something an attacker can obtain by
     asking an authenticator they hold. */
  if (!stored) throw errors.conflict('That passkey is already registered.');

  await deps.events.publish([
    createEvent(
      identityEvents.passkeyRegistered,
      {
        userId: input.userId,
        credentialId: credential.credentialId,
        deviceType: credential.deviceType,
        backedUp: credential.backedUp,
      },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
  ]);

  /* Security-relevant account change, told to the person it happened to —
     the same reasoning `issueSession`'s impossible-travel send gives.
     Best-effort: a mail failure must not undo a passkey that already
     registered successfully. */
  const user = await repo.findUserById(input.userId);
  if (user !== undefined) {
    await deps.deliver({ kind: 'passkey_registered', email: user.email });
  }

  return { credentialId: credential.credentialId };
}

/* -------------------------------------------------------------------------- *
 * Sign-in
 * -------------------------------------------------------------------------- */

/**
 * Starts a passkey sign-in.
 *
 * Takes NO input. There is no email field, so there is nothing to enumerate —
 * the credential is discoverable and the authenticator already knows which
 * accounts it holds. This is the one flow in the identity slice that is immune
 * to account-existence probing by construction rather than by careful answering.
 */
export async function startAuthentication(
  deps: PasskeyDeps,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await beginPasskeyAuthentication({ rp: deps.relyingParty });

  const now = clock(deps);
  await passkeys.createChallenge({
    id: newId<'ChallengeId'>(),
    challenge: options.challenge,
    userId: null,
    purpose: 'authentication',
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
  });

  return options;
}

export async function finishAuthentication(
  deps: PasskeyDeps,
  input: { response: AuthenticationResponseJSON },
  meta: RequestMeta,
): Promise<TokenPair> {
  const now = clock(deps);

  const claimed = await passkeys.consumeChallenge({
    challenge: challengeOf(input.response),
    purpose: 'authentication',
    now,
  });
  if (!claimed) throw invalidPasskey();

  const credential = await passkeys.findCredential(input.response.id);
  if (!credential) {
    await publishFailure(deps, now, { userId: null, reason: 'unknown_credential', ip: meta.ip });
    throw invalidPasskey();
  }

  const user = await repo.findUserById(credential.userId);
  if (user?.status !== 'active') {
    await publishFailure(deps, now, {
      userId: credential.userId,
      reason: 'suspended',
      ip: meta.ip,
    });
    throw invalidPasskey();
  }

  /* A locked account stays locked for passkeys too. The lockout exists because
     an account is under attack, and leaving a second door open while the first
     is bolted is not a defence. */
  if (user.lockedUntil && user.lockedUntil > now) {
    await publishFailure(deps, now, { userId: user.id, reason: 'locked', ip: meta.ip });
    throw invalidPasskey();
  }

  let assertion;
  try {
    assertion = await completePasskeyAuthentication({
      rp: deps.relyingParty,
      response: input.response,
      expectedChallenge: claimed.challenge,
      credential: {
        id: credential.credentialId,
        publicKey: credential.publicKey,
        counter: credential.signCount,
        transports: credential.transports as never,
      },
    });
  } catch (error) {
    if (!(error instanceof PasskeyVerificationError)) throw error;
    await publishFailure(deps, now, { userId: user.id, reason: 'bad_signature', ip: meta.ip });
    throw invalidPasskey();
  }

  await passkeys.recordCredentialUse({
    credentialId: credential.credentialId,
    signCount: assertion.newCounter,
    now,
  });

  /* Passkey sign-in does NOT require a verified email.
   *
   * Verification proves control of a mailbox, which for a password account is
   * the only thing standing between a stranger who typed your address and an
   * account in your name. A passkey proves possession of a specific
   * authenticator plus a user-verification gesture, and it can only have been
   * enrolled by someone already signed in — so the mailbox check has nothing
   * left to add here. */
  const pair = await issueSession(deps, user.id, now, now, meta);

  await deps.events.publish([
    createEvent(
      identityEvents.userLoggedIn,
      {
        userId: user.id,
        sessionId: pair.sessionId,
        method: 'passkey' as const,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
  ]);

  await repo.clearLoginFailures(user.id, now);
  return pair;
}

/* -------------------------------------------------------------------------- *
 * Management
 * -------------------------------------------------------------------------- */

export interface PasskeySummary {
  readonly id: string;
  readonly name: string | null;
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

/**
 * The user's own passkeys.
 *
 * Deliberately omits `credentialId` and the public key. Neither is a secret, but
 * neither is any use to a UI either, and the smallest response that does the job
 * is the one that cannot leak something later.
 */
export async function listPasskeys(userId: string): Promise<PasskeySummary[]> {
  const rows = await passkeys.listCredentials(userId);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }));
}

export async function renamePasskey(
  deps: PasskeyDeps,
  input: { userId: string; id: string; name: string },
): Promise<{ status: 'renamed' }> {
  const renamed = await passkeys.renameCredential(input);
  // Not found and not-yours answer the same. A distinct response would let one
  // user probe which credential ids exist.
  if (!renamed) throw errors.notFound('Passkey not found.');

  void deps;
  return { status: 'renamed' };
}

/**
 * Removes a passkey, unless it is the last way in.
 *
 * The check is the reason this is not a one-line delete. A passkey-only
 * account that deletes its only credential is unrecoverable: there is no
 * password to fall back on, and password reset needs an account that can
 * accept one. Better to refuse and say why.
 *
 * Generalized (Phase 12 Wave 2 §3.3) to count OAuth links too — a
 * passkey-only account with a linked Google identity is not actually
 * unrecoverable, and the original two-way check would have refused this
 * deletion incorrectly once OAuth existed as a third way in.
 */
export async function deletePasskey(
  deps: PasskeyDeps,
  input: { userId: string; id: string },
): Promise<{ status: 'deleted' }> {
  const now = clock(deps);
  const user = await repo.findUserById(input.userId);
  if (!user) throw errors.notFound('Passkey not found.');

  const [remaining, oauthCount] = await Promise.all([
    passkeys.countCredentials(input.userId),
    repo.countOAuthIdentities(input.userId),
  ]);

  if (remaining <= 1 && user.passwordHash === null && oauthCount === 0) {
    throw errors.validation({
      id: 'This is the only way to sign in to this account. Add a password or another passkey first.',
    });
  }

  const deleted = await passkeys.deleteCredential(input);
  if (!deleted) throw errors.notFound('Passkey not found.');

  await deps.events.publish([
    createEvent(
      identityEvents.passkeyRemoved,
      { userId: input.userId, credentialRecordId: input.id },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
  ]);

  return { status: 'deleted' };
}

/* -------------------------------------------------------------------------- *
 * Internals
 * -------------------------------------------------------------------------- */

/**
 * Reads the challenge out of the client data the browser signed.
 *
 * Base64URL-decoded and JSON-parsed, then the `challenge` field is taken. This
 * is only used to LOOK THE ROW UP — the value is not trusted. What proves the
 * ceremony is the library comparing the signed client data against the challenge
 * this server stored, which happens after the row is claimed.
 */
function challengeOf(response: { response: { clientDataJSON: string } }): string {
  try {
    const decoded = Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);

    if (typeof parsed !== 'object' || parsed === null) return '';
    const challenge = (parsed as { challenge?: unknown }).challenge;

    return typeof challenge === 'string' ? challenge : '';
  } catch {
    // A malformed response finds no row, which is the same answer as a wrong
    // one. There is nothing to distinguish for the caller's benefit.
    return '';
  }
}

async function verifyEnrollment(
  deps: PasskeyDeps,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
) {
  try {
    return await completePasskeyRegistration({
      rp: deps.relyingParty,
      response,
      expectedChallenge,
    });
  } catch (error) {
    if (!(error instanceof PasskeyVerificationError)) throw error;
    throw errors.validation({ response: 'That passkey could not be verified.' });
  }
}

async function publishFailure(
  deps: PasskeyDeps,
  now: Date,
  payload: {
    userId: string | null;
    reason: 'unknown_credential' | 'bad_signature' | 'locked' | 'suspended';
    ip: string | null;
  },
): Promise<void> {
  await deps.events.publish([
    createEvent(identityEvents.passkeyLoginFailed, payload, {
      orgId: SYSTEM_ORG,
      actorId: null,
      occurredAt: now,
    }),
  ]);
}

/**
 * One error for every sign-in failure. See property 2 in the file header.
 *
 * Same `INVALID_CREDENTIALS` code as password login — the frontend's
 * generic handling still applies — but a passkey ceremony never involves an
 * email or password field, so the default "Incorrect email or password."
 * copy is actively wrong here, not just generic. This is the one place that
 * message is overridden without changing what it discloses: every reason
 * (unknown credential, bad signature, locked, suspended) still collapses to
 * this identical text.
 */
function invalidPasskey(): Error {
  return errors.invalidCredentials(
    'That passkey was not recognized. Try a different passkey or sign in another way.',
  );
}
