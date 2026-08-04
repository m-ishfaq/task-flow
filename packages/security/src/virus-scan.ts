import { connect, type Socket } from 'node:net';

/**
 * Virus scanning over the ClamAV INSTREAM protocol (PLAN.md §8.4).
 *
 * Step three of the upload pipeline. An attachment is not flagged downloadable
 * until this has looked at it.
 *
 * ## Fail closed, always
 *
 * Every failure mode here — clamd down, connection refused, timeout, a reply
 * this code does not recognize — returns `error`, and the caller must treat
 * that as "not clean". It is the one decision in this file that matters: a
 * scanner that fails open turns an outage into an unscanned-upload window, and
 * that window is invisible because uploads keep working perfectly.
 *
 * ## Why raw sockets rather than a client library
 *
 * INSTREAM is four lines of protocol — a command, length-prefixed chunks, a
 * zero-length terminator, a one-line reply. Every npm client wraps exactly that
 * and adds a dependency to the path where hostile bytes are handled. The
 * protocol has not changed in fifteen years.
 *
 * The framing is the part worth reading carefully: each chunk is a 4-byte
 * big-endian length followed by the data, and a chunk longer than clamd's
 * StreamMaxLength causes it to close the connection mid-write — which surfaces
 * as EPIPE rather than as a verdict, and must not be mistaken for a clean file.
 */

export type ScanVerdict = 'clean' | 'infected' | 'error';

export interface ScanResult {
  readonly verdict: ScanVerdict;
  /** Signature name for an infection, or the failure reason for an error. */
  readonly detail?: string;
}

export interface ScannerConfig {
  readonly host: string;
  readonly port: number;
  /**
   * Whole-operation budget, including connect.
   *
   * A scan of a large file legitimately takes seconds; a scanner that has
   * wedged takes forever. The timeout is what turns the second case into a
   * fail-closed error instead of a request that never returns.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** clamd's default StreamMaxLength is 25 MB; stay well inside one chunk of it. */
const CHUNK_SIZE = 64 * 1024;

/**
 * Scans a buffer, returning a verdict.
 *
 * Takes the bytes rather than a stream because every caller already has to hold
 * the object to hash it, and streaming would make the fail-closed guarantee
 * harder to reason about — a stream that ends early looks identical to a small
 * file.
 */
export async function scanBuffer(data: Uint8Array, config: ScannerConfig): Promise<ScanResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ScanResult>((resolve) => {
    let settled = false;
    const finish = (result: ScanResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket: Socket = connect({ host: config.host, port: config.port });
    socket.setTimeout(timeoutMs);

    const chunks: Buffer[] = [];

    socket.on('connect', () => {
      /* zINSTREAM rather than nINSTREAM: the `z` variants are NUL-terminated
         and unambiguous, where the `n` variants depend on newline handling that
         differs between clamd builds. */
      socket.write('zINSTREAM\0');

      for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
        const slice = data.subarray(offset, offset + CHUNK_SIZE);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(slice.length, 0);
        socket.write(header);
        socket.write(slice);
      }

      // Zero-length chunk terminates the stream and asks for the verdict.
      const terminator = Buffer.alloc(4);
      terminator.writeUInt32BE(0, 0);
      socket.write(terminator);
    });

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    socket.on('end', () => {
      finish(interpret(Buffer.concat(chunks).toString('utf8')));
    });

    socket.on('timeout', () => {
      finish({ verdict: 'error', detail: `Scanner timed out after ${String(timeoutMs)}ms.` });
    });

    socket.on('error', (error: Error) => {
      // Includes ECONNREFUSED (clamd down) and EPIPE (chunk over
      // StreamMaxLength). Both are "we do not know", never "clean".
      finish({ verdict: 'error', detail: error.message });
    });
  });
}

/**
 * Reads clamd's one-line reply.
 *
 * The three shapes are `stream: OK`, `stream: <Signature> FOUND`, and
 * `... ERROR`. Anything else is treated as an error rather than parsed
 * optimistically — a reply this code does not understand is not evidence of a
 * clean file.
 */
function interpret(reply: string): ScanResult {
  const line = reply.replace(/\0/g, '').trim();

  if (line.endsWith('OK') && !line.includes('FOUND')) return { verdict: 'clean' };

  if (line.endsWith('FOUND')) {
    const signature = line.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '');
    return { verdict: 'infected', detail: signature };
  }

  return { verdict: 'error', detail: line.length > 0 ? line : 'Empty reply from scanner.' };
}

/**
 * True when clamd answers its PING.
 *
 * For the health endpoint and for tests that need to skip when the container is
 * still loading signatures — which takes minutes on a cold start and would
 * otherwise look like a scanner failure.
 */
export async function isScannerReady(config: ScannerConfig): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };

    const socket = connect({ host: config.host, port: config.port });
    socket.setTimeout(config.timeoutMs ?? 2000);

    socket.on('connect', () => {
      socket.write('zPING\0');
    });
    socket.on('data', (chunk: Buffer) => {
      finish(chunk.toString('utf8').includes('PONG'));
    });
    socket.on('timeout', () => {
      finish(false);
    });
    socket.on('error', () => {
      finish(false);
    });
  });
}

/**
 * The EICAR test string — the industry-standard harmless file every scanner
 * detects (https://www.eicar.org).
 *
 * Split across concatenation so this source file does not itself contain the
 * literal pattern, which would make a virus scanner quarantine the repository.
 */
export const EICAR_TEST_SIGNATURE =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
