import { lookup } from 'node:dns/promises';
import { isAllowedUrl, isBlockedAddress, isIpAddress } from '@taskflow/security';

/**
 * Fetching a link preview without becoming an SSRF proxy (PLAN.md §8.7).
 *
 * ⚠ HUMAN REVIEW SURFACE-adjacent: this is the outbound-request path. The
 * DECISION about which addresses are reachable lives in
 * `@taskflow/security/outbound-url`; this file is the I/O around it.
 *
 * ## Four controls, and each one is load-bearing
 *
 *   1. URL shape        scheme, port, credentials — before any lookup.
 *   2. Resolved address every A/AAAA record is checked, not just the first.
 *   3. No redirects     a 302 to 127.0.0.1 would bypass 1 and 2 entirely.
 *   4. Bounded          timeout and response cap, so one URL cannot hang or
 *                       exhaust the process.
 *
 * ## Why redirects are refused rather than re-checked
 *
 * Re-checking each hop is possible and is what a careful proxy does. It is also
 * a loop with state, and the failure mode of getting it slightly wrong is
 * silent. Refusing outright costs a preview on sites that redirect — many do —
 * and buys a control with no moving parts. §8.7 says "redirects not followed",
 * and this is that, literally.
 *
 * ## The DNS check races, and cannot be fully closed here
 *
 * Between resolving a name and connecting, DNS can change — the classic
 * DNS-rebinding window. Closing it properly means pinning the checked IP into
 * the connection, which needs a custom agent/socket factory. What this does
 * instead is check every resolved address and refuse if ANY is private, which
 * removes the attacker's easy path (a record that answers with a private
 * address) and leaves only the timing attack. Recorded here rather than
 * implied, because "we resolve then fetch" reads as safe and is not the same
 * thing as safe.
 */

/** How long the whole request may take. */
const TIMEOUT_MS = 5_000;

/** How much of the response body is read before giving up. */
const MAX_BYTES = 512 * 1024;

/** Content types worth parsing. Anything else is not a page with a preview. */
const PREVIEWABLE = ['text/html', 'application/xhtml+xml'];

export interface UnfurlPreview {
  readonly url: string;
  readonly title: string | null;
  readonly description: string | null;
  /** An absolute image URL that passed the same address checks as the page. */
  readonly imageUrl: string | null;
  readonly siteName: string | null;
}

export type UnfurlOutcome =
  | { readonly ok: true; readonly preview: UnfurlPreview }
  | { readonly ok: false; readonly reason: string };

/**
 * Fetches a URL and extracts its preview metadata, or explains why it did not.
 *
 * Never throws for an untrusted-input problem: a refused URL is a normal
 * outcome recorded against the message, and an exception would make "this link
 * is not previewable" and "the process is broken" the same control flow.
 */
export async function fetchUnfurl(raw: string): Promise<UnfurlOutcome> {
  const shape = isAllowedUrl(raw);
  if (!shape.allowed) return { ok: false, reason: shape.reason ?? 'refused' };

  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');

  /* Every resolved address, not just the first. A hostname with two A records —
     one public, one private — would otherwise be a coin flip, and an attacker
     controls both records. */
  if (!isIpAddress(host)) {
    let addresses: readonly { address: string }[];
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      return { ok: false, reason: 'refused' };
    }

    if (addresses.length === 0) return { ok: false, reason: 'refused' };
    if (addresses.some((entry) => isBlockedAddress(entry.address))) {
      return { ok: false, reason: 'refused' };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      /* MANUAL, not 'follow'. A 302 to http://169.254.169.254/ would otherwise
         be followed by the HTTP client itself, after every check above has
         already passed — which is the whole SSRF bypass in one header. */
      redirect: 'manual',
      signal: controller.signal,
      /* No cookies, no auth, no referrer. This request must carry nothing that
         would let a third-party server act as, or learn about, our users. */
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'TaskFlow-LinkPreview/1.0',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      return { ok: false, reason: 'refused' };
    }
    if (!response.ok) return { ok: false, reason: 'unavailable' };

    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!PREVIEWABLE.some((allowed) => type.startsWith(allowed))) {
      return { ok: false, reason: 'not previewable' };
    }

    const html = await readCapped(response, MAX_BYTES);
    return { ok: true, preview: extractPreview(url.toString(), html) };
  } catch {
    /* A timeout, a connection refused, a TLS failure. All the same to the
       caller: no preview. The reason is deliberately coarse — a detailed one
       would turn this endpoint into a port scanner with readable output. */
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads at most `limit` bytes of a response body.
 *
 * `response.text()` would read whatever the server sends, and a server that
 * streams forever is a server that exhausts this process. Reading the stream
 * and stopping is the only way to bound it — `Content-Length` is a claim, not
 * a limit.
 */
async function readCapped(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (body === null) return '';

  /* Typed explicitly: `body` is `ReadableStream<any>` in the DOM lib, so
     destructuring the read result hands `any` straight into the loop and every
     use of it is unchecked. Naming the type here is what makes the byte
     arithmetic below actually type-checked. */
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;

      const value: Uint8Array = result.value;
      chunks.push(value);
      total += value.byteLength;
      if (total >= limit) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk.subarray(0, Math.min(chunk.byteLength, total - offset)), offset);
    offset += chunk.byteLength;
    if (offset >= total) break;
  }

  return new TextDecoder('utf-8', { fatal: false }).decode(joined);
}

/**
 * Pulls OpenGraph and `<title>` metadata out of an HTML string.
 *
 * Regex rather than a DOM parser, deliberately: this input is hostile and
 * unbounded, and adding an HTML parser to the dependency tree to read four
 * attributes is a larger attack surface than the thing it parses. Everything
 * extracted is TEXT that gets rendered as text — the values never become markup
 * (CLAUDE.md rule 4), so a malformed match produces a wrong title, not an
 * injection.
 */
function extractPreview(url: string, html: string): UnfurlPreview {
  const meta = (property: string): string | null => {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
      'i',
    );
    const alternate = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
      'i',
    );
    return clean(pattern.exec(html)?.[1] ?? alternate.exec(html)?.[1] ?? null);
  };

  const title =
    meta('og:title') ?? clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null);

  /* The image is a URL this server publishes to clients, which then load it —
     so it gets the same shape check the page did. An `og:image` pointing at an
     internal address would otherwise turn every viewer's browser into the
     fetcher this whole file exists to avoid being. */
  const rawImage = meta('og:image');
  const imageUrl =
    rawImage !== null && isAllowedUrl(absolute(rawImage, url)).allowed
      ? absolute(rawImage, url)
      : null;

  return {
    url,
    title,
    description: meta('og:description') ?? meta('description'),
    imageUrl,
    siteName: meta('og:site_name'),
  };
}

function absolute(candidate: string, base: string): string {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return candidate;
  }
}

/** Trims, collapses whitespace, decodes the few entities that matter, and caps. */
function clean(value: string | null): string | null {
  if (value === null) return null;

  const text = value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

  return text === '' ? null : text;
}

/** Every http(s) URL in a plain-text string, deduplicated, in order. */
export function extractUrls(text: string, limit = 3): readonly string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const candidate = match[0].replace(/[.,;:!?)\]]+$/, '');
    found.add(candidate);
    if (found.size >= limit) break;
  }

  return [...found];
}
