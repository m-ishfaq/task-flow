import { z } from 'zod';
import { errors } from '@taskflow/contracts';
import { TRPCError } from '@trpc/server';
import { publicRoute, router, selfRoute } from '../trpc/builder.js';
import {
  NativeSessionResponse,
  SessionResponse,
  handOff,
  nativeSession,
} from './session-response.js';
import { createPasskeyRouter } from './passkey.router.js';
import type { PasskeyDeps } from './passkey.service.js';
import type { IdentityDeps, RequestMeta } from './identity.service.js';
import * as identity from './identity.service.js';
import * as totp from './totp.service.js';
import type { TotpDeps } from './totp.service.js';
import * as oauth from './oauth.service.js';
import type { OAuthDeps } from './oauth.service.js';
import * as sessions from './sessions.service.js';
import * as people from '../people/profile.service.js';

const OAuthProviderSchema = z.enum(['google', 'github']);

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
  /** The unwrapped identity-scoped data key (Phase 12 Wave 2 §3.2, `main.ts`'s boot-time unwrap). */
  readonly identityDataKey: Uint8Array;
  /** OAuth sign-in (Phase 12 Wave 2 §3.3) — everything `OAuthDeps` needs except `identity`, supplied below. */
  readonly oauth: Omit<OAuthDeps, 'identity'>;
}

