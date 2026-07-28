import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * A software WebAuthn authenticator, for tests.
 *
 * ## Why this exists rather than a stub
 *
 * Passkeys are the primary authentication factor (§8.1). A test that mocks
 * `verifyRegistrationResponse` proves that the code calls a function, which is
 * the least interesting property it has. What needs proving is that a REAL
 * ES256 signature over real client data is accepted, that one over the wrong
 * challenge is not, and that a replayed counter is caught — and none of that is
 * observable without something that actually signs.
 *
 * So this builds genuine ceremony responses: CBOR-encoded attestation objects,
 * authenticator data with the right flags, and ECDSA-P256 signatures over
 * `authenticatorData || SHA-256(clientDataJSON)` exactly as the specification
 * describes.
 *
 * ## Why it lives in @taskflow/security
 *
 * It needs `node:crypto`, which lint bans everywhere else — and the exemption is
 * not the reason it belongs here. A thing that forges authenticator ceremonies
 * should sit next to the thing that verifies them, on the same human-review
 * surface (§2.2), so a reviewer reads both together. It is exported from
 * `@taskflow/security/testing` rather than from the package root so no
 * production import can reach it by accident.
 */

/* -------------------------------------------------------------------------- *
 * Minimal CBOR encoder
 * -------------------------------------------------------------------------- */
/* Only the four types a WebAuthn attestation needs. A dependency would be a
   dependency in the security package, which is a worse trade than forty lines
   that are exercised on every test run. */

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);

  if (value < 0x1_0000) {
    const buffer = Buffer.alloc(3);
    buffer[0] = (major << 5) | 25;
    buffer.writeUInt16BE(value, 1);
    return buffer;
  }

  const buffer = Buffer.alloc(5);
  buffer[0] = (major << 5) | 26;
  buffer.writeUInt32BE(value, 1);
  return buffer;
}

/** Major type 0 for non-negative, 1 for negative — COSE keys use both. */
function cborInt(value: number): Buffer {
  return value >= 0 ? head(0, value) : head(1, -1 - value);
}

function cborBytes(value: Buffer): Buffer {
  return Buffer.concat([head(2, value.length), value]);
}

function cborText(value: string): Buffer {
  const encoded = Buffer.from(value, 'utf8');
  return Buffer.concat([head(3, encoded.length), encoded]);
}

function cborMap(entries: readonly (readonly [Buffer, Buffer])[]): Buffer {
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([key, value]) => [key, value]),
  ]);
}

/* -------------------------------------------------------------------------- *
 * Authenticator
 * -------------------------------------------------------------------------- */

/** User present. Set on every ceremony — the specification requires it. */
const FLAG_UP = 0x01;
/** User verified. What makes a passkey two factors; the RP requires it (§8.1). */
const FLAG_UV = 0x04;
/** Attested credential data included. Registration only. */
const FLAG_AT = 0x40;

const AAGUID = Buffer.alloc(16, 0);

export interface VirtualAuthenticatorOptions {
  /** Must match the relying party's `id`, or the rpIdHash will not verify. */
  readonly rpId: string;
  /** Must match the relying party's `origin`, or the client data will not verify. */
  readonly origin: string;
  /** Starting signature counter. 0 means "this authenticator does not count". */
  readonly signCount?: number;
}

export interface CeremonyOverrides {
  /** Forge a different origin, to prove the anti-phishing check bites. */
  readonly origin?: string;
  /** Omit user verification, to prove `requireUserVerification` bites. */
  readonly userVerified?: boolean;
  /** Force a specific counter, to prove clone detection bites. */
  readonly signCount?: number;
}

export class VirtualAuthenticator {
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  readonly #rpId: string;
  readonly #origin: string;
  readonly credentialId: Buffer;
  signCount: number;

  constructor(options: VirtualAuthenticatorOptions) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
    this.#rpId = options.rpId;
    this.#origin = options.origin;
    this.signCount = options.signCount ?? 0;

