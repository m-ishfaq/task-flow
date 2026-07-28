import { describe, expect, it } from 'vitest';
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  completePasskeyAuthentication,
  completePasskeyRegistration,
  relyingPartyFrom,
  PasskeyVerificationError,
} from './webauthn.js';
import { VirtualAuthenticator } from './testing/virtual-authenticator.js';

/**
 * Passkeys (PLAN.md §8.1) — the primary authentication factor.
 *
 * Every assertion below goes through a real ES256 signature produced by
 * `VirtualAuthenticator`. Mocking the verifier would test that this code calls a
 * function; what needs testing is that a genuine ceremony is accepted and each
 * specific forgery is not.
 */

const RP = relyingPartyFrom('http://localhost:5173', 'TaskFlow');

const USER = {
  id: '018f4d1e-7c3a-7b2e-8f1a-000000000001',
  name: 'user@example.test',
  displayName: 'user@example.test',
};

function authenticator(): VirtualAuthenticator {
  return new VirtualAuthenticator({ rpId: RP.id, origin: RP.origin });
}

async function enroll(device: VirtualAuthenticator) {
  const options = await beginPasskeyRegistration({ rp: RP, user: USER, existing: [] });
  const credential = await completePasskeyRegistration({
    rp: RP,
    response: device.create(options.challenge) as never,
    expectedChallenge: options.challenge,
  });
  return credential;
}

describe('relyingPartyFrom', () => {
  it('uses the hostname as the RP id, not the origin', () => {
    // A credential is scoped to a registrable domain. An rpID carrying a scheme
    // or a port matches nothing, and the failure surfaces as "no passkeys
    // available" rather than as an error anyone can debug.
    const rp = relyingPartyFrom('https://app.taskflow.io', 'TaskFlow');

    expect(rp.id).toBe('app.taskflow.io');
    expect(rp.origin).toBe('https://app.taskflow.io');
  });

  it('allows localhost over http', () => {
    // The one secure-context exception browsers make, and local development
    // depends on it.
    expect(relyingPartyFrom('http://localhost:5173', 'TaskFlow').id).toBe('localhost');
  });

  it('refuses plain http anywhere else', () => {
    // The browser will refuse every ceremony, so failing at boot with a clear
    // message beats a WebAuthn call that silently does nothing in staging.
    expect(() => relyingPartyFrom('http://staging.taskflow.io', 'TaskFlow')).toThrow(
      /secure context/,
    );
  });
});

describe('registration options', () => {
  it('requires a discoverable credential and user verification', async () => {
    /* Both are load-bearing. `residentKey: required` is what lets sign-in ask
       nothing about who you are, which removes account enumeration from the
       login page. `userVerification: required` is what makes a passkey two
       factors rather than "possession of an unlocked phone". */
    const options = await beginPasskeyRegistration({ rp: RP, user: USER, existing: [] });

    expect(options.authenticatorSelection?.residentKey).toBe('required');
    expect(options.authenticatorSelection?.userVerification).toBe('required');
  });

  it('does not request attestation', async () => {
    // Asking for `direct` without verifying it records an attestation nobody
    // checks, which reads as assurance and is not.
    const options = await beginPasskeyRegistration({ rp: RP, user: USER, existing: [] });
    expect(options.attestation).toBe('none');
  });

  it('excludes credentials the user already has', async () => {
    // Without this, "add a second passkey" silently overwrites the first on the
    // same device and the user believes they have two.
    const options = await beginPasskeyRegistration({
      rp: RP,
      user: USER,
      existing: [{ id: 'AAAA', transports: ['internal'] }],
    });

    expect(options.excludeCredentials?.map((credential) => credential.id)).toEqual(['AAAA']);
  });
});

describe('registration verification', () => {
  it('accepts a genuine ceremony', async () => {
    const credential = await enroll(authenticator());

    expect(credential.credentialId).not.toBe('');
    expect(credential.publicKey.byteLength).toBeGreaterThan(0);
    expect(credential.deviceType).toBe('singleDevice');
  });

  it('rejects a response for a different challenge', async () => {
    const device = authenticator();
    const options = await beginPasskeyRegistration({ rp: RP, user: USER, existing: [] });

    await expect(
      completePasskeyRegistration({
        rp: RP,
        response: device.create('a-challenge-nobody-issued') as never,
        expectedChallenge: options.challenge,
      }),
    ).rejects.toThrow(PasskeyVerificationError);
  });

  it('rejects a ceremony performed on another origin', async () => {
    /* The anti-phishing property, and the single most important assertion in
       this file. A credential enrolled for taskflow.io must be unusable to a
       page served from a lookalike domain, and the only thing enforcing that is
       the origin inside the signed client data. */
    const device = authenticator();
    const options = await beginPasskeyRegistration({ rp: RP, user: USER, existing: [] });

    await expect(
      completePasskeyRegistration({
        rp: RP,
        response: device.create(options.challenge, { origin: 'https://taskf1ow.io' }) as never,
        expectedChallenge: options.challenge,
      }),
    ).rejects.toThrow(PasskeyVerificationError);
  });

  it('rejects a ceremony with no user verification', async () => {
    // Without UV a passkey proves possession of an unlocked device and nothing
    // more, which is one factor and not the two §8.1 relies on.
    const device = authenticator();
    const options = await beginPasskeyRegistration({ rp: RP, user: USER, existing: [] });

    await expect(
      completePasskeyRegistration({
        rp: RP,
        response: device.create(options.challenge, { userVerified: false }) as never,
        expectedChallenge: options.challenge,
      }),
    ).rejects.toThrow(PasskeyVerificationError);
  });

  it('rejects a ceremony for a different relying party', async () => {
    const foreign = new VirtualAuthenticator({ rpId: 'evil.test', origin: RP.origin });
    const options = await beginPasskeyRegistration({ rp: RP, user: USER, existing: [] });

    await expect(
      completePasskeyRegistration({
        rp: RP,
        response: foreign.create(options.challenge) as never,
        expectedChallenge: options.challenge,
      }),
    ).rejects.toThrow(PasskeyVerificationError);
  });
});

