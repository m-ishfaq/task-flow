import { z } from 'zod';
import { errors } from '@taskflow/contracts';
import { TRPCError } from '@trpc/server';
import { publicRoute, router, selfRoute } from '../trpc/builder.js';
import { SessionResponse, handOff } from './session-response.js';
import { createPasskeyRouter } from './passkey.router.js';
import type { PasskeyDeps } from './passkey.service.js';
import type { IdentityDeps, RequestMeta } from './identity.service.js';
import * as identity from './identity.service.js';

/**
 * Identity routes (PLAN.md §8.1).
 *
 * Almost every route here is `publicRoute` — necessarily, since these are how
 * someone becomes authenticated in the first place. Each carries a written
 * reason, and the manifest makes the whole set reviewable in one place: "what is
 * reachable without credentials" should be a question with a short, deliberate
 * answer.
 *
 * Refresh tokens travel in an httpOnly cookie, set by the Fastify layer, and are
 * read from the context rather than from the request body. A refresh token in a
 * body means JavaScript can read it, which defeats the point of splitting the
 * token pair in two.
 */

const Email = z.string().trim().email().max(254);
const Password = z.string().min(12).max(1024);

export interface IdentityRouterDeps {
  readonly identity: IdentityDeps;
  readonly passkeys: PasskeyDeps;
}

export function createIdentityRouter(deps: IdentityRouterDeps) {
  const meta = (ctx: { ip: string | null; userAgent: string | null }): RequestMeta => ({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return router({
    register: publicRoute({
      publicReason: 'Creating an account cannot require an account.',
    })
      .input(z.object({ email: Email, password: Password }).strict())
      .output(z.object({ status: z.literal('verification_sent') }))
      .mutation(({ input, ctx }) => identity.register(deps.identity, input, meta(ctx))),

    verifyEmail: publicRoute({
      publicReason: 'The link is clicked from an email client, which holds no session.',
    })
      .input(z.object({ token: z.string().min(1).max(200) }).strict())
      .output(z.object({ status: z.literal('verified') }))
      .mutation(({ input }) => identity.verifyEmail(deps.identity, input)),

    login: publicRoute({
      publicReason: 'This is how a session is obtained.',
    })
      .input(z.object({ email: Email, password: Password }).strict())
      .output(SessionResponse)
      .mutation(async ({ input, ctx }) => {
        const pair = await identity.login(deps.identity, input, meta(ctx));
        return handOff(ctx, pair);
      }),

    refresh: publicRoute({
      publicReason:
        'Exchanges the httpOnly refresh cookie. The access token it renews may already have expired, so it cannot itself require one.',
    })
      .output(SessionResponse)
      .mutation(async ({ ctx }) => {
        if (!ctx.refreshToken) throw missingRefreshToken();
        const pair = await identity.refresh(
          deps.identity,
          { refreshToken: ctx.refreshToken },
          meta(ctx),
        );
        return handOff(ctx, pair);
      }),

    logout: publicRoute({
      publicReason:
        'Ending a session must work even when the access token has expired — otherwise "sign out" fails exactly when a user most wants it.',
    })
      .output(z.object({ status: z.literal('ok') }))
      .mutation(async ({ ctx }) => {
        // Cleared unconditionally, including when no cookie arrived. A client
        // that thinks it is signed out must not still be holding a live cookie.
        ctx.setRefreshCookie(null);
        if (!ctx.refreshToken) return { status: 'ok' as const };
        return identity.logout(deps.identity, { refreshToken: ctx.refreshToken });
      }),

    requestPasswordReset: publicRoute({
      publicReason: 'Requested precisely because the caller cannot sign in.',
    })
      .input(z.object({ email: Email }).strict())
      .output(z.object({ status: z.literal('sent') }))
      .mutation(({ input, ctx }) => identity.requestPasswordReset(deps.identity, input, meta(ctx))),

    resetPassword: publicRoute({
      publicReason: 'Possession of the emailed token IS the credential.',
    })
      .input(z.object({ token: z.string().min(1).max(200), password: Password }).strict())
      .output(z.object({ status: z.literal('reset') }))
      .mutation(({ input }) => identity.resetPassword(deps.identity, input)),

    /**
     * The one authenticated route in this router.
     *
     * Step-up is required: signing every other device out is exactly what an
     * attacker with a stolen session would do to lock the real owner out, so it
     * needs a fresh credential proof (§8.1).
     */
    logoutEverywhere: selfRoute({
      selfReason:
        'A user ending their own sessions. No org permission describes it, and a guest must be able to do it.',
      stepUp: true,
    })
      .output(z.object({ revoked: z.number().int().nonnegative() }))
      .mutation(({ ctx }) =>
        identity.logoutEverywhere(deps.identity, { userId: ctx.principal.userId }),
      ),

    /** Nested rather than merged, so the manifest reads `auth.passkeys.*`. */
    passkeys: createPasskeyRouter({ passkeys: deps.passkeys }),
  });
}

function missingRefreshToken(): TRPCError {
  // Deliberately identical to what a client sees for an expired session.
  // Confirming whether a cookie arrived is not information worth giving away.
  return new TRPCError({ code: 'UNAUTHORIZED', cause: errors.tokenExpired() });
}