export function createIdentityRouter(deps: IdentityRouterDeps) {
  const totpDeps: TotpDeps = { identity: deps.identity, identityDataKey: deps.identityDataKey };
  const oauthDeps: OAuthDeps = { ...deps.oauth, identity: deps.identity };
  const meta = (ctx: { ip: string | null; userAgent: string | null }): RequestMeta => ({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return router({
    register: publicRoute({
      publicReason: 'Creating an account cannot require an account.',
    })
      .input(
        z
          .object({
            email: Email,
            password: Password,
            /* REQUIRED, reversing this route's original call.

               The old reasoning was that an account is identified by its email
               and a required name is friction on the one flow that must never
               have any. True in isolation, and it lost to what the product
               actually became: every surface that shows a person — the org
               directory, chat, mentions, the operator console, an audit entry
               read two years later — falls back to an email address when the
               name is missing. That fallback is not neutral. It DISCLOSES the
               address to every colleague who can see the surface, which is a
               worse default than one extra field at signup.

               Trimmed and bounded here; the service still treats a
               whitespace-only value as no name, so the two agree rather than
               relying on this bound alone. */
            name: z.string().trim().min(1).max(80),
          })
          .strict(),
      )
      .output(z.object({ status: z.literal('verification_sent') }))
      .mutation(({ input, ctx }) => identity.register(deps.identity, input, meta(ctx))),

    verifyEmail: publicRoute({
      publicReason: 'The link is clicked from an email client, which holds no session.',
    })
      .input(z.object({ token: z.string().min(1).max(200) }).strict())
      .output(z.object({ status: z.literal('verified') }))
      .mutation(({ input }) => identity.verifyEmail(deps.identity, input)),

    /**
     * The door `login` leaves someone at when their original verification
     * mail never arrived — a lost message, a spam filter, a typo'd inbox
     * rule. Same shape as `requestPasswordReset`: requested precisely
     * because the caller cannot sign in, so it cannot require a session, and
     * it answers identically regardless of whether the address is
     * registered, already verified, or suspended.
     */
    resendVerification: publicRoute({
      publicReason: 'Requested precisely because the caller cannot sign in yet.',
    })
      .input(z.object({ email: Email }).strict())
      .output(z.object({ status: z.literal('sent') }))
      .mutation(({ input, ctx }) => identity.resendVerification(deps.identity, input, meta(ctx))),

    login: publicRoute({
      publicReason: 'This is how a session is obtained.',
    })
      .input(
        z
          .object({
            email: Email,
            password: Password,
            /* Optional, deliberately: an account is identified by its email,
               and refusing a signup over a missing display name would gate
               the one flow that must never have avoidable friction. Bounded
               because it is rendered everywhere a person appears. */
            name: z.string().trim().min(1).max(80).optional(),
          })
          .strict(),
      )
      /* Two shapes (Phase 12 Wave 2 §3.2): the ordinary session, or a signed
         TOTP challenge for an account that has a second factor confirmed.
         `auth.totp.verifyLogin` is the only route that can turn the second
         shape into the first. */
      .output(
        z.discriminatedUnion('kind', [
          SessionResponse.extend({ kind: z.literal('session') }),
          z.object({ kind: z.literal('totp_required'), challengeToken: z.string() }).strict(),
        ]),
      )
      .mutation(async ({ input, ctx }) => {
        const result = await identity.login(deps.identity, input, meta(ctx), 'browser');
        if (result.kind === 'totp_required') return result;
        return { kind: 'session' as const, ...handOff(ctx, result.pair) };
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
          'browser',
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

    /**
     * The NATIVE auth surface (ai/phase-14-mobile.md §4.3).
     *
     * A phone has no httpOnly cookie, so these routes deliver the refresh token
     * in the response BODY (via `nativeSession`) and read it back from the
     * request INPUT — never `ctx.refreshToken` (the cookie) and never
     * `ctx.setRefreshCookie`. Kept a SEPARATE namespace from the browser routes
     * above, with a SEPARATE output schema (`NativeSessionResponse`), so the two
     * delivery mechanisms are structurally unable to cross: the browser body
     * cannot gain a refresh token, and the native body cannot silently lose one.
     * They reuse the SAME services (`identity.login/refresh/logout`,
     * `totp.verifyLogin`) — two paths minting sessions differently is how one
     * ends up without rotation or reuse detection, which this deliberately
     * avoids.
     *
     * NOT YET channel-bound: a refresh token is looked up by hash and its record
     * does not yet record which channel minted it, so a browser-minted token
     * presented HERE would be accepted and rotated into the body. That is not a
     * new browser-token-exposure path — the browser keeps its refresh token in an
     * httpOnly cookie that script cannot read, so an XSS cannot obtain the raw
     * token to present here, and anyone already holding the raw token already
     * holds the account. Binding the token to its channel (a DB column refusing
     * the cross-channel case) is the next step; it is defence-in-depth and schema
     * work on the sessions table, done with the database up so migrate:verify and
     * the real integration suite can prove it.
     */
    native: router({
      login: publicRoute({
        publicReason:
          'The native counterpart of auth.login — how a phone obtains a session. No cookie, so the refresh token is returned in the body.',
      })
        .input(
          z
            .object({
              email: Email,
              password: Password,
              name: z.string().trim().min(1).max(80).optional(),
            })
            .strict(),
        )
        .output(
          z.discriminatedUnion('kind', [
            NativeSessionResponse.extend({ kind: z.literal('session') }),
            z.object({ kind: z.literal('totp_required'), challengeToken: z.string() }).strict(),
          ]),
        )
        .mutation(async ({ input, ctx }) => {
          const result = await identity.login(deps.identity, input, meta(ctx), 'native');
          if (result.kind === 'totp_required') return result;
          return { kind: 'session' as const, ...nativeSession(result.pair) };
        }),

      refresh: publicRoute({
        publicReason:
          'The native refresh: the phone presents its stored refresh token as input (it has no cookie) and receives a rotated pair in the body.',
      })
        .input(z.object({ refreshToken: z.string().min(1).max(1024) }).strict())
        .output(NativeSessionResponse)
        .mutation(async ({ input, ctx }) => {
          const pair = await identity.refresh(
            deps.identity,
            { refreshToken: input.refreshToken },
            meta(ctx),
            'native',
          );
          return nativeSession(pair);
        }),

      logout: publicRoute({
        publicReason:
          'Ending a native session must work with an expired access token, the same as auth.logout — the phone presents its refresh token as input.',
      })
        .input(z.object({ refreshToken: z.string().min(1).max(1024) }).strict())
        .output(z.object({ status: z.literal('ok') }))
        .mutation(({ input }) =>
          identity.logout(deps.identity, { refreshToken: input.refreshToken }),
        ),

      /** The native counterpart of auth.totp.verifyLogin — same challenge, body delivery. */
      totp: router({
        verifyLogin: publicRoute({
          publicReason:
            'The caller has no session yet — the signed challenge token is the proof the password step succeeded. Native delivery is body, not cookie.',
        })
          .input(
            z
              .object({
                challengeToken: z.string(),
                credential: z.discriminatedUnion('kind', [
                  z.object({ kind: z.literal('totp'), code: z.string().min(6).max(10) }).strict(),
                  z
                    .object({ kind: z.literal('recovery'), code: z.string().min(6).max(20) })
                    .strict(),
                ]),
              })
              .strict(),
          )
          .output(NativeSessionResponse)
          .mutation(async ({ input, ctx }) => {
            const pair = await totp.verifyLogin(
              totpDeps,
              { challengeToken: input.challengeToken, credential: input.credential },
              meta(ctx),
              'native',
            );
            return nativeSession(pair);
          }),
      }),
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

    /**
     * The caller's own account, independent of any organization (`/account`).
     *
     * `selfRoute` for the same reason as the retired `updateProfile`: there is
     * no org permission that describes reading your own account, and it must
     * answer with no org selected at all — that is the whole point of the page
     * it backs (`ai/account-page.md`).
     *
     * `auth.updateProfile` is GONE (Phase 11.5, ai/phase-11.5-people.md §3.2):
     * setting a display name now writes people.profiles through
     * `people.profile.update`, the canonical profile record. `me` keeps its
     * four-field identity shape — the session bootstrap needs it — but its
     * displayName now sources from people.profiles via the people module's
     * merged view, so no call site reads the stale identity.users column.
     */
    me: selfRoute({
      selfReason: 'A user reading their own account. Answers with no org selected.',
    })
      .output(
        z
          .object({
            email: z.string(),
            displayName: z.string().nullable(),
            createdAt: z.date(),
            emailVerified: z.boolean(),
          })
          .strict(),
      )
      .query(async ({ ctx }) => {
        const view = await people.getProfile(ctx.principal.userId);
        return {
          email: view.email,
          displayName: view.displayName,
          createdAt: view.createdAt,
          emailVerified: view.emailVerified,
        };
      }),

    /**
     * Device/session inventory (Phase 12 Wave 2 §3.4) — your own active
     * sessions, built from data that already exists rather than a new
     * device concept. `selfRoute` for the same reason `auth.me` is: there
     * is no org permission that describes listing your own sign-ins, and
     * it must answer with no org selected. `revoke` is `stepUp: true` —
     * the single-device version of `logoutEverywhere`'s own protection.
     */
    sessions: router({
      list: selfRoute({
        selfReason:
          'A user reading their own active sessions — §3.4’s device inventory. No org permission describes it.',
      })
        .output(
          z
            .object({
              sessions: z
                .array(
                  z
                    .object({
                      id: z.string(),
                      label: z.string().nullable(),
                      ip: z.string().nullable(),
                      authenticatedAt: z.date(),
                      lastSeenAt: z.date(),
                      isCurrent: z.boolean(),
                      country: z.string().nullable(),
                      flagged: z.boolean(),
                    })
                    .strict(),
                )
                .readonly(),
              pushDeviceCount: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .query(({ ctx }) =>
          sessions.list(deps.identity, ctx.principal.userId, ctx.principal.sessionId),
        ),

      revoke: selfRoute({
        selfReason:
          'A user signing one of their own devices out — the single-session logout (§3.4).',
        stepUp: true,
      })
        .input(z.object({ sessionId: z.string().uuid() }).strict())
        .output(z.object({ status: z.literal('revoked') }).strict())
        .mutation(({ input, ctx }) =>
          sessions.revoke(deps.identity, ctx.principal.userId, input.sessionId, meta(ctx)),
        ),
    }),

    /** Nested rather than merged, so the manifest reads `auth.passkeys.*`. */
    passkeys: createPasskeyRouter({ passkeys: deps.passkeys }),

    /**
     * TOTP as a second factor (Phase 12 Wave 2 §3.2).
     *
     * Every enrollment-lifecycle route is `selfRoute` with `stepUp: true` —
     * adding or removing a way into your own account is exactly the kind of
     * credential-adjacent change §8.1's step-up list already covers.
     * `verifyLogin` is the one exception: it is `publicRoute`, because the
     * caller has no session yet — the signed challenge token IS its proof
     * the password step already succeeded.
     */
    totp: router({
      /**
       * Whether this account already has a confirmed factor — no `stepUp`,
       * the same "cheap, no-step-up probe" reasoning `platformAdmin.self.check`
       * already uses (`shell.tsx`'s own comment on why): the account page
       * needs this on every load just to decide which button to render, and
       * gating a read behind a fresh credential would make the settings page
       * itself demand one before it can even show its own state.
       */
      status: selfRoute({
        selfReason: 'Whether your own account has a confirmed second factor.',
      })
        .output(z.object({ enabled: z.boolean() }))
        .query(({ ctx }) => totp.status({ userId: ctx.principal.userId })),

      startEnrollment: selfRoute({
        selfReason: 'Enrolling a second factor on your own account.',
        stepUp: true,
      })
        .output(z.object({ secret: z.string(), otpauthUrl: z.string() }))
        .mutation(async ({ ctx }) => {
          const profile = await people.getProfile(ctx.principal.userId);
          return totp.startEnrollment(totpDeps, {
            userId: ctx.principal.userId,
            email: profile.email,
          });
        }),

      confirmEnrollment: selfRoute({
        selfReason: 'Proving control of the enrolled authenticator app.',
        stepUp: true,
      })
        .input(z.object({ code: z.string().min(6).max(10) }).strict())
        .output(z.object({ recoveryCodes: z.array(z.string()).readonly() }))
        .mutation(({ input, ctx }) =>
          totp.confirmEnrollment(totpDeps, { userId: ctx.principal.userId, code: input.code }),
        ),

      disable: selfRoute({
        selfReason: 'Removing a second factor from your own account.',
        stepUp: true,
      })
        .output(z.object({ status: z.literal('disabled') }))
        .mutation(async ({ ctx }) => {
          await totp.disable(totpDeps, { userId: ctx.principal.userId });
          return { status: 'disabled' as const };
        }),

      verifyLogin: publicRoute({
        publicReason:
          'The caller has no session yet — the signed challenge token is the proof the password step already succeeded.',
      })
        .input(
          z
            .object({
              challengeToken: z.string(),
              credential: z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('totp'), code: z.string().min(6).max(10) }).strict(),
                z.object({ kind: z.literal('recovery'), code: z.string().min(6).max(20) }).strict(),
              ]),
            })
            .strict(),
        )
        .output(SessionResponse)
        .mutation(async ({ input, ctx }) => {
          const pair = await totp.verifyLogin(
            totpDeps,
            { challengeToken: input.challengeToken, credential: input.credential },
            meta(ctx),
            'browser',
          );
          return handOff(ctx, pair);
        }),
    }),

    /**
     * OAuth sign-in (Phase 12 Wave 2 §3.3).
     *
     * `start` and `callback` are `publicRoute` even for the "link a new
     * provider to my account" path — the redirect round trip to Google or
     * GitHub is a full browser navigation away from the app, which loses the
     * in-memory access token (`lib/session.ts`) the same as a page reload
     * would. `callback` is reached with no session either way; what makes the
     * linking path different is the signed `linkUserId` carried inside
     * `state`, set by `start` while a session DID still exist.
     */
    oauth: router({
      /**
       * Which providers this server has credentials for — read BEFORE any
       * sign-in attempt, from the login page, which has no session to gate a
       * `selfRoute` query behind. An unconfigured provider's button simply
       * does not render rather than the app failing to boot (§3.3); this is
       * how the browser learns which buttons that is.
       */
      providers: publicRoute({
        publicReason: 'Read from the login page, before any session exists.',
      })
        .output(z.object({ google: z.boolean(), github: z.boolean() }))
        .query(() => ({
          google: 'google' in oauthDeps.providers,
          github: 'github' in oauthDeps.providers,
        })),

      start: publicRoute({
        publicReason: 'This is how a session is obtained — the same reason auth.login is public.',
      })
        .input(z.object({ provider: OAuthProviderSchema }).strict())
        .output(z.object({ authorizationUrl: z.string() }))
        .mutation(({ input }) => oauth.start(oauthDeps, { provider: input.provider })),

      startLink: selfRoute({
        selfReason: 'Linking a new provider to your own account.',
        stepUp: true,
      })
        .input(z.object({ provider: OAuthProviderSchema }).strict())
        .output(z.object({ authorizationUrl: z.string() }))
        .mutation(({ input, ctx }) =>
          oauth.start(oauthDeps, { provider: input.provider, linkUserId: ctx.principal.userId }),
        ),

      callback: publicRoute({
        publicReason:
          'Reached via a browser redirect from the provider, with no session — the signed state token carries whatever context the flow needs.',
      })
        .input(
          z.object({ provider: OAuthProviderSchema, code: z.string(), state: z.string() }).strict(),
        )
        .output(
          z.discriminatedUnion('kind', [
            SessionResponse.extend({ kind: z.literal('session') }),
            z.object({ kind: z.literal('linked'), provider: OAuthProviderSchema }).strict(),
          ]),
        )
        .mutation(async ({ input, ctx }) => {
          const result = await oauth.callback(oauthDeps, input, meta(ctx));
          if (result.kind === 'linked') return result;
          return { kind: 'session' as const, ...handOff(ctx, result.pair) };
        }),

      listConnected: selfRoute({
        selfReason: 'Reading your own connected-accounts list.',
      })
        .output(
          z
            .array(
              z.object({ provider: OAuthProviderSchema, email: z.string(), linkedAt: z.date() }),
            )
            .readonly(),
        )
        .query(({ ctx }) => oauth.listConnected(ctx.principal.userId)),

      unlink: selfRoute({
        selfReason: 'Removing a sign-in method from your own account.',
        stepUp: true,
      })
        .input(z.object({ provider: OAuthProviderSchema }).strict())
        .output(z.object({ status: z.literal('unlinked') }))
        .mutation(({ input, ctx }) =>
          oauth.unlink(oauthDeps, { userId: ctx.principal.userId, provider: input.provider }),
        ),
    }),
  });
}

function missingRefreshToken(): TRPCError {
  // Deliberately identical to what a client sees for an expired session.
  // Confirming whether a cookie arrived is not information worth giving away.
  return new TRPCError({ code: 'UNAUTHORIZED', cause: errors.tokenExpired() });
}
