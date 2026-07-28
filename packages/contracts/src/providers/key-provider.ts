/**
 * KeyProvider — envelope encryption (PLAN.md §5, §8.4).
 *
 * Sensitive fields are encrypted with a per-organization DATA key, which is
 * itself encrypted ("wrapped") by a MASTER key that never leaves this provider.
 * Two properties fall out of that:
 *
 *   - The master key is the only thing needing hardware protection.
 *   - Destroying an org's data key renders all of its encrypted data
 *     unrecoverable — which is how GDPR erasure is actually satisfied at scale
 *     (crypto-shredding), rather than chasing rows through backups.
 *
 * Implementations:
 *   SoftwareKeyProvider  master key from the secrets store   (free tier, now)
 *   KmsKeyProvider       AWS/GCP KMS, master key in an HSM   (first real users)
 *
 * The software implementation is the one genuine security downgrade of the free
 * tier. It is contained entirely behind this interface: swapping to KMS changes
 * a config value, not a call site.
 */

/** An org data key, wrapped by the master key. Safe to store in the database. */
export interface WrappedDataKey {
  /** Opaque ciphertext of the data key. */
  readonly wrapped: Uint8Array;
  /** Which master key wrapped it — required to survive master-key rotation. */
  readonly masterKeyId: string;
  /** For KMS providers that need it to unwrap. */
  readonly encryptionContext?: Readonly<Record<string, string>>;
}

/** A data key in plaintext. Must never be logged, persisted, or serialized. */
export interface DataKey {
  readonly key: Uint8Array;
  readonly masterKeyId: string;
}

export interface KeyProvider {
  /**
   * Generates a new data key, returning both the plaintext (for immediate use)
   * and the wrapped form (for storage). The plaintext is never persisted.
   */
  generateDataKey(context?: Record<string, string>): Promise<{
    plaintext: DataKey;
    wrapped: WrappedDataKey;
  }>;

  /** Decrypts a stored data key so it can be used. */
  unwrapDataKey(wrapped: WrappedDataKey): Promise<DataKey>;

  /**
   * Re-wraps a data key under the current master key.
   *
   * Called during master-key rotation. Data stays encrypted under the SAME data
   * key, so nothing needs re-encrypting — only the small wrapped blob changes.
   * That is the property that makes rotation cheap.
   */
  rewrapDataKey(wrapped: WrappedDataKey): Promise<WrappedDataKey>;

  /** Identifier of the master key currently used for new wraps. */
  readonly currentMasterKeyId: string;
}
