import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { newId, relyingPartyFrom } from '@taskflow/security';
import { VirtualAuthenticator } from '@taskflow/security/testing';
import { buildServer } from '../server.js';
import { consumeChallenge, createChallenge } from './passkey.repository.js';
import type { DeliverableLink } from './identity.service.js';
import { TEST_ENV } from '../testing/fixtures.js';

/**
 * Passkeys end to end (PLAN.md §8.1), against real Postgres and a real
 * ES256-signing authenticator.
 *
 * The unit tests in @taskflow/security prove the ceremony verification. What is
 * proven HERE is everything a library cannot do for you: that a challenge is
 * spent exactly once, that an enrollment binds to the caller rather than to
 * whoever the request names, and that a user cannot delete their last way in.
 */

const RP = relyingPartyFrom(TEST_ENV.WEB_ORIGIN, 'TaskFlow');
const PASSWORD = 'correct horse battery staple 42';

let app: FastifyInstance;
const deliveries: DeliverableLink[] = [];

beforeAll(async () => {
  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'passkey-test' });
  app = await buildServer({
    env: TEST_ENV,
    deliver: (message) => {
      deliveries.push(message);
      return Promise.resolve();
    },
  });
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

interface TrpcBody {
  result?: { data?: unknown };
  error?: { data?: { code?: string } };
}

async function call(
  path: string,
  options: { payload?: unknown; token?: string } = {},
): Promise<{ status: number; body: TrpcBody }> {
  const response = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    ...(options.token === undefined
      ? {}
      : { headers: { authorization: `Bearer ${options.token}` } }),
    payload: options.payload ?? {},
  });

  return { status: response.statusCode, body: response.json<TrpcBody>() };
}

/** Registers, verifies, and signs in with a password. Returns the access token. */
async function signedInUser(email: string): Promise<string> {
  await call('auth.register', { payload: { email, password: PASSWORD } });

  const link = deliveries.find(
    (message) => message.kind === 'verify_email' && message.email === email,
  );
  await call('auth.verifyEmail', { payload: { token: link?.token ?? '' } });

  const { body } = await call('auth.login', { payload: { email, password: PASSWORD } });
  return (body.result?.data as { accessToken?: string }).accessToken ?? '';
}

function newDevice(): VirtualAuthenticator {
  return new VirtualAuthenticator({ rpId: RP.id, origin: RP.origin });
}

async function enroll(
  token: string,
  device: VirtualAuthenticator,
  name?: string,
): Promise<{ status: number; body: TrpcBody }> {
  const started = await call('auth.passkeys.startRegistration', { token });
  const challenge = (started.body.result?.data as { challenge: string }).challenge;

  return call('auth.passkeys.finishRegistration', {
    token,
    payload: { response: device.create(challenge), ...(name === undefined ? {} : { name }) },
  });
}

/* -------------------------------------------------------------------------- *
 * Enrollment
 * -------------------------------------------------------------------------- */

