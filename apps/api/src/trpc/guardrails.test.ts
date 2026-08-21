import { describe, expect, it } from 'vitest';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { createCallerFactory, publicRoute, route, router, selfRoute } from './builder.js';
import {
  UndeclaredRouteError,
  accessOf,
  assertRoutesDeclarePermissions,
  protectedRoutes,
  publicRoutes,
  routeManifest,
  selfRoutes,
} from './manifest.js';
import type { AuthenticatedPrincipal, OrgMembership, RequestContext } from './context.js';
import { testAppRouter, testContext, testPrincipal } from '../testing/fixtures.js';

/**
 * GUARDRAIL 4 — fail-closed routes (PLAN.md §2.1).
 *
 * The type-level half cannot be asserted at runtime: `route()` takes its
 * permission as a required argument, so omitting it does not compile and there
 * is nothing to execute. What IS testable is the boot assertion — the half that
 * catches a raw `t.procedure` reaching the router by some other path.
 */

const { router: appRouter } = testAppRouter();

function subject(role: OrgMembership['role'], ageMs = 0): AuthenticatedPrincipal {
  return testPrincipal(role, { authenticatedAt: new Date(Date.now() - ageMs) });
}

function context(principal: AuthenticatedPrincipal | null): RequestContext {
  return testContext({ principal });
}

const testRouter = router({
  cards: router({
    list: route({ permission: 'card:read' })
      .output(z.array(z.string()))
      .query(() => ['card-1']),
    remove: route({ permission: 'card:delete' })
      .input(z.object({ cardId: z.string() }))
      .mutation(() => ({ ok: true })),
  }),
  org: router({
    destroy: route({ permission: 'org:delete', stepUp: true }).mutation(() => ({ ok: true })),
  }),
  auth: router({
    login: publicRoute({ publicReason: 'Unauthenticated by definition — this is how you sign in.' })
      .input(z.object({ email: z.string() }))
      .mutation(() => ({ ok: true })),
  }),
});

const callerFactory = createCallerFactory(testRouter);

