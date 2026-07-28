import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AES_KEY_BYTES,
  DecryptionError,
  decrypt,
  decryptString,
  encrypt,
  encryptString,
  fieldAad,
} from './encryption.js';
import { secureBytes } from './random.js';

const key = () => secureBytes(AES_KEY_BYTES);

describe('round trip', () => {
  it('recovers the plaintext', () => {
    const k = key();
    expect(decryptString(k, encryptString(k, '+1 415 555 0100'))).toBe('+1 415 555 0100');
  });

  it('handles empty, unicode, and binary payloads', () => {
    const k = key();
    expect(decryptString(k, encryptString(k, ''))).toBe('');

    const emoji = 'transcript: hello 👋 café';
    expect(decryptString(k, encryptString(k, emoji))).toBe(emoji);

    const binary = secureBytes(1024);
    expect([...decrypt(k, encrypt(k, binary))]).toEqual([...binary]);
  });

  it('round-trips with additional authenticated data', () => {
    const k = key();
    const aad = fieldAad({ orgId: 'org-1', table: 'comms.calls', column: 'from', rowId: 'row-1' });
    expect(decryptString(k, encryptString(k, 'secret', aad), aad)).toBe('secret');
  });
});

describe('envelope', () => {
  it('never emits the plaintext', () => {
    const k = key();
    const blob = encryptString(k, 'sensitive-value');
    expect(Buffer.from(blob).toString('utf8')).not.toContain('sensitive-value');
  });

  it('is self-describing: version, nonce, ciphertext, tag', () => {
    const k = key();
    const blob = encrypt(k, new Uint8Array(10));
    expect(blob[0]).toBe(1); // version
    expect(blob).toHaveLength(1 + 12 + 10 + 16);
  });

  it('uses a fresh nonce for every message', () => {
    // GCM nonce reuse under one key is catastrophic — it leaks the XOR of the
    // two plaintexts AND the authentication subkey, letting an attacker forge
    // tags. Identical ciphertexts for identical plaintexts is the visible
    // symptom of a fixed nonce.
    const k = key();
    const nonces = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) {
      nonces.add(Buffer.from(encryptString(k, 'same plaintext').subarray(1, 13)).toString('hex'));
    }
    expect(nonces.size).toBe(1_000);
  });
});

describe('authentication', () => {
  it('rejects a ciphertext whose bits were flipped', () => {
    // The reason for GCM over CBC. Under CBC this modification would decrypt to
    // attacker-chosen changes in the plaintext with no error at all.
    const k = key();
    const blob = encryptString(k, 'balance: 100');
    const tampered = Uint8Array.from(blob);
    tampered[20] = (tampered[20] ?? 0) ^ 0x01;

    expect(() => decryptString(k, tampered)).toThrow(DecryptionError);
  });

  it('rejects a stripped or altered tag', () => {
    const k = key();
    const blob = encryptString(k, 'value');
    const altered = Uint8Array.from(blob);
    altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 0xff;

    expect(() => decryptString(k, altered)).toThrow(DecryptionError);
    expect(() => decryptString(k, blob.subarray(0, blob.length - 4))).toThrow(DecryptionError);
  });

  it('rejects a ciphertext carrying a short authentication tag', () => {
    // Node accepts GCM tags of 4, 8, or 12-16 bytes, and `setAuthTag` verifies
    // against whatever length it is given. A 4-byte tag cuts forgery resistance
    // from 2^128 to 2^32 while decrypting honest ciphertexts perfectly, so
    // nothing else in the suite would notice. Pinning `authTagLength` is what
    // makes this refuse.
    const k = key();
    const iv = secureBytes(12);

    const weak = createCipheriv('aes-256-gcm', k, iv, { authTagLength: 8 });
    const body = Buffer.concat([weak.update(Buffer.from('forged', 'utf8')), weak.final()]);
    const shortTag = weak.getAuthTag();
    expect(shortTag).toHaveLength(8);

    // Same envelope layout, but with an 8-byte tag padded out to the expected
    // width — what an attacker who controls the stored blob would submit.
    const blob = new Uint8Array(1 + 12 + body.length + 16);
    blob[0] = 1;
    blob.set(iv, 1);
    blob.set(body, 13);
    blob.set(shortTag, 13 + body.length);

    expect(() => decrypt(k, blob)).toThrow(DecryptionError);
  });

  it('rejects the wrong key', () => {
    expect(() => decryptString(key(), encryptString(key(), 'value'))).toThrow(DecryptionError);
  });

  it('rejects a truncated blob without reading past the end', () => {
    const k = key();
    expect(() => decrypt(k, new Uint8Array(0))).toThrow(DecryptionError);
    expect(() => decrypt(k, new Uint8Array(12))).toThrow(DecryptionError);
  });

  it('rejects an unknown envelope version', () => {
    const k = key();
    const blob = Uint8Array.from(encryptString(k, 'value'));
    blob[0] = 99;
    expect(() => decrypt(k, blob)).toThrow(/Unsupported envelope version/);
  });
});

describe('AAD binding', () => {
  it('fails when the AAD differs', () => {
    const k = key();
    const blob = encryptString(k, 'value', 'context-a');
    expect(() => decryptString(k, blob, 'context-b')).toThrow(DecryptionError);
    expect(() => decryptString(k, blob)).toThrow(DecryptionError);
  });

  it('fails when AAD was expected but not supplied at encryption', () => {
    const k = key();
    const blob = encryptString(k, 'value');
    expect(() => decryptString(k, blob, 'context-a')).toThrow(DecryptionError);
  });

  it('stops a ciphertext being moved between rows or tenants', () => {
    // The attack this exists to prevent: a tenant who can write their own row
    // pastes another tenant's encrypted phone number into it and has the
    // application decrypt it for them. The crypto is intact; only the binding
    // stops it.
    const k = key();
    const victim = fieldAad({
      orgId: 'org-victim',
      table: 'comms.phone_numbers',
      column: 'e164',
      rowId: 'row-1',
    });
    const attacker = fieldAad({
      orgId: 'org-attacker',
      table: 'comms.phone_numbers',
      column: 'e164',
      rowId: 'row-1',
    });

    const stolen = encryptString(k, '+1 415 555 0100', victim);
    expect(() => decryptString(k, stolen, attacker)).toThrow(DecryptionError);
  });

  it('produces a distinct AAD per field coordinate', () => {
    const base = { orgId: 'o', table: 't', column: 'c', rowId: 'r' };
    const variants = [
      fieldAad(base),
      fieldAad({ ...base, orgId: 'o2' }),
      fieldAad({ ...base, table: 't2' }),
      fieldAad({ ...base, column: 'c2' }),
      fieldAad({ ...base, rowId: 'r2' }),
    ];
    expect(new Set(variants).size).toBe(5);
  });
});

describe('key validation', () => {
  it.each([16, 24, 31, 33, 0])('rejects a %s-byte key', (size) => {
    expect(() => encryptString(new Uint8Array(size), 'value')).toThrow(RangeError);
    expect(() => decrypt(new Uint8Array(size), new Uint8Array(64))).toThrow(RangeError);
  });
});

describe('error messages', () => {
  it('does not distinguish tampering from a wrong key', () => {
    // Any difference here is a decryption oracle. Both must read identically.
    const k = key();
    const tampered = Uint8Array.from(encryptString(k, 'value'));
    tampered[15] = (tampered[15] ?? 0) ^ 0x01;

    const a = grabMessage(() => decrypt(k, tampered));
    const b = grabMessage(() => decrypt(key(), encryptString(key(), 'value')));
    expect(a).toBe(b);
  });
});

function grabMessage(fn: () => unknown): string {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
