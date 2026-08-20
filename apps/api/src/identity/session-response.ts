import { z } from 'zod';

/**
 * What a successful sign-in returns, and how the refresh token gets out of it.
 *
 * Shared by password login, refresh, and passkey sign-in. One definition on
 * purpose: three routes that each assemble their own response is three chances
 * for one of them to include the refresh token in the body.
 */

/**
 * Note what is NOT here: the refresh token. It goes into the httpOnly cookie and
 * nowhere else, so script on the page cannot read it. The `.strict()` output
 * schema is the enforcement — adding the field back would fail validation rather
 * than quietly shipping the credential to the browser's JavaScript heap.
 */
export const SessionResponse = z
  .object({
    accessToken: z.string(),
    expiresInSeconds: z.number().int().positive(),
    sessionId: z.string(),
  })
  .strict();

export interface SessionBody {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly sessionId: string;
}

/**
 * Moves the refresh token from the service result into the cookie, and returns
 * the body without it.
 *
 * One function so there is exactly one place where a token could leak into a
 * response, rather than the same three lines repeated at every issuing route.
 */
export function handOff(
  ctx: { setRefreshCookie: (token: string | null) => void },
  pair: { accessToken: string; refreshToken: string; expiresInSeconds: number; sessionId: string },
): SessionBody {
  ctx.setRefreshCookie(pair.refreshToken);
  return {
    accessToken: pair.accessToken,
    expiresInSeconds: pair.expiresInSeconds,
    sessionId: pair.sessionId,
  };
}

/* -------------------------------------------------------------------------- *
 * The native (phone) counterpart — ai/phase-14-mobile.md §4.3.
 * -------------------------------------------------------------------------- */

/**
 * What a successful NATIVE sign-in returns, refresh token INCLUDED.
 *
 * A phone has no httpOnly cookie, so the refresh token has to travel in the
 * response body — and that is exactly why this is a SEPARATE object from
 * `SessionResponse`, written from scratch rather than derived from it. The web
 * defence is that the refresh token is absent from every browser body, enforced
 * by `SessionResponse` being `.strict()`. If this were
 * `SessionResponse.extend({ refreshToken })`, the two would share a definition
 * and a careless edit could couple them; two INDEPENDENT `.strict()` objects
 * cannot cross — adding a field to one leaves the other untouched, so the
 * browser body can never gain a refresh token by accident. That structural
 * separation is the single most important property of this file (§4.3).
 *
 * Reachable only through the `auth.native.*` routes, which a browser client
 * never calls. Channel-binding the token to those routes (so a browser token is
 * refused here and vice versa) is a separate, DB-backed step — see the `native`
 * block in router.ts for why its absence is not a browser-token-exposure path
 * today.
 */
export const NativeSessionResponse = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresInSeconds: z.number().int().positive(),
    sessionId: z.string(),
  })
  .strict();

export interface NativeSessionBody {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly sessionId: string;
}

/**
 * The native counterpart of `handOff`: returns the full pair in the body and
 * sets NO cookie.
 *
 * It deliberately takes no response context. `handOff` needs `setRefreshCookie`
 * because browser delivery IS the cookie; native delivery is body-only, so a
 * function that cannot even reach `setRefreshCookie` is a function that cannot
 * accidentally mix the two mechanisms — the same "make the mistake impossible to
 * express" reasoning the two separate schemas above rest on.
 */
export function nativeSession(pair: {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  sessionId: string;
}): NativeSessionBody {
  return {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresInSeconds: pair.expiresInSeconds,
    sessionId: pair.sessionId,
  };
}