describe('manifest', () => {
  it('enumerates every route with its declaration', () => {
    const entries = routeManifest(testRouter);
    const paths = entries.map((entry) => entry.path).sort();

    expect(paths).toEqual(['auth.login', 'cards.list', 'cards.remove', 'org.destroy']);
    expect(entries.find((entry) => entry.path === 'cards.list')?.permission).toBe('card:read');
    expect(entries.find((entry) => entry.path === 'cards.list')?.kind).toBe('query');
    expect(entries.find((entry) => entry.path === 'cards.remove')?.kind).toBe('mutation');
  });

  it('separates "declared public" from "requires a permission"', () => {
    const entries = routeManifest(testRouter);

    expect(publicRoutes(entries).map((entry) => entry.path)).toEqual(['auth.login']);
    expect(
      protectedRoutes(entries)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(['cards.list', 'cards.remove', 'org.destroy']);
  });

  it('carries the reason a route is public', () => {
    // So "what is reachable without authentication, and why" is answerable
    // without reading every router file.
    const entries = routeManifest(testRouter);
    expect(entries.find((entry) => entry.path === 'auth.login')?.publicReason).toMatch(/sign in/);
  });

  it('records the step-up requirement', () => {
    const entries = routeManifest(testRouter);
    expect(entries.find((entry) => entry.path === 'org.destroy')?.stepUp).toBe(true);
    expect(entries.find((entry) => entry.path === 'cards.list')?.stepUp).toBe(false);
  });
});

describe('boot assertion', () => {
  it('accepts a router where every route declares a permission', () => {
    expect(() => assertRoutesDeclarePermissions(testRouter)).not.toThrow();
  });

  it('accepts the real application router', () => {
    // The assertion that actually protects the product. If this fails, the
    // server will refuse to start — which is the intended behaviour, and the
    // reason this test exists is to find out at test time rather than at deploy.
    expect(() => assertRoutesDeclarePermissions(appRouter)).not.toThrow();
  });

  it('refuses a router containing a bare procedure', () => {
    // The exact bypass the boot half exists for: someone imports initTRPC
    // directly instead of using the builder. The type system cannot stop that,
    // and the endpoint would answer 200 to anyone.
    const bare = initTRPC.context<RequestContext>().create();
    const leaky = router({ secrets: bare.procedure.query(() => 'everything') });

    expect(() => assertRoutesDeclarePermissions(leaky)).toThrow(UndeclaredRouteError);
  });

  it('names the offending routes in the error', () => {
    const bare = initTRPC.context<RequestContext>().create();
    const leaky = router({ admin: router({ dump: bare.procedure.query(() => 'data') }) });

    expect(() => assertRoutesDeclarePermissions(leaky)).toThrow(/admin\.dump/);
  });

  it('treats a permission outside the catalog as no declaration at all', () => {
    // A typo'd permission is worse than a missing one: if it collides with a
    // real permission it grants the wrong thing, and if it does not, the route
    // denies everyone and looks like a broken feature.
    const bare = initTRPC.context<RequestContext>().meta<{ permission: string }>().create();
    const typo = router({
      cards: router({
        edit: bare.procedure.meta({ permission: 'card:updat' }).mutation(() => ({ ok: true })),
      }),
    });

    expect(() => assertRoutesDeclarePermissions(typo)).toThrow(UndeclaredRouteError);
  });
});

describe('route authorization', () => {
  it('rejects an unauthenticated caller', async () => {
    const caller = callerFactory(context(null));
    await expect(caller.cards.list()).rejects.toThrow();
  });

  it('allows a caller whose role grants the permission', async () => {
    const caller = callerFactory(context(subject('member')));
    await expect(caller.cards.list()).resolves.toEqual(['card-1']);
  });

  it('denies a caller whose role does not', async () => {
    const caller = callerFactory(context(subject('guest')));
    await expect(caller.cards.list()).rejects.toThrow();
  });

  it('denies org deletion to an admin', async () => {
    const caller = callerFactory(context(subject('admin')));
    await expect(caller.org.destroy()).rejects.toThrow();
  });

  it('lets a public route through with no credentials', async () => {
    const caller = callerFactory(context(null));
    await expect(caller.auth.login({ email: 'a@b.test' })).resolves.toEqual({ ok: true });
  });

  it('denies an authenticated caller who belongs to no organization', async () => {
    // A real state, not a broken one: someone who signed up and joined nothing.
    // It must not answer 401 — a client holding a perfectly valid token would
    // refresh, get another perfectly valid token, and loop forever.
    const caller = callerFactory(context(testPrincipal('owner', { org: null })));

    await expect(caller.cards.list()).rejects.toThrow(/not a member/i);
  });
});

describe('step-up re-authentication', () => {
  it('allows a recently authenticated owner', async () => {
    const caller = callerFactory(context(subject('owner', 60_000)));
    await expect(caller.org.destroy()).resolves.toEqual({ ok: true });
  });

  it('rejects an owner whose session is old', async () => {
    // §8.1: destroying a workspace requires proving possession of a credential
    // again, so a stolen session alone is not enough for the irreversible
    // actions.
    const caller = callerFactory(context(subject('owner', 10 * 60_000)));
    await expect(caller.org.destroy()).rejects.toThrow();
  });

  it('does not require step-up for ordinary routes', async () => {
    const caller = callerFactory(context(subject('member', 10 * 60_000)));
    await expect(caller.cards.list()).resolves.toEqual(['card-1']);
  });
});

describe('error envelope', () => {
  it('does not leak the internal reason for a denial', async () => {
    // The decision trace goes to the audit log, never to the client — telling a
    // caller which rule denied them is a map of the permission model.
    const caller = callerFactory(context(subject('guest')));

    const message = await caller.cards.list().then(
      () => 'no error',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(message).not.toMatch(/role=/);
    expect(message).not.toMatch(/tuple/);
  });
});

describe('publicRoute', () => {
  it('rejects an empty reason', () => {
    // An empty string satisfies the type while defeating the mechanism, which is
    // that someone has to write the justification into the diff.
    expect(() => publicRoute({ publicReason: '   ' })).toThrow();
  });
});

describe('access kinds', () => {
  const selfRouter = router({
    me: router({
      logoutEverywhere: selfRoute({
        selfReason: 'A user ending their own sessions. No org permission describes it.',
      }).mutation(() => ({ revoked: 0 })),
    }),
  });

  it('classifies a self route as neither public nor permission-gated', () => {
    // The distinction that matters: `permission` is null for both public and
    // self routes, and calling a self route public would overstate the
    // unauthenticated surface in the one document that reports it.
    const entries = routeManifest(selfRouter);

    expect(accessOf(entries[0]!)).toBe('self');
    expect(publicRoutes(entries)).toEqual([]);
    expect(protectedRoutes(entries)).toEqual([]);
    expect(selfRoutes(entries).map((entry) => entry.path)).toEqual(['me.logoutEverywhere']);
  });

  it('still counts as declared, so the boot assertion accepts it', () => {
    expect(() => assertRoutesDeclarePermissions(selfRouter)).not.toThrow();
  });

  it('requires authentication', async () => {
    const caller = createCallerFactory(selfRouter)(context(null));
    await expect(caller.me.logoutEverywhere()).rejects.toThrow();
  });

  it('admits any role, including a guest', async () => {
    // A guest holds no role-based permissions by design, and must still be able
    // to end their own sessions.
    const caller = createCallerFactory(selfRouter)(context(subject('guest')));
    await expect(caller.me.logoutEverywhere()).resolves.toEqual({ revoked: 0 });
  });

  it('admits a caller with no organization at all', async () => {
    // The distinction `requireOrg` exists for. Signing your own devices out is
    // not an org capability, so it must work for someone who has joined no org —
    // which today is every authenticated caller, since memberships arrive in
    // Phase 2.
    const caller = createCallerFactory(selfRouter)(context(testPrincipal('guest', { org: null })));

    await expect(caller.me.logoutEverywhere()).resolves.toEqual({ revoked: 0 });
  });

  it('rejects an empty reason', () => {
    expect(() => selfRoute({ selfReason: '  ' })).toThrow();
  });
});

describe('the real application router', () => {
  it('exposes only the intended unauthenticated surface', () => {
    // This list is the answer to "what can anyone reach". It is asserted rather
    // than described so that adding a public route is a deliberate edit here.
    const paths = publicRoutes(routeManifest(appRouter))
      .map((entry) => entry.path)
      .sort();

    expect(paths).toEqual([
      'auth.login',
      'auth.logout',
      /* The NATIVE auth surface (ai/phase-14-mobile.md §4.3). Public for the
         same reason their browser counterparts are — this is how a phone
         obtains, renews, and ends a session — and a deliberate expansion of the
         unauthenticated surface, reviewed here. They differ from the browser
         routes only in delivery: a phone has no httpOnly cookie, so the refresh
         token travels in the body via a SEPARATE schema (`NativeSessionResponse`)
         and is read back from the request input, never `ctx.refreshToken`. See
         the `native` block in identity/router.ts. */
      'auth.native.login',
      'auth.native.logout',
      /* The native counterpart of the OAuth block below (ai/phase-14-mobile.md
         §4.4) — public for the identical reason, minted through a system
         browser session rather than a page redirect. `providers` answers
         which providers have NATIVE credentials configured, a separate
         question from the browser `auth.oauth.providers` below it, since
         `nativeProviders` is its own map on the server. */
      'auth.native.oauth.callback',
      'auth.native.oauth.providers',
      'auth.native.oauth.start',
      /* The native counterpart of `auth.passkeys.finishAuthentication`
         (ai/phase-14-mobile.md §4.4) — public for the identical reason: the
         assertion IS the credential, there is no session yet on either
         channel. `startAuthentication` needs no counterpart at all (no
         session minted, nothing channel-specific in ceremony options), and
         enrollment is `selfRoute` already — only session issuance differs
         by channel. */
      'auth.native.passkeys.finishAuthentication',
      'auth.native.refresh',
      'auth.native.totp.verifyLogin',
      /* OAuth sign-in (Phase 12 Wave 2 §3.3). Both public for the same reason
         auth.login is — `callback` is reached via a browser redirect with no
         session either way, whether it turns out to sign someone in or to
         link a provider to an account they were already signed into (the
         signed `state` token, not a header, carries that distinction). */
      'auth.oauth.callback',
      /* Read from the login page before any session exists, to decide which
         provider buttons to render at all. */
      'auth.oauth.providers',
      'auth.oauth.start',
      /* Passkey sign-in. Public for the same reason password login is — it is
         how a session is obtained — and it is the ONE flow here that cannot be
         used to enumerate accounts, because the ceremony takes no identifier. */
      'auth.passkeys.finishAuthentication',
      'auth.passkeys.startAuthentication',
      'auth.refresh',
      'auth.register',
      'auth.requestPasswordReset',
      /* The way out of EMAIL_NOT_VERIFIED (§8.1 follow-up) — requested
         precisely because the caller cannot sign in yet, same as
         auth.requestPasswordReset immediately above. */
      'auth.resendVerification',
      'auth.resetPassword',
      /* Phase 12 Wave 2 §3.2. The caller has no session yet at this point — the
         signed challenge token from `auth.login` IS the proof the password
         step already succeeded, so this cannot itself require authentication. */
      'auth.totp.verifyLogin',
      'auth.verifyEmail',
      /* Connector callback (Phase 10 Wave 4 slice 2, §7) — reached via a
         browser redirect from Slack/GitHub with no session; the signed state
         token minted by `integration.begin` carries the org and user, the
         `linkUserId` trust model applied to an org surface. */
      'automation.integration.complete',
      /* Publish-to-public (ai/phase-6-docs.md §3.9, Wave 4) — the one route
         whose entire purpose is being reachable with no session, gated
         entirely by the target page's own `published_version_id` rather
         than by anything this layer checks. See public.service.ts. */
      'docs.public.getPage',
      'health.live',
      /* Platform-wide branding (migration 0073) — the login page and the
         public Docs page both need the product name/logo/favicon/palette
         before any session exists, the same reasoning docs.public.getPage
         above already established for this list. */
      'platformAdmin.branding.public',
    ]);
  });

  it('keeps passkey enrollment and management behind authentication', () => {
    /* The other half of the same review. Enrolling an authenticator adds a way
       into an account, so it must never appear in the list above — and asserting
       the self-route set means moving one across is a visible edit here rather
       than a quiet change in a router file. */
    const paths = selfRoutes(routeManifest(appRouter))
      .map((entry) => entry.path)
      .sort();

    expect(paths).toEqual([
      'auth.logoutEverywhere',
      /* The one account-level read that answers with no org selected
         (`ai/account-page.md`). Self-scoped for the same reason the retired
         `updateProfile` was: there is no org permission that describes reading
         your own account, and it must work before any org is chosen — that is
         the entire reason `/account` exists as a route independent of
         `/settings`. Not step-up: reading is not credential-adjacent. */
      'auth.me',
      /* Device binding (Phase 14 Wave 1b §4.5) — binding a session to its own
         device key. `selfRoute`, not `publicRoute`: `sessions.
         registerDeviceKey` reads `sessionId` off the caller's own verified
         access token rather than trusting anything the client names, so the
         caller must already be authenticated to reach it at all. */
      'auth.native.deviceKey.register',
      /* Native connected-accounts linking (Phase 14 §4.4) — the mobile
         counterpart of `auth.oauth.startLink` just below, added once the
         mobile account screen needed it (this route did not exist when
         Wave 1b's own comment on the native oauth router named linking
         out of scope on purpose). `stepUp: true` for the identical reason
         the browser route carries it: adding a new way into the account
         is as credential-adjacent from a phone as it is from a browser.
         `auth.native.oauth.start`/`callback` are NOT here: `start` is
         public (there is no session yet to require), and `callback`'s
         SESSION branch is public for the same reason while its LINKED
         branch is reached mid-flow with the state token already proving
         who is linking, not a fresh authenticated request this manifest
         would see as self-scoped. */
      'auth.native.oauth.startLink',
      /* Connected-accounts management (Phase 12 Wave 2 §3.3) — reading and
         changing your own account's sign-in methods. `startLink`/`unlink`
         are step-up: adding or removing a way in is credential-adjacent the
         same as the TOTP and passkey lifecycle routes are. */
      'auth.oauth.listConnected',
      'auth.oauth.startLink',
      'auth.oauth.unlink',
      'auth.passkeys.finishRegistration',
      'auth.passkeys.list',
      'auth.passkeys.remove',
      'auth.passkeys.rename',
      'auth.passkeys.startRegistration',
      /* Device/session inventory (Phase 12 Wave 2 §3.4) — your own active
         sessions. `selfRoute` for the same reason `auth.me` is (no org
         permission describes listing your own sign-ins, and /account
         answers with no org selected). `revoke` is `stepUp: true`, the
         single-device version of `logoutEverywhere`'s own protection. */
      'auth.sessions.list',
      'auth.sessions.revoke',
      /* TOTP enrollment lifecycle (Phase 12 Wave 2 §3.2) — adding or removing a
         second factor on your own account, `stepUp: true` on all three.
         `auth.totp.verifyLogin` is NOT here: it is the public route above,
         reached with no session yet. `status` is the one read in the group —
         no `stepUp`, the same "cheap no-step-up probe" reasoning
         `platformAdmin.self.check` uses: the account page needs it on every
         load just to decide which button to render. */
      'auth.totp.confirmEnrollment',
      'auth.totp.disable',
      'auth.totp.startEnrollment',
      'auth.totp.status',
      /* The resolved feature-flag snapshot (Phase 12 Wave 1 §3.8) — the
         client bootstrap payload, and the consumer that makes the override
         store real. Self-scoped rather than public because the flags are a
         product-surface view for logged-in users only, and self-scoped
         rather than platformRoute because non-operators must see it too;
         the values are non-sensitive (feature visibility, never a security
         control). */
      'flags.snapshot',
      /* Notification preferences (Phase 9) — global per user, not per org
         (`identity.notification_prefs`; see that table's own comment in
         `packages/db/src/schema/identity.ts`), so `selfRoute` for the same
         reason `auth.me`/`auth.updateProfile` are. `listMine`/`markRead`/etc.
         are deliberately NOT here — they read `platform.notifications`,
         which IS per-org, through `memberRoute` instead; see
         `trpc/builder.ts`'s own comment on that builder. */
      'notifications.prefs.list',
      'notifications.prefs.set',
      /* Web-push subscriptions (Phase 9 Wave 2, §3.7) — a device belongs to a
         PERSON, not an org, for the identical reason the prefs do: `selfRoute`
         all four. `vapidPublicKey` is self-scoped rather than public because
         the ceremony only ever runs from the account page, after sign-in. */
      'notifications.push.list',
      'notifications.push.register',
      'notifications.push.unregister',
      'notifications.push.vapidPublicKey',
      /* People (Phase 11.5) — your own profile, org-independent and answering
         with no org selected (the account page). `auth.updateProfile` is GONE:
         display names now write people.profiles through `people.profile.update`
         (ai/phase-11.5-people.md §3.2). Same self-scoped reasoning as the
         routes above — no ORG permission describes managing your own fields,
         and a guest must still be able to. `people.profile.update` also takes
         no user id in its input: the subject is always the caller. */
      /* Self-serve DSAR export (Phase 12 Wave 2 §3.6) — the caller's own
         account data, spanning every org they belong to, so no org permission
         can describe it and it must answer with no org selected. A plain read
         of your own data: no step-up, the same trust level as profile.get. */
      'people.profile.exportMine',
      'people.profile.get',
      'people.profile.update',
      /* The operator flag check (Phase 12 Wave 1 §3.2) — deliberately
         selfRoute, not platformRoute: every logged-in user calls it on every
         page load so the account menu can decide whether to render a link to
         /platform-admin, and forcing a step-up re-authentication on all of
         them just to hear "no" would be a real, avoidable dead-end. The
         answer ({ isOperator }) is not sensitive on its own. */
      'platformAdmin.self.check',
      /* A ringtone (Phase 13, ai/phase-13-webrtc.md §7) — global per user like
         the notification prefs above, and for the same reason: no ORG
         permission describes "how my own phone rings", and it has to be
         readable/writable before any call this person is on has a channel to
         resolve permissions against. */
      'rtc.prefs.get',
      'rtc.prefs.set',
      /* The two tenancy routes a caller with NO membership must still reach.
         Neither can be permission-bearing without a contradiction: a user who
         belongs to no organization has no role, so requiring an org permission
         would make a first organization impossible to create, and an
         `org:create` permission every role held would mean nothing.

         What bounds them instead is data, not policy. `orgs.create` makes the
         caller owner of a brand-new tenant containing only themselves;
         `orgs.list` returns their own memberships, limited by the SELECT-only
         RLS policies on app.user_id rather than by a WHERE clause. */
      'tenancy.orgs.create',
      'tenancy.orgs.list',
    ]);
  });

  it('requires step-up to remove an authenticator', () => {
    // Exactly what someone with a stolen session would do to lock the owner
    // out, and unlike a password change it leaves nothing the owner notices
    // until they next try to sign in (§8.1).
    const entries = routeManifest(appRouter);
    expect(entries.find((entry) => entry.path === 'auth.passkeys.remove')?.stepUp).toBe(true);
  });

  it('requires step-up to link a new native OAuth provider', () => {
    // The native counterpart of the browser assertion below — a stolen
    // session linking a second, attacker-controlled sign-in method is the
    // same class of attack `auth.passkeys.remove` and `auth.oauth.startLink`
    // both guard against, and the app credentials/redirect being NATIVE
    // rather than browser is not a reason this control could be weaker.
    const entries = routeManifest(appRouter);
    expect(entries.find((entry) => entry.path === 'auth.native.oauth.startLink')?.stepUp).toBe(
      true,
    );
  });

  it('requires step-up to link or unlink a browser OAuth provider', () => {
    const entries = routeManifest(appRouter);
    expect(entries.find((entry) => entry.path === 'auth.oauth.startLink')?.stepUp).toBe(true);
    expect(entries.find((entry) => entry.path === 'auth.oauth.unlink')?.stepUp).toBe(true);
  });

  it('gives every public route a written justification', () => {
    for (const entry of publicRoutes(routeManifest(appRouter))) {
      expect(entry.publicReason ?? '', entry.path).not.toBe('');
    }
  });

  it('requires step-up for signing every device out', () => {
    const entries = routeManifest(appRouter);
    const route = entries.find((entry) => entry.path === 'auth.logoutEverywhere');

    expect(route?.stepUp).toBe(true);
  });

  it('requires step-up to revoke a single session, but not to list them', () => {
    /* §3.4 — revoking a device is the single-session version of the
       `logoutEverywhere` protection above; listing your own sessions is a
       plain read. */
    const entries = routeManifest(appRouter);
    expect(entries.find((entry) => entry.path === 'auth.sessions.revoke')?.stepUp).toBe(true);
    expect(entries.find((entry) => entry.path === 'auth.sessions.list')?.stepUp).toBe(false);
  });
});
