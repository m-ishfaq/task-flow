import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The browser half of the passkey ceremony.
 *
 * Everything that decides whether a ceremony is trustworthy lives on the
 * server (`packages/security/src/webauthn.ts`, `passkey.service.ts`) and is
 * covered there. What this file owns, and what is worth testing directly, is
 * the one piece of real logic on the browser side: translating
 * `@simplewebauthn/browser`'s error shapes into the small closed
 * `PasskeyCeremonyReason` set the UI renders from — get that wrong and either
 * a cancelled prompt shows a scary red banner, or a genuine failure shows
 * nothing at all.
 */

class MockWebAuthnError extends Error {
  readonly code: string;

  constructor({ message, code, cause }: { message: string; code: string; cause: Error }) {
    super(message);
    this.name = 'WebAuthnError';
    this.code = code;
    this.cause = cause;
  }
}

const startAuthentication = vi.fn<(opts: { optionsJSON: unknown }) => Promise<unknown>>();
const startRegistration = vi.fn<(opts: { optionsJSON: unknown }) => Promise<unknown>>();
const browserSupportsWebAuthn = vi.fn<() => boolean>(() => true);

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
  WebAuthnError: MockWebAuthnError,
}));

const startAuthenticationMutate = vi.fn<() => Promise<unknown>>();
const finishAuthenticationMutate = vi.fn<(input: unknown) => Promise<unknown>>();
const startRegistrationMutate = vi.fn<() => Promise<unknown>>();
const finishRegistrationMutate = vi.fn<(input: unknown) => Promise<unknown>>();

vi.mock('../../lib/trpc.js', () => ({
  api: {
    auth: {
      passkeys: {
        startAuthentication: { mutate: startAuthenticationMutate },
        finishAuthentication: { mutate: finishAuthenticationMutate },
        startRegistration: { mutate: startRegistrationMutate },
        finishRegistration: { mutate: finishRegistrationMutate },
      },
    },
  },
}));

const {
  signInWithPasskey,
  enrollPasskey,
  passkeyCeremonyMessage,
  PasskeyCeremonyError,
} = await import('./passkey.js');

const OPTIONS = { challenge: 'a-challenge' };
const ASSERTION_RESPONSE = { id: 'cred-1', response: { clientDataJSON: 'x' } };
const SESSION = { accessToken: 'tok', expiresInSeconds: 900, sessionId: 'sess-1' };

beforeEach(() => {
  vi.clearAllMocks();
  browserSupportsWebAuthn.mockReturnValue(true);
});

describe('signInWithPasskey', () => {
  it('fetches options, runs the ceremony, and hands the assertion to the server', async () => {
    startAuthenticationMutate.mockResolvedValue(OPTIONS);
    startAuthentication.mockResolvedValue(ASSERTION_RESPONSE);
    finishAuthenticationMutate.mockResolvedValue(SESSION);

    const result = await signInWithPasskey();

    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
    expect(finishAuthenticationMutate).toHaveBeenCalledWith({ response: ASSERTION_RESPONSE });
    expect(result).toEqual(SESSION);
  });

  it('never calls finishAuthentication when the ceremony itself fails', async () => {
    startAuthenticationMutate.mockResolvedValue(OPTIONS);
    startAuthentication.mockRejectedValue(
      new MockWebAuthnError({
        message: 'The operation either timed out or was not allowed.',
        code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
        cause: new Error('NotAllowedError'),
      }),
    );

    await expect(signInWithPasskey()).rejects.toBeInstanceOf(PasskeyCeremonyError);
    expect(finishAuthenticationMutate).not.toHaveBeenCalled();
  });

  it('maps a dismissed or timed-out prompt to "cancelled"', async () => {
    startAuthenticationMutate.mockResolvedValue(OPTIONS);
    startAuthentication.mockRejectedValue(
      new MockWebAuthnError({
        message: 'not allowed',
        code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
        cause: new Error('NotAllowedError'),
      }),
    );

    const error = await signInWithPasskey().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PasskeyCeremonyError);
    expect((error as InstanceType<typeof PasskeyCeremonyError>).reason).toBe('cancelled');
  });

  it('maps an explicit abort to "cancelled" too', async () => {
    startAuthenticationMutate.mockResolvedValue(OPTIONS);
    startAuthentication.mockRejectedValue(
      new MockWebAuthnError({
        message: 'aborted',
        code: 'ERROR_CEREMONY_ABORTED',
        cause: new Error('AbortError'),
      }),
    );

    const error = await signInWithPasskey().catch((caught: unknown) => caught);
    expect((error as InstanceType<typeof PasskeyCeremonyError>).reason).toBe('cancelled');
  });

  it('does not report "already_registered" for an authentication ceremony', async () => {
    /* This code is only ever raised by startRegistration in practice — see
       translate()'s own comment — but if a future library version raised it
       here too, confidently telling someone signing IN that their device
       "already has a passkey" would be actively misleading. */
    startAuthenticationMutate.mockResolvedValue(OPTIONS);
    startAuthentication.mockRejectedValue(
      new MockWebAuthnError({
        message: 'previously registered',
        code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED',
        cause: new Error('InvalidStateError'),
      }),
    );

    const error = await signInWithPasskey().catch((caught: unknown) => caught);
    expect((error as InstanceType<typeof PasskeyCeremonyError>).reason).toBe('unknown');
  });

  it('maps an unrecognised authenticator to "unsupported"', async () => {
    startAuthenticationMutate.mockResolvedValue(OPTIONS);
    startAuthentication.mockRejectedValue(
      new MockWebAuthnError({
        message: 'no supported algorithm',
        code: 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG',
        cause: new Error('NotSupportedError'),
      }),
    );

    const error = await signInWithPasskey().catch((caught: unknown) => caught);
    expect((error as InstanceType<typeof PasskeyCeremonyError>).reason).toBe('unsupported');
  });

  it('falls back to "unknown" for a plain, non-WebAuthnError failure', async () => {
    // e.g. the library's own `Error('WebAuthn is not supported in this browser')`,
    // thrown before it ever calls the platform APIs.
    startAuthenticationMutate.mockResolvedValue(OPTIONS);
    startAuthentication.mockRejectedValue(new Error('WebAuthn is not supported in this browser'));

    const error = await signInWithPasskey().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PasskeyCeremonyError);
    expect((error as InstanceType<typeof PasskeyCeremonyError>).reason).toBe('unknown');
  });

  it('propagates a server-side rejection of the assertion untouched', async () => {
    // A completed-but-invalid ceremony (bad signature, unknown credential) is
    // the server's INVALID_CREDENTIALS, not a PasskeyCeremonyError — the UI
    // renders it through the ordinary ErrorView path, same as password login.
    startAuthenticationMutate.mockResolvedValue(OPTIONS);
    startAuthentication.mockResolvedValue(ASSERTION_RESPONSE);
    const serverError = new Error('INVALID_CREDENTIALS');
    finishAuthenticationMutate.mockRejectedValue(serverError);

    await expect(signInWithPasskey()).rejects.toBe(serverError);
  });
});

