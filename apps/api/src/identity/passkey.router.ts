import { z } from 'zod';
import { UuidSchema } from '@taskflow/contracts';
import { publicRoute, router, selfRoute } from '../trpc/builder.js';
import * as passkeys from './passkey.service.js';
import { SessionResponse, handOff } from './session-response.js';
import type { PasskeyDeps } from './passkey.service.js';
import type { RequestMeta } from './identity.service.js';

/**
 * Passkey routes (PLAN.md §8.1).
 *
 * The access split is the thing to read here. Enrollment is `selfRoute` — you
 * add a passkey to an account you are already signed in to, and the user comes
 * from the verified token rather than from the request. Sign-in is public,
 * necessarily, and takes no identifier at all: a discoverable credential means
 * the ceremony never has to ask who you are, so the login surface has nothing to
 * enumerate.
 */

/**
 * Base64URL, bounded.
 *
 * The library parses these; the length cap is here so a megabyte of base64 is
 * rejected at the boundary rather than decoded first. The alphabet is checked
 * because a value that is not base64url cannot be a valid ceremony field, and
 * the earliest cheap rejection is the best one.
 */
const Base64Url = z
  .string()
  .min(1)
  .max(8_192)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

/**
 * Extension results are an open map by specification.
 *
 * The one place `.strict()` is wrong: the set of WebAuthn extensions grows, and
 * rejecting an unknown one would break a browser that added a benign hint.
 * Nothing here is read or trusted — the library ignores what it does not know.
 */
const ClientExtensionResults = z.record(z.unknown());

const RegistrationResponse = z
  .object({
    id: Base64Url,
    rawId: Base64Url,
    response: z
      .object({
        clientDataJSON: Base64Url,
        attestationObject: Base64Url,
        transports: z.array(z.string().max(32)).max(8).optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: Base64Url.optional(),
        authenticatorData: Base64Url.optional(),
      })
      .strict(),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    clientExtensionResults: ClientExtensionResults,
    type: z.literal('public-key'),
  })
  .strict();

export const AuthenticationResponse = z
  .object({
    id: Base64Url,
    rawId: Base64Url,
    response: z
      .object({
        clientDataJSON: Base64Url,
        authenticatorData: Base64Url,
        signature: Base64Url,
        userHandle: Base64Url.optional(),
      })
      .strict(),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
    clientExtensionResults: ClientExtensionResults,
    type: z.literal('public-key'),
  })
  .strict();

/** A user-chosen label. Stored and rendered as text; never as HTML (§8.7). */
const PasskeyName = z.string().trim().min(1).max(64);

/* Ids are validated with `UuidSchema` from @taskflow/contracts rather than
   `z.string().uuid()`. Zod's built-in rejects UUIDv7 as "not a valid UUID" —
   it predates the version — and every id this system issues is a v7, so the
   built-in check refuses every real request while passing every test that
   invents an id. */

export interface PasskeyRouterDeps {
  readonly passkeys: PasskeyDeps;
}

export function createPasskeyRouter(deps: PasskeyRouterDeps) {
  const meta = (ctx: { ip: string | null; userAgent: string | null }): RequestMeta => ({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return router({
    startRegistration: selfRoute({
      selfReason:
        'A user enrolling an authenticator on their own account. No org permission describes it, and a guest must be able to do it.',
    })
      // The options object is the library's, and its shape follows the WebAuthn
      // specification rather than ours. Passed through unmodified.
      .output(z.unknown())
      .mutation(({ ctx }) =>
        passkeys.startRegistration(deps.passkeys, { userId: ctx.principal.userId }),
      ),

    finishRegistration: selfRoute({
      selfReason: 'Completes the enrollment the same user started.',
    })
      .input(z.object({ response: RegistrationResponse, name: PasskeyName.optional() }).strict())
      .output(z.object({ credentialId: z.string() }).strict())
      .mutation(({ ctx, input }) =>
        passkeys.finishRegistration(deps.passkeys, {
          userId: ctx.principal.userId,
          // The Zod shape above is structurally the library's type; the cast is
          // the boundary between "validated" and "typed as the library wants".
          response: input.response as never,
          ...(input.name === undefined ? {} : { name: input.name }),
        }),
      ),

    startAuthentication: publicRoute({
      publicReason: 'This is how a session is obtained with a passkey.',
    })
      .output(z.unknown())
      .mutation(() => passkeys.startAuthentication(deps.passkeys)),

    finishAuthentication: publicRoute({
      publicReason: 'The assertion IS the credential — there is no session yet.',
    })
      .input(z.object({ response: AuthenticationResponse }).strict())
      .output(SessionResponse)
      .mutation(async ({ ctx, input }) => {
        const pair = await passkeys.finishAuthentication(
          deps.passkeys,
          { response: input.response as never },
          meta(ctx),
          'browser',
        );
        return handOff(ctx, pair);
      }),

    list: selfRoute({ selfReason: 'A user listing their own authenticators.' })
      .output(
        z.array(
          z
            .object({
              id: z.string(),
              name: z.string().nullable(),
              deviceType: z.string(),
              backedUp: z.boolean(),
              createdAt: z.date(),
              lastUsedAt: z.date().nullable(),
            })
            .strict(),
        ),
      )
      .query(({ ctx }) => passkeys.listPasskeys(ctx.principal.userId)),

    rename: selfRoute({ selfReason: 'A user labelling their own authenticator.' })
      .input(z.object({ id: UuidSchema, name: PasskeyName }).strict())
      .output(z.object({ status: z.literal('renamed') }).strict())
      .mutation(({ ctx, input }) =>
        passkeys.renamePasskey(deps.passkeys, {
          userId: ctx.principal.userId,
          id: input.id,
          name: input.name,
        }),
      ),

    /**
     * Step-up required.
     *
     * Removing an authenticator is precisely what someone with a stolen session
     * would do to keep the real owner out, and unlike a password change it
     * leaves no trace the owner would notice until they next try to sign in
     * (§8.1).
     */
    remove: selfRoute({
      selfReason: 'A user removing their own authenticator.',
      stepUp: true,
    })
      .input(z.object({ id: UuidSchema }).strict())
      .output(z.object({ status: z.literal('deleted') }).strict())
      .mutation(({ ctx, input }) =>
        passkeys.deletePasskey(deps.passkeys, { userId: ctx.principal.userId, id: input.id }),
      ),
  });
}
