import type { DataKey, KeyProvider, WrappedDataKey } from '@taskflow/contracts';
import { AES_KEY_BYTES, decrypt, encrypt } from './encryption.js';
import { secureBytes, wipe } from './random.js';

/**
 * `KeyProvider` backed by master keys held in this process (PLAN.md §5, §8.4).
 *
 * This is the documented free-tier downgrade. `KmsKeyProvider` keeps the master
 * key inside an HSM where it can be used but never read; this one keeps it in
 * heap memory, so anyone who can read the process — a heap dump, a container
 * escape, an SSRF that reaches the secrets store — gets every org's data. The
 * mitigation is structural rather than cryptographic: the code path is identical
 * to the KMS one, so the upgrade is a config change and a `rewrapDataKey` sweep,
 * with no call site touched.
 *
 * What it still buys, even at this assurance level:
 *
 *   - A stolen database dump alone is useless; the master key is not in it.
 *   - **Crypto-shredding.** Deleting an org's wrapped data key makes that org's
 *     encrypted data unrecoverable everywhere at once, including in backups
 *     already written to storage nobody can rewrite. That is how GDPR erasure is
 *     actually satisfied at scale (§8.4).
 *   - Master-key rotation is cheap: only the small wrapped blobs are rewritten,
 *     never the encrypted data itself.
 */

export interface MasterKey {
  /**
   * Stable identifier, stored alongside every wrapped key.
   *
   * Retired keys must stay loaded — otherwise data wrapped under them becomes
   * unreadable the moment a new key is promoted. Use something ordered and
   * boring, e.g. `mk-2026-07`.
   */
  readonly id: string;
  /** 32 raw bytes. */
  readonly key: Uint8Array;
}

export interface SoftwareKeyProviderConfig {
  readonly masterKeys: readonly MasterKey[];
  /** Which key wraps NEW data keys. Others are kept for unwrapping only. */
  readonly currentMasterKeyId: string;
}

export class SoftwareKeyProvider implements KeyProvider {
  readonly #keys: ReadonlyMap<string, Uint8Array>;
  readonly currentMasterKeyId: string;

  constructor(config: SoftwareKeyProviderConfig) {
    if (config.masterKeys.length === 0) {
      throw new Error('SoftwareKeyProvider requires at least one master key.');
    }

    const keys = new Map<string, Uint8Array>();
    for (const { id, key } of config.masterKeys) {
      if (key.length !== AES_KEY_BYTES) {
        throw new RangeError(
          `Master key "${id}" must be ${String(AES_KEY_BYTES)} bytes, got ${String(key.length)}.`,
        );
      }
      if (keys.has(id)) {
        // A duplicate id would make unwrapping depend on load order, and the
        // resulting failures would look like data corruption.
        throw new Error(`Duplicate master key id: ${id}`);
      }
      keys.set(id, key);
    }

    if (!keys.has(config.currentMasterKeyId)) {
      // Fail at construction, not on the first write. A misconfigured provider
      // that boots successfully is the worst version of this bug.
      throw new Error(`currentMasterKeyId "${config.currentMasterKeyId}" is not among the keys.`);
    }

    this.#keys = keys;
    this.currentMasterKeyId = config.currentMasterKeyId;
  }

  /*
   * These two do no I/O — the master key is already in memory. They are not
   * marked `async` because there is nothing to await, but the interface is
   * async because a KMS-backed provider makes a network call per operation, and
   * every call site is written for that.
   *
   * The `settle` wrapper is load-bearing. An `async` function turns a throw into
   * a rejected promise for free; a plain function returning a promise does not,
   * so a synchronous throw here would escape a caller's `.catch()` and surface
   * as an unhandled exception instead of a failed unwrap.
   */

  generateDataKey(context?: Record<string, string>): Promise<{
    plaintext: DataKey;
    wrapped: WrappedDataKey;
  }> {
    return settle(() => {
      const material = secureBytes(AES_KEY_BYTES);
      return {
        plaintext: { key: material, masterKeyId: this.currentMasterKeyId },
        wrapped: this.#wrap(material, this.currentMasterKeyId, context),
      };
    });
  }

  unwrapDataKey(wrapped: WrappedDataKey): Promise<DataKey> {
    return settle(() => {
      const master = this.#master(wrapped.masterKeyId);
      const aad = aadFor(wrapped.masterKeyId, wrapped.encryptionContext);
      return { key: decrypt(master, wrapped.wrapped, aad), masterKeyId: wrapped.masterKeyId };
    });
  }

  async rewrapDataKey(wrapped: WrappedDataKey): Promise<WrappedDataKey> {
    const { key } = await this.unwrapDataKey(wrapped);
    try {
      return this.#wrap(key, this.currentMasterKeyId, wrapped.encryptionContext);
    } finally {
      // The plaintext data key was materialized only to re-wrap it; it has no
      // reason to outlive this call. Best-effort — see `wipe`.
      wipe(key);
    }
  }

  #master(id: string): Uint8Array {
    const key = this.#keys.get(id);
    if (!key) {
      throw new Error(
        `Master key "${id}" is not loaded. Retired keys must stay configured or the data they wrapped becomes unreadable.`,
      );
    }
    return key;
  }

  #wrap(
    material: Uint8Array,
    masterKeyId: string,
    context: Readonly<Record<string, string>> | undefined,
  ): WrappedDataKey {
    const blob = encrypt(this.#master(masterKeyId), material, aadFor(masterKeyId, context));

    // Built conditionally rather than with `encryptionContext: context`, because
    // `exactOptionalPropertyTypes` treats an explicit `undefined` as a distinct
    // value from an absent key — and the difference would survive into JSON.
    return context === undefined
      ? { wrapped: blob, masterKeyId }
      : { wrapped: blob, masterKeyId, encryptionContext: { ...context } };
  }
}

/** Runs a synchronous computation, delivering both result and throw as a promise. */
function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Additional authenticated data for a wrap operation.
 *
 * Covers the master key id so a blob cannot be presented as having been wrapped
 * by a different key, and the caller's encryption context so a wrapped key
 * cannot be lifted from one org's row into another's. Neither is secret; both
 * are authenticated.
 *
 * Entries are sorted and percent-encoded. Sorting makes the string a function of
 * the context's CONTENT rather than of JavaScript's property order, which would
 * otherwise make decryption depend on how the object happened to be built.
 * Encoding stops a value containing `&` or `=` from impersonating a different
 * context — the same reason a query string is not built by concatenation.
 */
function aadFor(masterKeyId: string, context?: Readonly<Record<string, string>>): string {
  const encoded = Object.entries(context ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  return `mk=${encodeURIComponent(masterKeyId)}|ctx=${encoded}`;
}

/**
 * Builds master keys from base64 values, as they arrive from the secrets store.
 *
 * Validates length here rather than letting a short key surface as an AES error
 * on the first encrypt — a truncated secret is a configuration mistake that
 * should stop the boot.
 */
export function masterKeysFromBase64(entries: Readonly<Record<string, string>>): MasterKey[] {
  return Object.entries(entries).map(([id, encoded]) => {
    const key = new Uint8Array(Buffer.from(encoded, 'base64'));
    if (key.length !== AES_KEY_BYTES) {
      throw new RangeError(
        `Master key "${id}" decoded to ${String(key.length)} bytes; expected ${String(AES_KEY_BYTES)}.`,
      );
    }
    return { id, key };
  });
}

/** Generates master key material for a new environment. Print once, store, forget. */
export function generateMasterKeyBase64(): string {
  return Buffer.from(secureBytes(AES_KEY_BYTES)).toString('base64');
}
