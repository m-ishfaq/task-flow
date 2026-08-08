import { describe, expect, it } from 'vitest';
import {
  ARGON2_PARAMS,
  MAX_PASSWORD_LENGTH,
  fakeVerifyPassword,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

describe('hashPassword', () => {
  it('round-trips', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('produces a different hash every time', async () => {
    // Argon2 salts internally. Two identical passwords hashing to the same value
    // would mean the salt was fixed or missing, which makes the whole table
    // crackable at once.
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('embeds the configured parameters in the encoded hash', async () => {
    const hash = await hashPassword('parameters');
    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(hash).toContain(`m=${String(ARGON2_PARAMS.memoryCost)}`);
    expect(hash).toContain(`t=${String(ARGON2_PARAMS.timeCost)}`);
    expect(hash).toContain(`p=${String(ARGON2_PARAMS.parallelism)}`);
  });

  it('meets the OWASP Argon2id baseline', () => {
    // Pinned as a test, not just a constant, so that lowering these to speed up
    // CI is a visible, deliberate change rather than a quiet edit.
    expect(ARGON2_PARAMS.memoryCost).toBeGreaterThanOrEqual(19_456);
    expect(ARGON2_PARAMS.timeCost).toBeGreaterThanOrEqual(2);
  });
});

describe('unicode handling', () => {
  it('accepts the same password typed with different normalizations', async () => {
    // "é" as one code point vs. "e" + combining acute. Which one a user's
    // keyboard emits depends on their OS and input method, so without NFC
    // normalization the same typed password fails on a different device — a bug
    // that is essentially undiagnosable from a log.
    const composed = 'passw' + String.fromCharCode(0x00e9) + 'rd'; // single code point
    const decomposed = composed.normalize('NFD'); // e + combining acute
    expect(composed).not.toBe(decomposed);

    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it('does not fold visually distinct characters together', async () => {
    // NFC, not NFKC. Compatibility folding would collapse these and quietly
    // shrink the password space.
    const hash = await hashPassword(String.fromCharCode(0xfb01) + 're'); // fi ligature
    expect(await verifyPassword('fire', hash)).toBe(false);
  });
});

describe('input bounds', () => {
  it('rejects an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow(RangeError);
  });

  it('rejects an oversized password', async () => {
    await expect(hashPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow(RangeError);
  });

  it('accepts a password at the limit', async () => {
    const password = 'a'.repeat(MAX_PASSWORD_LENGTH);
    expect(await verifyPassword(password, await hashPassword(password))).toBe(true);
  });

  it('returns false rather than throwing on an oversized verify', async () => {
    // Verification takes untrusted input directly. A throw here would surface as
    // a 500 that distinguishes one class of guess from another.
    const hash = await hashPassword('short');
    expect(await verifyPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1), hash)).toBe(false);
  });
});

describe('verifyPassword robustness', () => {
  it.each([
    ['empty', ''],
    ['not a PHC string', 'plaintext'],
    ['truncated', '$argon2id$v=19$m=19456,t=2,p=1$abc'],
    ['bcrypt', '$2b$12$abcdefghijklmnopqrstuv'],
  ])('returns false for a %s stored hash', async (_label, stored) => {
    // A corrupt row must read as "authentication failed". Throwing would turn a
    // data problem into an outage, and the error would reach the client.
    await expect(verifyPassword('anything', stored)).resolves.toBe(false);
  });
});

describe('fakeVerifyPassword', () => {
  it('always fails', async () => {
    expect(await fakeVerifyPassword('anything')).toBe(false);
  });

  it('costs about as much as a real verification', async () => {
    // The point of the function. Skipping the hash for unknown accounts answers
    // in ~1 ms instead of ~50 ms, and that gap tells an attacker which email
    // addresses are registered — for a B2B product, the customer list.
    const hash = await hashPassword('reference');
    await fakeVerifyPassword('warm-up'); // exclude first-call overhead from the comparison

    // Several samples, minimum taken. `pnpm verify` runs every package's tests
    // in parallel, and a single Argon2 sample under that CPU contention can be
    // an order of magnitude off its uncontended cost in either direction — the
    // original one-shot comparison failed spuriously on exactly that. Contention
    // only ever ADDS time, so the minimum of a few samples is the stable
    // estimator of each side's true cost, and the ratio of two minimums is what
    // the oracle-defeating property is actually about.
    const sample = async (run: () => Promise<void>): Promise<number> => {
      let best = Number.POSITIVE_INFINITY;
      for (let index = 0; index < 5; index += 1) {
        const start = performance.now();
        await run();
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };

    const real = await sample(async () => {
      await verifyPassword('wrong-guess', hash);
    });
    const fake = await sample(async () => {
      await fakeVerifyPassword('wrong-guess');
    });

    // Generous bounds: this asserts "same order of magnitude", which is what
    // defeats the oracle. A tight ratio would be flaky on shared CI runners.
    expect(fake).toBeGreaterThan(real * 0.3);
    expect(fake).toBeLessThan(real * 3);
  });
});

describe('needsRehash', () => {
  it('is false for a hash made with the current parameters', async () => {
    expect(needsRehash(await hashPassword('current'))).toBe(false);
  });

  it.each([
    ['weaker memory', '$argon2id$v=19$m=4096,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g'],
    ['fewer passes', '$argon2id$v=19$m=19456,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2g'],
    ['argon2i', '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g'],
    ['old version', '$argon2id$v=16$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g'],
  ])('is true for %s', (_label, stored) => {
    expect(needsRehash(stored)).toBe(true);
  });

  it('is true for a hash it cannot parse', () => {
    // Unparseable means "from some other library, or corrupt". Either way the
    // next successful login should replace it. Returning false here would let a
    // legacy bcrypt hash survive forever.
    expect(needsRehash('$2b$12$abcdefghijklmnopqrstuv')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });

  it('is false for stronger-than-current parameters', () => {
    // A hash from a future, stronger configuration must not be downgraded.
    expect(needsRehash('$argon2id$v=19$m=65536,t=4,p=1$c2FsdHNhbHQ$aGFzaGhhc2g')).toBe(false);
  });
});