describe('enrollPasskey', () => {
  const REGISTRATION_RESPONSE = { id: 'cred-2', response: { attestationObject: 'x' } };

  it('fetches options, runs the ceremony, and forwards an optional name', async () => {
    startRegistrationMutate.mockResolvedValue(OPTIONS);
    startRegistration.mockResolvedValue(REGISTRATION_RESPONSE);
    finishRegistrationMutate.mockResolvedValue({ credentialId: 'cred-2' });

    await enrollPasskey('My laptop');

    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
    expect(finishRegistrationMutate).toHaveBeenCalledWith({
      response: REGISTRATION_RESPONSE,
      name: 'My laptop',
    });
  });

  it('omits the name field entirely when none is given', async () => {
    // Not `name: undefined` — the router's input is `.strict()`, and an extra
    // key with an undefined value is still a key `.strict()` would reject
    // once it crosses JSON (where `undefined` does not survive anyway).
    startRegistrationMutate.mockResolvedValue(OPTIONS);
    startRegistration.mockResolvedValue(REGISTRATION_RESPONSE);
    finishRegistrationMutate.mockResolvedValue({ credentialId: 'cred-2' });

    await enrollPasskey();

    const call = finishRegistrationMutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('name' in call).toBe(false);
  });

  it('reports a device refusing a second credential as "already_registered"', async () => {
    startRegistrationMutate.mockResolvedValue(OPTIONS);
    startRegistration.mockRejectedValue(
      new MockWebAuthnError({
        message: 'previously registered',
        code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED',
        cause: new Error('InvalidStateError'),
      }),
    );

    const error = await enrollPasskey().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PasskeyCeremonyError);
    expect((error as InstanceType<typeof PasskeyCeremonyError>).reason).toBe('already_registered');
  });

  it('never calls finishRegistration when the ceremony itself fails', async () => {
    startRegistrationMutate.mockResolvedValue(OPTIONS);
    startRegistration.mockRejectedValue(
      new MockWebAuthnError({
        message: 'not allowed',
        code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY',
        cause: new Error('NotAllowedError'),
      }),
    );

    await expect(enrollPasskey()).rejects.toBeInstanceOf(PasskeyCeremonyError);
    expect(finishRegistrationMutate).not.toHaveBeenCalled();
  });
});

describe('passkeyCeremonyMessage', () => {
  it('has nothing to say about a cancelled ceremony', () => {
    expect(passkeyCeremonyMessage('cancelled')).toBeNull();
  });

  it('gives every other reason a non-empty, human sentence', () => {
    for (const reason of ['already_registered', 'unsupported', 'unknown'] as const) {
      const message = passkeyCeremonyMessage(reason);
      expect(message).not.toBeNull();
      expect(message?.length).toBeGreaterThan(0);
    }
  });
});
