import { createHash } from 'node:crypto';

/**
 * Breached-password check via the Have I Been Pwned range API (PLAN.md §8.1).
 *
 * Checked on every password SET — registration, reset, change. It is the single
 * highest-value password control there is: credential stuffing against reused
 * passwords accounts for more account takeover than cracking ever has, and no
 * complexity rule catches `Summer2024!` appearing in a hundred breach corpora.
 *
 * **k-anonymity.** Only the first five hex characters of the hash are sent. The
 * service answers with every suffix sharing that prefix — typically 300-900 of
 * them — and the match happens locally. HIBP therefore never learns the
 * password, and cannot even narrow it beyond one bucket in a million.
 *
 * The SHA-1 below is not a security claim. It is the index the API is built on,
 * and it never leaves this process in full. Do not read it as an endorsement of
 * SHA-1 for anything.
 */

const RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range';

export type BreachResult =
  /** Not present in any corpus HIBP knows about. */
  | { readonly status: 'ok' }
  /** Seen in a breach; `count` is how many times. */
  | { readonly status: 'breached'; readonly count: number }
  /** The service could not be reached or answered unusably. */
  | { readonly status: 'unavailable'; readonly reason: string };

export interface BreachCheckOptions {
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Abort budget. A password form must not hang on a third party. */
  readonly timeoutMs?: number;
}

/**
 * Looks a password up in HIBP.
 *
 * Deliberately returns a three-state result rather than a boolean, and takes no
 * position on what `unavailable` should mean. That is a product decision with
 * real weight — failing closed blocks every registration while a third party is
 * down, failing open silently disables the control — and it belongs at the
 * identity layer where it can be logged, alerted on, and changed by policy. A
 * default buried in this function would be a security posture nobody chose.
 */
export async function checkPasswordBreached(
  password: string,
  options: BreachCheckOptions = {},
): Promise<BreachResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;

  const digest = createHash('sha1')
    .update(password.normalize('NFC'), 'utf8')
    .digest('hex')
    .toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);

  let body: string;
  try {
    const response = await doFetch(`${RANGE_ENDPOINT}/${prefix}`, {
      // Pads the response with random decoy suffixes so an observer who can see
      // the response SIZE cannot infer which bucket was requested. Without it,
      // TLS length leakage partially undoes the k-anonymity.
      headers: { 'Add-Padding': 'true', 'User-Agent': 'TaskFlow' },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return { status: 'unavailable', reason: `HTTP ${String(response.status)}` };
    }
    body = await response.text();
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'unknown' };
  }

  for (const line of body.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    if (line.slice(0, separator).trim().toUpperCase() === suffix) {
      const count = Number.parseInt(line.slice(separator + 1).trim(), 10);
      // Padding entries are returned with a count of 0 and must not be treated
      // as hits — that is what distinguishes a decoy from a real match.
      if (Number.isFinite(count) && count > 0) {
        return { status: 'breached', count };
      }
      return { status: 'ok' };
    }
  }

  return { status: 'ok' };
}