describe('authentication options', () => {
  it('names no credentials', async () => {
    /* `allowCredentials` would require knowing WHO is signing in before the
       ceremony, and answering "which credentials does this email have" is an
       account-existence oracle on the login page. */
    const options = await beginPasskeyAuthentication({ rp: RP });

    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe('required');
  });
});

describe('authentication verification', () => {
  it('accepts a genuine assertion', async () => {
    const device = authenticator();
    const registered = await enroll(device);
    const options = await beginPasskeyAuthentication({ rp: RP });

    const assertion = await completePasskeyAuthentication({
      rp: RP,
      response: device.get(options.challenge),
      expectedChallenge: options.challenge,
      credential: {
        id: registered.credentialId,
        publicKey: registered.publicKey,
        counter: registered.counter,
      },
    });

    expect(assertion.userVerified).toBe(true);
    expect(assertion.newCounter).toBeGreaterThan(0);
  });

  it('rejects an assertion signed by a different key', async () => {
    const enrolled = authenticator();
    const registered = await enroll(enrolled);

    const impostor = authenticator();
    const options = await beginPasskeyAuthentication({ rp: RP });

    await expect(
      completePasskeyAuthentication({
        rp: RP,
        response: impostor.get(options.challenge),
        expectedChallenge: options.challenge,
        credential: {
          id: registered.credentialId,
          publicKey: registered.publicKey,
          counter: registered.counter,
        },
      }),
    ).rejects.toThrow(PasskeyVerificationError);
  });

  it('rejects a replayed challenge', async () => {
    const device = authenticator();
    const registered = await enroll(device);

    const first = await beginPasskeyAuthentication({ rp: RP });
    const second = await beginPasskeyAuthentication({ rp: RP });

    await expect(
      completePasskeyAuthentication({
        rp: RP,
        response: device.get(first.challenge),
        expectedChallenge: second.challenge,
        credential: {
          id: registered.credentialId,
          publicKey: registered.publicKey,
          counter: registered.counter,
        },
      }),
    ).rejects.toThrow(PasskeyVerificationError);
  });

  it('rejects a counter that did not advance', async () => {
    /* Clone detection. A genuine authenticator only ever counts up, so a value
       at or below the stored one means the credential exists in two places —
       which is the only signal a relying party ever gets that a key was
       extracted. */
    const device = authenticator();
    const registered = await enroll(device);
    const options = await beginPasskeyAuthentication({ rp: RP });

    await expect(
      completePasskeyAuthentication({
        rp: RP,
        response: device.get(options.challenge, { signCount: 5 }),
        expectedChallenge: options.challenge,
        credential: {
          id: registered.credentialId,
          publicKey: registered.publicKey,
          // Already seen a higher count than the assertion reports.
          counter: 9,
        },
      }),
    ).rejects.toThrow(PasskeyVerificationError);
  });

  it('rejects an assertion from a phishing origin', async () => {
    const device = authenticator();
    const registered = await enroll(device);
    const options = await beginPasskeyAuthentication({ rp: RP });

    await expect(
      completePasskeyAuthentication({
        rp: RP,
        response: device.get(options.challenge, { origin: 'https://taskf1ow.io' }),
        expectedChallenge: options.challenge,
        credential: {
          id: registered.credentialId,
          publicKey: registered.publicKey,
          counter: registered.counter,
        },
      }),
    ).rejects.toThrow(PasskeyVerificationError);
  });

  it('reports the same error for every failure', async () => {
    // Which check failed is useful only to someone probing the ceremony.
    const device = authenticator();
    const registered = await enroll(device);
    const options = await beginPasskeyAuthentication({ rp: RP });

    const messages = await Promise.all(
      [{ origin: 'https://evil.test' }, { userVerified: false }].map((overrides) =>
        completePasskeyAuthentication({
          rp: RP,
          response: device.get(options.challenge, overrides),
          expectedChallenge: options.challenge,
          credential: {
            id: registered.credentialId,
            publicKey: registered.publicKey,
            counter: registered.counter,
          },
        }).then(
          () => 'no error',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      ),
    );

    expect(new Set(messages).size).toBe(1);
  });
});
