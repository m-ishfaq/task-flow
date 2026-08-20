/**
 * The client-type marker (ai/phase-14-mobile.md §4.3, §8).
 *
 * A phone has no browser to enforce anything about what it sends, so this
 * header is a HINT the server is free to read but must never trust as an
 * authorization input — the identical caveat `x-taskflow-org` carries for
 * tenant selection, generalized to "which kind of client is this". Nothing may
 * ever grant an ability a plain request would not otherwise have on the
 * strength of this header alone; the two legitimate uses are:
 *
 *   - SELECTING which of two paths already open to the caller a request is
 *     routed through (a native vs. browser response shape), or
 *   - RELAXING a check that does not apply to a client this hint identifies as
 *     (`apps/realtime`'s origin check has no browser-equivalent signal to read
 *     for a native socket — see that file's own comment on why the token
 *     verification immediately following is what actually protects that path,
 *     not this header).
 *
 * Shared here rather than defined once per app because the same string has to
 * mean the same thing to `apps/mobile`'s HTTP client, `apps/mobile`'s socket
 * client, and `apps/realtime`'s handshake — three places that would otherwise
 * each hold their own copy of a value the other two must agree on byte for
 * byte.
 */
export const CLIENT_HEADER = 'x-taskflow-client';
export const MOBILE_CLIENT = 'mobile';
