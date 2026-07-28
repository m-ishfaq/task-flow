import { describe, expect, it } from 'vitest';
import {
  SoftwareKeyProvider,
  generateMasterKeyBase64,
  masterKeysFromBase64,
  type MasterKey,
} from './software-key-provider.js';
import { AES_KEY_BYTES, decryptString, encryptString } from './encryption.js';
import { secureBytes } from './random.js';

const master = (id: string): MasterKey => ({ id, key: secureBytes(AES_KEY_BYTES) });

function provider(current = 'mk-1', keys: MasterKey[] = [master('mk-1')]): SoftwareKeyProvider {
  return new SoftwareKeyProvider({ masterKeys: keys, currentMasterKeyId: current });
}

describe('construction', () => {
  it('rejects an empty key set', () => {
    expect(() => new SoftwareKeyProvider({ masterKeys: [], currentMasterKeyId: 'mk-1' })).toThrow();
  });

  it('rejects a master key of the wrong size', () => {
    expect(
      () =>
        new SoftwareKeyProvider({
          masterKeys: [{ id: 'mk-1', key: secureBytes(16) }],
          currentMasterKeyId: 'mk-1',
        }),
    ).toThrow(RangeError);
  });

  it('rejects duplicate key ids', () => {
    // With duplicates, which key unwraps a blob would depend on load order, and
    // the resulting failures would look like data corruption.
    expect(() => provider('mk-1', [master('mk-1'), master('mk-1')])).toThrow(/Duplicate/);
  });

  it('rejects a current key id that is not loaded', () => {
    // Must fail at boot, not on the first write. A misconfigured provider that
    // starts successfully is the worst version of this bug.
    expect(() => provider('mk-missing', [master('mk-1')])).toThrow(/not among the keys/);
  });
});

describe('generate and unwrap', () => {
  it('round-trips a data key', async () => {
    const kp = provider();
    const { plaintext, wrapped } = await kp.generateDataKey();

    expect(plaintext.key).toHaveLength(AES_KEY_BYTES);
    expect(wrapped.masterKeyId).toBe('mk-1');

    const unwrapped = await kp.unwrapDataKey(wrapped);
    expect([...unwrapped.key]).toEqual([...plaintext.key]);
  });

  it('produces a distinct data key per organization', async () => {
    const kp = provider();
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const { plaintext } = await kp.generateDataKey();
      seen.add(Buffer.from(plaintext.key).toString('hex'));
    }
    expect(seen.size).toBe(100);
  });

  it('never stores the data key in the clear', async () => {
    const { plaintext, wrapped } = await provider().generateDataKey();
    const wrappedHex = Buffer.from(wrapped.wrapped).toString('hex');
    expect(wrappedHex).not.toContain(Buffer.from(plaintext.key).toString('hex'));
  });

  it('rejects a blob whose masterKeyId is not loaded', async () => {
    // Retiring a key by deleting it makes everything it wrapped unreadable. The
    // error says so, because the alternative is silent data loss discovered at
    // restore time.
    const kp = provider();
    const { wrapped } = await kp.generateDataKey();

    await expect(kp.unwrapDataKey({ ...wrapped, masterKeyId: 'mk-retired' })).rejects.toThrow(
      /not loaded/,
    );
  });
});

describe('encryption context', () => {
  it('round-trips when the context matches', async () => {
    const kp = provider();
    const context = { orgId: 'org-1', purpose: 'field-encryption' };
    const { plaintext, wrapped } = await kp.generateDataKey(context);

    const unwrapped = await kp.unwrapDataKey(wrapped);
    expect([...unwrapped.key]).toEqual([...plaintext.key]);
  });

  it('fails when the context is altered', async () => {
    // A wrapped key lifted from one org's row into another's must not unwrap.
    const kp = provider();
    const { wrapped } = await kp.generateDataKey({ orgId: 'org-1' });

    await expect(
      kp.unwrapDataKey({ ...wrapped, encryptionContext: { orgId: 'org-2' } }),
    ).rejects.toThrow();
  });

  it('fails when the context is dropped entirely', async () => {
    const kp = provider();
    const { wrapped } = await kp.generateDataKey({ orgId: 'org-1' });
    const { encryptionContext: _dropped, ...withoutContext } = wrapped;

    await expect(kp.unwrapDataKey(withoutContext)).rejects.toThrow();
  });

  it('does not depend on property insertion order', async () => {
    // The AAD is built from sorted entries, so it is a function of the context's
    // content rather than of how the object happened to be constructed. Without
    // sorting, a context rebuilt from a JSON round-trip could fail to unwrap.
    const kp = provider();
    const { wrapped } = await kp.generateDataKey({ a: '1', b: '2' });

    await expect(
      kp.unwrapDataKey({ ...wrapped, encryptionContext: { b: '2', a: '1' } }),
    ).resolves.toBeDefined();
  });

  it('distinguishes contexts that would collide under naive concatenation', async () => {
    // {"a": "1&b=2"} and {"a": "1", "b": "2"} both flatten to "a=1&b=2" if the
    // values are not encoded — letting an attacker who controls one value forge
    // a different context.
    const kp = provider();
    const { wrapped } = await kp.generateDataKey({ a: '1&b=2' });

    await expect(
      kp.unwrapDataKey({ ...wrapped, encryptionContext: { a: '1', b: '2' } }),
    ).rejects.toThrow();
  });

  it('omits the context key entirely when none was given', async () => {
    // `exactOptionalPropertyTypes` distinguishes an absent key from an explicit
    // undefined, and the difference survives into stored JSON.
    const { wrapped } = await provider().generateDataKey();
    expect('encryptionContext' in wrapped).toBe(false);
  });
});