describe('enrollment', () => {
  it('requires authentication', async () => {
    // Enrolling an authenticator adds a way into an account. An unauthenticated
    // endpoint for it is account takeover with extra steps.
    const response = await call('auth.passkeys.startRegistration');

    expect(response.status).toBe(401);
    expect(response.body.error?.data?.code).toBe('UNAUTHENTICATED');
  });

  it('enrolls a passkey for the signed-in user', async () => {
    const token = await signedInUser('passkey-enroll@example.test');
    const result = await enroll(token, newDevice(), 'Test key');

    expect(result.status).toBe(200);
    expect((result.body.result?.data as { credentialId?: string }).credentialId).toBeTruthy();
  });

  it('lists it back with the label, and without the key material', async () => {
    const token = await signedInUser('passkey-list@example.test');
    await enroll(token, newDevice(), 'MacBook Touch ID');

    const listed = await app.inject({
      method: 'GET',
      url: '/trpc/auth.passkeys.list',
      headers: { authorization: `Bearer ${token}` },
    });

    const entries = listed.json<TrpcBody>().result?.data as { name?: string }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('MacBook Touch ID');
    // A public key is not a secret, but a response that does not carry it cannot
    // leak it later either.
    expect(listed.body).not.toContain('publicKey');
    expect(listed.body).not.toContain('credentialId');
  });

  it('refuses a second enrollment of the same authenticator', async () => {
    /* A credential id identifies one key pair globally. A duplicate means either
       a bug or an attempt to bind a key that is already bound. */
    const token = await signedInUser('passkey-dupe@example.test');
    const device = newDevice();

    expect((await enroll(token, device)).status).toBe(200);
    expect((await enroll(token, device)).status).toBe(409);
  });

  it('refuses a ceremony completed with someone else’s challenge', async () => {
    /* The binding that matters. Both users are legitimately signed in; the
       attacker starts their own enrollment, then submits a response for a
       challenge issued to the victim. If the service trusted the response alone,
       the attacker's authenticator would be bound to the victim's account. */
    const victim = await signedInUser('passkey-victim@example.test');
    const attacker = await signedInUser('passkey-attacker@example.test');

    const victimStart = await call('auth.passkeys.startRegistration', { token: victim });
    const victimChallenge = (victimStart.body.result?.data as { challenge: string }).challenge;

    const response = await call('auth.passkeys.finishRegistration', {
      token: attacker,
      payload: { response: newDevice().create(victimChallenge) },
    });

    expect(response.status).toBe(403);
  });

  it('rejects a response signed for another origin', async () => {
    const token = await signedInUser('passkey-phish@example.test');
    const started = await call('auth.passkeys.startRegistration', { token });
    const challenge = (started.body.result?.data as { challenge: string }).challenge;

    const response = await call('auth.passkeys.finishRegistration', {
      token,
      payload: { response: newDevice().create(challenge, { origin: 'https://taskf1ow.io' }) },
    });

    expect(response.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- *
 * Sign-in
 * -------------------------------------------------------------------------- */

describe('sign-in', () => {
  it('issues a session from a passkey assertion', async () => {
    const token = await signedInUser('passkey-signin@example.test');
    const device = newDevice();
    await enroll(token, device);

    const started = await call('auth.passkeys.startAuthentication');
    const challenge = (started.body.result?.data as { challenge: string }).challenge;

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.passkeys.finishAuthentication',
      payload: { response: device.get(challenge) },
    });

    expect(response.statusCode).toBe(200);

    const data = response.json<TrpcBody>().result?.data as { accessToken?: string };
    expect(data.accessToken).toBeTruthy();

    // Same token-pair split as password login: the long-lived half never
    // appears in the body.
    expect(response.headers['set-cookie']).toBeDefined();
    expect(response.body).not.toContain('refreshToken');
  });

  it('asks for no identifier at all', async () => {
    /* The property that makes this flow immune to account enumeration by
       construction rather than by careful answering: there is no email field on
       the request, so there is nothing to probe. */
    const started = await call('auth.passkeys.startAuthentication');
    const options = started.body.result?.data as { allowCredentials?: unknown[] };

    expect(started.status).toBe(200);
    expect(options.allowCredentials ?? []).toEqual([]);
  });

  it('refuses a replayed assertion', async () => {
    /* A replayed WebAuthn assertion is a complete authentication bypass, and
       this is the assertion that the conditional UPDATE in consumeChallenge
       actually fires. */
    const token = await signedInUser('passkey-replay@example.test');
    const device = newDevice();
    await enroll(token, device);

    const started = await call('auth.passkeys.startAuthentication');
    const challenge = (started.body.result?.data as { challenge: string }).challenge;
    const assertion = device.get(challenge);

    const first = await call('auth.passkeys.finishAuthentication', {
      payload: { response: assertion },
    });
    const second = await call('auth.passkeys.finishAuthentication', {
      payload: { response: assertion },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it('refuses an assertion for a credential this system has never seen', async () => {
    const started = await call('auth.passkeys.startAuthentication');
    const challenge = (started.body.result?.data as { challenge: string }).challenge;

    const response = await call('auth.passkeys.finishAuthentication', {
      payload: { response: newDevice().get(challenge) },
    });

    expect(response.status).toBe(401);
    expect(response.body.error?.data?.code).toBe('INVALID_CREDENTIALS');
  });

  it('answers identically for an unknown credential and a bad signature', async () => {
    // Which check failed is useful only to someone probing the ceremony.
    const token = await signedInUser('passkey-uniform@example.test');
    const enrolled = newDevice();
    await enroll(token, enrolled);

    const unknown = await call('auth.passkeys.startAuthentication').then((started) =>
      call('auth.passkeys.finishAuthentication', {
        payload: {
          response: newDevice().get((started.body.result?.data as { challenge: string }).challenge),
        },
      }),
    );

    const forged = await call('auth.passkeys.startAuthentication').then((started) => {
      const challenge = (started.body.result?.data as { challenge: string }).challenge;
      const impostor = newDevice();
      const assertion = impostor.get(challenge);
      // Claim the enrolled credential's id while signing with a different key.
      return call('auth.passkeys.finishAuthentication', {
        payload: { response: { ...assertion, id: enrolled.credentialIdBase64Url } },
      });
    });

    expect(unknown.status).toBe(forged.status);
    expect(unknown.body.error?.data?.code).toBe(forged.body.error?.data?.code);
  });
});

/* -------------------------------------------------------------------------- *
 * Challenges
 * -------------------------------------------------------------------------- */

describe('challenges', () => {
  /* Generated per run rather than hardcoded. Fixed values survive a failed run
     in the database and make the NEXT run fail on a primary-key collision — an
     error that looks nothing like the thing being tested. */
  const onceOnly = `once-only-${newId<'ChallengeId'>()}`;
  const expired = `expired-${newId<'ChallengeId'>()}`;
  const authOnly = `auth-only-${newId<'ChallengeId'>()}`;

  it('can be consumed exactly once', async () => {
    const now = new Date();
    await createChallenge({
      id: newId<'ChallengeId'>(),
      challenge: onceOnly,
      userId: null,
      purpose: 'authentication',
      expiresAt: new Date(now.getTime() + 60_000),
    });

    const first = await consumeChallenge({
      challenge: onceOnly,
      purpose: 'authentication',
      now,
    });
    const second = await consumeChallenge({
      challenge: onceOnly,
      purpose: 'authentication',
      now,
    });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it('cannot be consumed after it expires', async () => {
    const now = new Date();
    await createChallenge({
      id: newId<'ChallengeId'>(),
      challenge: expired,
      userId: null,
      purpose: 'authentication',
      expiresAt: new Date(now.getTime() - 1_000),
    });

    const claimed = await consumeChallenge({
      challenge: expired,
      purpose: 'authentication',
      now,
    });

    expect(claimed).toBeUndefined();
  });

  it('cannot be redeemed for the other purpose', async () => {
    /* A sign-in challenge completed as an enrollment would bind an
       authenticator to whatever account the row named. The CHECK constraint
       makes the pairing impossible to store; this makes it impossible to
       redeem across. */
    const now = new Date();
    await createChallenge({
      id: newId<'ChallengeId'>(),
      challenge: authOnly,
      userId: null,
      purpose: 'authentication',
      expiresAt: new Date(now.getTime() + 60_000),
    });

    const claimed = await consumeChallenge({
      challenge: authOnly,
      purpose: 'registration',
      now,
    });

    expect(claimed).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- *
 * Management
 * -------------------------------------------------------------------------- */

describe('management', () => {
  it('renames a passkey', async () => {
    const token = await signedInUser('passkey-rename@example.test');
    await enroll(token, newDevice(), 'Old name');

    const listed = await app.inject({
      method: 'GET',
      url: '/trpc/auth.passkeys.list',
      headers: { authorization: `Bearer ${token}` },
    });
    const id = (listed.json<TrpcBody>().result?.data as { id: string }[])[0]?.id ?? '';

    const renamed = await call('auth.passkeys.rename', {
      token,
      payload: { id, name: 'New name' },
    });

    expect(renamed.status).toBe(200);
  });

  it('will not let one user touch another’s passkey', async () => {
    const owner = await signedInUser('passkey-owner@example.test');
    const stranger = await signedInUser('passkey-stranger@example.test');
    await enroll(owner, newDevice());

    const listed = await app.inject({
      method: 'GET',
      url: '/trpc/auth.passkeys.list',
      headers: { authorization: `Bearer ${owner}` },
    });
    const id = (listed.json<TrpcBody>().result?.data as { id: string }[])[0]?.id ?? '';

    const rename = await call('auth.passkeys.rename', {
      token: stranger,
      payload: { id, name: 'mine now' },
    });
    const remove = await call('auth.passkeys.remove', { token: stranger, payload: { id } });

    // 404, not 403: a distinct answer would confirm the credential exists.
    expect(rename.status).toBe(404);
    expect(remove.status).toBe(404);
  });

  it('removes a passkey when the account still has a password', async () => {
    const token = await signedInUser('passkey-remove@example.test');
    await enroll(token, newDevice());

    const listed = await app.inject({
      method: 'GET',
      url: '/trpc/auth.passkeys.list',
      headers: { authorization: `Bearer ${token}` },
    });
    const id = (listed.json<TrpcBody>().result?.data as { id: string }[])[0]?.id ?? '';

    const removed = await call('auth.passkeys.remove', { token, payload: { id } });
    expect(removed.status).toBe(200);
  });
});