    /* A fresh random handle per instance. Not from @taskflow/security's
       secureBytes, because this file must not depend on the module under test —
       a shared CSPRNG bug would then hide itself.

       This was a deterministic sequence at first, which made every
       `new VirtualAuthenticator()` produce the SAME credential id. Enrollment
       then answered 409 for the second device in a suite, and the sign-in tests
       failed against a credential belonging to another user — symptoms that
       read as service bugs and were entirely the fake's fault. */
    this.credentialId = randomBytes(32);
  }

  get credentialIdBase64Url(): string {
    return this.credentialId.toString('base64url');
  }

  /** A `navigator.credentials.create()` result, as JSON. */
  create(challenge: string, overrides: CeremonyOverrides = {}) {
    const clientDataJSON = this.#clientData('webauthn.create', challenge, overrides.origin);
    const authData = this.#authenticatorData({
      includeAttestedCredential: true,
      userVerified: overrides.userVerified ?? true,
      signCount: overrides.signCount ?? this.signCount,
    });

    const attestationObject = cborMap([
      [cborText('fmt'), cborText('none')],
      [cborText('attStmt'), cborMap([])],
      [cborText('authData'), cborBytes(authData)],
    ]);

    return {
      id: this.credentialIdBase64Url,
      rawId: this.credentialIdBase64Url,
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      type: 'public-key' as const,
    };
  }

  /** A `navigator.credentials.get()` result, as JSON. */
  get(challenge: string, overrides: CeremonyOverrides = {}) {
    const signCount = overrides.signCount ?? ++this.signCount;
    const clientDataJSON = this.#clientData('webauthn.get', challenge, overrides.origin);
    const authData = this.#authenticatorData({
      includeAttestedCredential: false,
      userVerified: overrides.userVerified ?? true,
      signCount,
    });

    /* The signature the whole scheme rests on: over the authenticator data
       concatenated with the HASH of the client data, never the client data
       itself. Getting that wrong produces a signature that verifies against
       nothing, which is how a broken test authenticator looks exactly like a
       broken verifier. */
    const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
    const signature = createSign('SHA256')
      .update(Buffer.concat([authData, clientDataHash]))
      .sign(this.#privateKey);

    return {
      id: this.credentialIdBase64Url,
      rawId: this.credentialIdBase64Url,
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
      clientExtensionResults: {},
      type: 'public-key' as const,
    };
  }

  #clientData(type: string, challenge: string, origin?: string): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin: origin ?? this.#origin,
        crossOrigin: false,
      }),
      'utf8',
    );
  }

  #authenticatorData(input: {
    includeAttestedCredential: boolean;
    userVerified: boolean;
    signCount: number;
  }): Buffer {
    const rpIdHash = createHash('sha256').update(this.#rpId, 'utf8').digest();

    let flags = FLAG_UP;
    if (input.userVerified) flags |= FLAG_UV;
    if (input.includeAttestedCredential) flags |= FLAG_AT;

    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(input.signCount);

    if (!input.includeAttestedCredential) {
      return Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);
    }

    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);

    return Buffer.concat([
      rpIdHash,
      Buffer.from([flags]),
      counter,
      AAGUID,
      idLength,
      this.credentialId,
      this.#coseKey(),
    ]);
  }

  /** The public key in COSE_Key form: EC2 / ES256 / P-256, with x and y. */
  #coseKey(): Buffer {
    const jwk = this.#publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x ?? '', 'base64url');
    const y = Buffer.from(jwk.y ?? '', 'base64url');

    return cborMap([
      [cborInt(1), cborInt(2)], // kty: EC2
      [cborInt(3), cborInt(-7)], // alg: ES256
      [cborInt(-1), cborInt(1)], // crv: P-256
      [cborInt(-2), cborBytes(x)],
      [cborInt(-3), cborBytes(y)],
    ]);
  }
}
