import { describe, expect, it } from 'vitest';
import { toRegistrationResponse, type PasskeyCreationResult } from './passkeys.js';

/**
 * The one real logic in the passkeys slice (§4.4) — see passkeys.ts's own
 * header for why this is the bug class worth a test: a client/server shape
 * mismatch that `JSON.stringify` happens to paper over today but that this
 * file makes explicit instead of implicit.
 */

function creationResult(over: Partial<PasskeyCreationResult> = {}): PasskeyCreationResult {
  return {
    id: 'cred-id',
    rawId: 'cred-raw-id',
    response: {
      clientDataJSON: 'client-data',
      attestationObject: 'attestation',
    },
    clientExtensionResults: {},
    type: 'public-key',
    ...over,
  };
}

describe('toRegistrationResponse', () => {
  it('carries every field the server schema accepts', () => {
    const result = creationResult({
      response: {
        clientDataJSON: 'client-data',
        attestationObject: 'attestation',
        transports: ['internal'],
        publicKeyAlgorithm: -7,
        publicKey: 'pubkey',
        authenticatorData: 'authdata',
      },
      authenticatorAttachment: 'platform',
    });

    expect(toRegistrationResponse(result)).toEqual(result);
  });

  it('omits optional fields that were absent rather than sending them as undefined', () => {
    const result = creationResult();

    const mapped = toRegistrationResponse(result);

    expect('transports' in mapped.response).toBe(false);
    expect('authenticatorAttachment' in mapped).toBe(false);
  });

  it('drops anything beyond the schema-known fields — the getPublicKey() case', () => {
    // The library's actual CreationResponse attaches a getPublicKey()
    // method to `response`; simulated here without importing the library.
    const withExtra = {
      ...creationResult(),
      response: {
        clientDataJSON: 'client-data',
        attestationObject: 'attestation',
        getPublicKey: () => 'not-part-of-the-wire-shape',
      },
    } as unknown as PasskeyCreationResult;

    const mapped = toRegistrationResponse(withExtra);

    expect('getPublicKey' in mapped.response).toBe(false);
  });
});
