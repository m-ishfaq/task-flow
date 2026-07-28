import { createCipheriv, createDecipheriv } from 'node:crypto';
import { secureBytes } from './random.js';

/**
 * Authenticated symmetric encryption — AES-256-GCM (PLAN.md §8.4).
 *
 * Used for the fields that would be damaging in a database dump but still have
 * to be readable by the application: phone numbers, recording URLs, transcripts,
 * profile PII. The key is always a per-organization DATA key obtained from a
 * `KeyProvider`, never a long-lived application secret — that indirection is
 * what makes crypto-shredding possible (destroy one org's key, its data becomes
 * unrecoverable everywhere including backups).
 *
 * GCM rather than CBC because it is AUTHENTICATED. CBC ciphertext can be
 * modified by an attacker who never learns the key — flipping bits in one block
 * flips chosen bits in the next — and the classic padding-oracle attack turns a
 * decryption error message into a full plaintext recovery. GCM's tag makes any
 * modification a decryption failure.
 */

/** Envelope format version. Bumped if the algorithm or layout ever changes. */
const VERSION = 1;

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce, the size GCM is defined for

/**
 * Authentication tag length, in bytes — always the full 128 bits.
 *
 * Passed explicitly to both cipher and decipher rather than left to default.
 * Node accepts GCM tags of 4, 8, or 12-16 bytes, and `setAuthTag` will happily
 * verify against whatever length it is handed. An attacker who can influence the
 * stored blob could then present a 4-byte tag, cutting forgery resistance from
 * 2^128 to 2^32 — and every test still passes, because short tags verify
 * correctly for honest ciphertexts.
 *
 * The fixed layout below already makes the tag exactly 16 bytes by arithmetic,
 * so this pins a property that is currently true by accident of the format. In
 * cryptographic code that difference is the whole point: the next person to
 * change the layout should hit an error, not a weaker cipher.
 */
const TAG_BYTES = 16;

/**
 * Layout: `version(1) || iv(12) || ciphertext(n) || tag(16)`
 *
 * Self-describing on purpose. A stored blob that needs external metadata to be
 * decrypted becomes undecryptable the moment that metadata drifts, and the
 * failure surfaces years later during a restore.
 */
const HEADER_BYTES = 1 + IV_BYTES;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new RangeError(
      `AES-256-GCM requires a ${String(KEY_BYTES)}-byte key, got ${String(key.length)}.`,
    );
  }
}

/**
 * Encrypts `plaintext` under `key`.
 *
 * `aad` (additional authenticated data) is not encrypted but IS covered by the
 * tag, so decryption fails unless the same value is supplied. Bind it to where
 * the ciphertext lives — org id, table, column, row id. Without that binding a
 * ciphertext is portable: a tenant who can write their own row can paste another
 * tenant's encrypted value into it and have the application decrypt it for them.
 * The crypto is intact; the authorization is gone.
 *
 * A fresh random nonce is drawn per call. Nonce reuse under the same key is
 * catastrophic in GCM — it leaks the XOR of two plaintexts AND the authentication
 * subkey, which lets an attacker forge tags at will. 96-bit random nonces stay
 * comfortably below the birthday bound for any realistic per-org volume; if a
 * single data key ever approaches ~2^32 messages, it needs rotating, not a
 * bigger nonce.
 */
export function encrypt(key: Uint8Array, plaintext: Uint8Array | string, aad?: string): Uint8Array {
  assertKey(key);

  const iv = secureBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));

  const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const body = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  const out = new Uint8Array(HEADER_BYTES + body.length + TAG_BYTES);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(body, HEADER_BYTES);
  out.set(tag, HEADER_BYTES + body.length);
  return out;
}

/**
 * Decrypts a blob produced by `encrypt`.
 *
 * Throws `DecryptionError` for every failure mode — wrong key, wrong AAD,
 * truncated input, tampered ciphertext — with the same message in each case.
 * Distinguishing them would hand an attacker an oracle, and there is no caller
 * that can act differently on the difference anyway.
 */
export function decrypt(key: Uint8Array, blob: Uint8Array, aad?: string): Uint8Array {
  assertKey(key);

  if (blob.length < HEADER_BYTES + TAG_BYTES) {
    throw new DecryptionError('Unable to decrypt.');
  }
  if (blob[0] !== VERSION) {
    // Distinct message: this one is an operational fact about our own data, not
    // a signal derived from attacker-supplied input.
    throw new DecryptionError(`Unsupported envelope version: ${String(blob[0])}`);
  }

  const iv = blob.subarray(1, HEADER_BYTES);
  const body = blob.subarray(HEADER_BYTES, blob.length - TAG_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    throw new DecryptionError('Unable to decrypt.');
  }
}

/** `encrypt` for UTF-8 text. */
export function encryptString(key: Uint8Array, plaintext: string, aad?: string): Uint8Array {
  return encrypt(key, plaintext, aad);
}

/** `decrypt` for UTF-8 text. */
export function decryptString(key: Uint8Array, blob: Uint8Array, aad?: string): string {
  return Buffer.from(decrypt(key, blob, aad)).toString('utf8');
}

/**
 * Canonical AAD for an encrypted column.
 *
 * Field-level encryption should always pass one of these rather than an ad-hoc
 * string, so that the binding is uniform and a ciphertext moved between rows,
 * columns, or tenants fails to decrypt.
 */
export function fieldAad(parts: {
  orgId: string;
  table: string;
  column: string;
  rowId: string;
}): string {
  return `org=${parts.orgId}|table=${parts.table}|column=${parts.column}|row=${parts.rowId}`;
}

export const AES_KEY_BYTES = KEY_BYTES;