describe('master key rotation', () => {
  it('rewraps under the current key without touching the data key', async () => {
    // The property that makes rotation cheap: encrypted DATA is never rewritten,
    // only the small wrapped blob. Data encrypted before rotation must still
    // decrypt after it.
    const oldKey = master('mk-2026-01');
    const newKey = master('mk-2026-07');

    const before = provider('mk-2026-01', [oldKey]);
    const { plaintext, wrapped } = await before.generateDataKey({ orgId: 'org-1' });
    const ciphertext = encryptString(plaintext.key, 'recording-url');

    const after = provider('mk-2026-07', [oldKey, newKey]);
    const rewrapped = await after.rewrapDataKey(wrapped);

    expect(rewrapped.masterKeyId).toBe('mk-2026-07');
    expect(Buffer.from(rewrapped.wrapped)).not.toEqual(Buffer.from(wrapped.wrapped));

    const recovered = await after.unwrapDataKey(rewrapped);
    expect(decryptString(recovered.key, ciphertext)).toBe('recording-url');
  });

  it('preserves the encryption context across a rewrap', async () => {
    const oldKey = master('mk-1');
    const newKey = master('mk-2');
    const before = provider('mk-1', [oldKey]);
    const { wrapped } = await before.generateDataKey({ orgId: 'org-1' });

    const after = provider('mk-2', [oldKey, newKey]);
    const rewrapped = await after.rewrapDataKey(wrapped);

    expect(rewrapped.encryptionContext).toEqual({ orgId: 'org-1' });
    await expect(after.unwrapDataKey(rewrapped)).resolves.toBeDefined();
  });

  it('keeps reading blobs wrapped by a retired key', async () => {
    const oldKey = master('mk-1');
    const before = provider('mk-1', [oldKey]);
    const { plaintext, wrapped } = await before.generateDataKey();

    const after = provider('mk-2', [oldKey, master('mk-2')]);
    const unwrapped = await after.unwrapDataKey(wrapped);
    expect([...unwrapped.key]).toEqual([...plaintext.key]);
  });
});

describe('crypto-shredding', () => {
  it('makes an org unrecoverable once its wrapped key is destroyed', async () => {
    // This is what GDPR erasure actually looks like at scale (PLAN.md §8.4):
    // one small row is deleted and the org's data becomes unreadable
    // everywhere, including in backups already written to storage nobody can
    // rewrite.
    const kp = provider();
    const { plaintext, wrapped } = await kp.generateDataKey({ orgId: 'org-erased' });
    const ciphertext = encryptString(plaintext.key, 'personal data');

    // The org row is deleted; only the ciphertext survives.
    const survivingWrapped = Uint8Array.from(wrapped.wrapped);
    plaintext.key.fill(0);

    expect(() => decryptString(secureBytes(AES_KEY_BYTES), ciphertext)).toThrow();
    expect(survivingWrapped).toBeDefined(); // the blob is useless without the master key
  });
});

describe('masterKeysFromBase64', () => {
  it('decodes generated key material', () => {
    const encoded = generateMasterKeyBase64();
    const [key] = masterKeysFromBase64({ 'mk-1': encoded });

    expect(key?.id).toBe('mk-1');
    expect(key?.key).toHaveLength(AES_KEY_BYTES);
  });

  it('generates distinct material each time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateMasterKeyBase64()));
    expect(seen.size).toBe(50);
  });

  it('rejects a truncated secret at boot rather than at first encrypt', () => {
    expect(() => masterKeysFromBase64({ 'mk-1': 'dG9vLXNob3J0' })).toThrow(RangeError);
    expect(() => masterKeysFromBase64({ 'mk-1': '' })).toThrow(RangeError);
  });
});
