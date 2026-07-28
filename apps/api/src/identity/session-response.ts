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
