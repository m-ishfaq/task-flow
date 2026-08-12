import { and, desc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, unsafeAsId, type KeyProvider, type OrgId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import {
  decryptString,
  encryptString,
  generatePkcePair,
  InvalidTokenError,
  newId,
  secureHex,
  signConnectorState,
  verifyConnectorState,
  type ConnectorStateClaims,
} from '@taskflow/security';
import type { AutomationActor } from './automation.service.js';
import {
  integrationConnected,
  integrationDisconnected,
  integrationPending,
} from './integration-events.js';

/**
 * Connector connect/disconnect (ai/phase-10-automation.md §7, Wave 4 slice 2).
 *
 * ## The flow is the oauth.service shape, org-flavoured
 *
 *   `integration.begin` (org-scoped, `integration:manage`, step-up) mints a
 *   signed state token carrying { provider, PKCE verifier, ORG, USER } and
 *   returns the provider's authorization URL. The browser round trip to
 *   Slack/GitHub loses the session — the oauth.callback precedent — so
 *   `integration.complete` is a PUBLIC route that trusts the signed state:
 *   the org the connector row is written under, and the person the connect
 *   is attributed to, come from the state, never from a request. An attacker
 *   without a session cannot mint state, and a holder of `integration:manage`
 *   can only mint it for orgs where they hold it — the same trust model as
 *   `linkUserId` in the login flow's state.
 *
 * ## Two providers, two completion shapes
 *
 *   Slack connects in one hop: the token exchange + `auth.test` yield the
 *   team_id and workspace name, and the row is complete immediately (the
 *   connected event fires here, and on every reconnect via the upsert).
 *
 *   GitHub is account-level OAuth but the model keys on the REPOSITORY
 *   full_name (§7.2), and the repo choice can only happen after consent. So
 *   complete stores the credential in a row keyed on the user's login with
 *   status 'disconnected' and returns the repos the token can reach; the
 *   web callback page renders the picker, and `selectRepo` validates the
 *   chosen full_name against that same token-owned list, flips the row to
 *   'connected', and fires `integration.connected` — the connect completes
 *   at the repo choice, not at the OAuth.
 *
 * ## The credential is envelope-encrypted and row-bound
 *
 *   The webhook secret's recipe: a per-org data key, the plaintext encrypted
 *   under it with the AAD binding to (org, row), the wrapped key and master
 *   key id stored beside the ciphertext. A ciphertext lifted out of the
 *   database cannot be transplanted into another org's row — the AAD (and
 *   the data key's own `{ orgId }` encryption context) would refuse to
 *   decrypt there. `integrationTokenAad` is exported because slice 4's
 *   executor decrypts with it, one definition in one file.
 *
 * GitHub's per-org VERIFY secret (the one an org pastes into its repo
 * webhook config, D4) is minted here, encrypted under the same key, and
 * returned to the caller EXACTLY ONCE — there is no read-back route, the
 * webhook precedent. A lost secret means re-running the connect flow, which
 * rotates it.
 */

export type ConnectorProvider = 'slack' | 'github';

export interface ConnectorProviderCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface IntegrationDeps {
  /** Absent entry = that provider is not configured; its begin/complete refuse rather than the app failing to boot. */
  readonly providers: Partial<Record<ConnectorProvider, ConnectorProviderCredentials>>;
  /** The OAuth redirect URI, registered with each provider's own console ahead of time. */
  readonly redirectUri: (provider: ConnectorProvider) => string;
  /** The absolute origin slice 3's inbound routes live on; absent = webhook URLs are hidden. */
  readonly webhookOrigin: string | undefined;
  /** For the connector state token — the same secret that signs access tokens. */
  readonly jwtSecret: Uint8Array;
  readonly keys: KeyProvider;
  /** Injectable so tests never make a real network call. */
  readonly fetchImpl?: typeof fetch;
}

export interface IntegrationSummary {
  readonly integrationId: string;
  readonly provider: ConnectorProvider;
  readonly name: string;
  readonly providerScope: string;
  readonly status: 'connected' | 'disconnected';
  readonly createdAt: Date;
}

export interface RepoRef {
  readonly name: string;
  readonly fullName: string;
}

type IntegrationActor = AutomationActor;

const orgOf = (actor: IntegrationActor) => actor.subject.orgId;
const userOf = (actor: IntegrationActor) => actor.subject.userId;
const envelopeOf = (actor: IntegrationActor) => ({
  orgId: actor.subject.orgId,
  actorId: actor.subject.userId,
  requestId: actor.requestId,
});

/**
 * The AAD binding a connector credential to its org and row.
 *
 * The webhook `signingAad` recipe: a ciphertext stolen out of the database is
 * authenticated to exactly one row, so it cannot be transplanted into another
 * org's connector. Exported for slice 4's executor, which decrypts at action
 * time — one definition in one file keeps the two sides from drifting (a
 * mismatch fails loud, but only after the action already failed).
 */
export function integrationTokenAad(orgId: string, integrationId: string): string {
  return `integration-token:${orgId}:${integrationId}`;
}

function credentialsFor(
  deps: IntegrationDeps,
  provider: ConnectorProvider,
): ConnectorProviderCredentials {
  const credentials = deps.providers[provider];
  if (!credentials) {
    throw errors.notFound(`Connecting ${provider} is not configured on this server.`);
  }
  return credentials;
}

/**
 * `verifyConnectorState` throws a raw `InvalidTokenError` — fine for a caller
 * inside `@taskflow/security`, wrong reaching a tRPC route boundary uncaught:
 * nothing there maps an arbitrary `Error` to a client-facing code, so an
 * expired or forged state would surface as an opaque INTERNAL_SERVER_ERROR
 * instead of the UNAUTHENTICATED a bad refresh token already gets.
 */
async function verifyState(state: string, secret: Uint8Array): Promise<ConnectorStateClaims> {
  try {
    return await verifyConnectorState(state, { secret });
  } catch (error) {
    if (error instanceof InvalidTokenError) throw errors.unauthenticated();
    throw error;
  }
}

function webhookUrlFor(deps: IntegrationDeps, provider: ConnectorProvider): string | null {
  if (deps.webhookOrigin === undefined) return null;
  return `${deps.webhookOrigin}/integrations/${provider}`;
}

/* -------------------------------------------------------------------------- *
 * Reads
 * -------------------------------------------------------------------------- */

export async function listIntegrations(
  actor: IntegrationActor,
): Promise<readonly IntegrationSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        integrationId: schema.integrations.id,
        provider: schema.integrations.provider,
        name: schema.integrations.name,
        providerScope: schema.integrations.providerScope,
        status: schema.integrations.status,
        createdAt: schema.integrations.createdAt,
      })
      .from(schema.integrations)
      .where(eq(schema.integrations.orgId, orgOf(actor)))
      .orderBy(desc(schema.integrations.createdAt));

    /* Explicit narrowing rather than `{ ...row }`: the drizzle mirror types
       `provider`/`status` as text (the migration's CHECK, not a pg enum), so
       the raw rows would widen past `IntegrationSummary`'s union types. The
       cast is safe — the database CHECK is the source of truth for the
       values. */
    return rows.map((row) => ({
      integrationId: row.integrationId,
      provider: row.provider as ConnectorProvider,
      name: row.name,
      providerScope: row.providerScope,
      status: row.status as IntegrationSummary['status'],
      createdAt: row.createdAt,
    }));
  });
}

/**
 * Which providers this server has credentials for, plus the webhook origin —
 * read by the Integrations tab so an unconfigured provider's connect button
 * does not render, the `oauth.providers` precedent.
 */
export function integrationCapabilities(deps: IntegrationDeps): {
  readonly slack: boolean;
  readonly github: boolean;
  readonly webhookOrigin: string | null;
} {
  return {
    slack: 'slack' in deps.providers,
    github: 'github' in deps.providers,
    webhookOrigin: deps.webhookOrigin ?? null,
  };
}

/* -------------------------------------------------------------------------- *
 * Begin — mint the state, hand the browser to the provider
 * -------------------------------------------------------------------------- */

export async function beginIntegration(
  actor: IntegrationActor,
  deps: IntegrationDeps,
  input: { readonly provider: ConnectorProvider },
): Promise<{ readonly authorizationUrl: string }> {
  const credentials = credentialsFor(deps, input.provider);
  const { verifier, challenge } = generatePkcePair();

  const state = await signConnectorState(
    {
      provider: input.provider,
      codeVerifier: verifier,
      orgId: orgOf(actor),
      userId: userOf(actor),
    },
    { secret: deps.jwtSecret },
  );

  const redirectUri = deps.redirectUri(input.provider);
  const url =
    input.provider === 'slack'
      ? slackAuthorizationUrl(credentials.clientId, redirectUri, state, challenge)
      : githubAuthorizationUrl(credentials.clientId, redirectUri, state);

  return { authorizationUrl: url.toString() };
}

function slackAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  challenge: string,
): URL {
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  /* `chat:write` is the one scope slice 4's `slack.post_message` needs.
     `channels:read` would let a connector list every channel in a workspace
     the org does not control its memberships of — the least privilege the
     outbound action actually needs. */
  url.searchParams.set('scope', 'chat:write');
  url.searchParams.set('state', state);
  /* Slack supports PKCE; the verifier rides in the signed state. */
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

function githubAuthorizationUrl(clientId: string, redirectUri: string, state: string): URL {
  /* GitHub's OAuth apps do not support PKCE; the confidential client secret
     exchanged in the callback stands in for it, the oauth.service reasoning. */
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'repo');
  url.searchParams.set('state', state);
  return url;
}

/* -------------------------------------------------------------------------- *
 * Complete — the browser is back from the provider
 * -------------------------------------------------------------------------- */

export type CompleteResult =
  | {
      readonly status: 'connected';
      readonly provider: 'slack';
      readonly integrationId: string;
      readonly name: string;
      readonly providerScope: string;
      readonly webhookUrl: string | null;
    }
  | {
      readonly status: 'pending_repo';
      readonly provider: 'github';
      readonly integrationId: string;
      readonly login: string;
      readonly repos: readonly RepoRef[];
      readonly webhookUrl: string | null;
      /** The per-org verify secret, shown exactly once — minted here, never readable again. */
      readonly verifySecret: string;
    };

export async function completeIntegration(
  deps: IntegrationDeps,
  input: { readonly provider: ConnectorProvider; readonly code: string; readonly state: string },
  /* The callback request's id — the public route still HAS a request id, and
     the audit entry for a connect should point at the request that caused
     it, the same as any other event. Branded, because the outbox envelope
     demands it (the same brand `AutomationActor['requestId']` carries). */
  requestId: AutomationActor['requestId'],
): Promise<CompleteResult> {
  const claims = await verifyState(input.state, deps.jwtSecret);

  if (claims.provider !== input.provider) {
    // The state was minted for a different provider than the callback URL
    // claims — a copy-pasted stale link or a forged callback.
    throw errors.validation({ state: 'This connect attempt does not match its provider.' });
  }

  const credentials = credentialsFor(deps, input.provider);
  const orgId = unsafeAsId<'OrgId'>(claims.orgId);
  const userId = unsafeAsId<'UserId'>(claims.userId);

  if (input.provider === 'slack') {
    return completeSlack(
      deps,
      credentials,
      input.code,
      claims.codeVerifier,
      orgId,
      userId,
      requestId,
    );
  }
  return completeGithub(deps, credentials, input.code, orgId, userId, requestId);
}

async function completeSlack(
  deps: IntegrationDeps,
  credentials: ConnectorProviderCredentials,
  code: string,
  codeVerifier: string,
  orgId: OrgId,
  userId: AutomationActor['subject']['userId'],
  requestId: AutomationActor['requestId'],
): Promise<Extract<CompleteResult, { provider: 'slack' }>> {
  const { token, teamId, teamName } = await exchangeSlackCode(
    deps,
    credentials,
    code,
    codeVerifier,
  );
  const integrationId = newId<'IntegrationId'>();

  const dataKey = await deps.keys.generateDataKey({ orgId });
  const ciphertext = encryptString(
    dataKey.plaintext.key,
    token,
    integrationTokenAad(orgId, integrationId),
  );

  /* The upsert is what makes RECONNECT work: disconnecting never deletes the
     row, and connecting the same workspace again lands on the same
     (org, slack, team_id) row with a fresh token. The connected event fires
     either way — a reconnect is a connect. */
  const inserted = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .insert(schema.integrations)
      .values({
        id: integrationId,
        orgId,
        provider: 'slack',
        name: teamName,
        providerScope: teamId,
        status: 'connected',
        tokenCiphertext: Buffer.from(ciphertext),
        tokenWrapped: Buffer.from(dataKey.wrapped.wrapped),
        tokenMasterId: dataKey.wrapped.masterKeyId,
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target: [
          schema.integrations.orgId,
          schema.integrations.provider,
          schema.integrations.providerScope,
        ],
        set: {
          name: teamName,
          status: 'connected',
          tokenCiphertext: Buffer.from(ciphertext),
          tokenWrapped: Buffer.from(dataKey.wrapped.wrapped),
          tokenMasterId: dataKey.wrapped.masterKeyId,
          createdBy: userId,
        },
      })
      .returning({ id: schema.integrations.id });

    const rowId = rows[0]?.id ?? integrationId;
    await outboxWriter.append(tx, [
      createEvent(
        integrationConnected,
        { integrationId: rowId, provider: 'slack', providerScope: teamId, name: teamName },
        { orgId, actorId: userId, requestId },
      ),
    ]);
    return rowId;
  });

  return {
    status: 'connected',
    provider: 'slack',
    integrationId: inserted,
    name: teamName,
    providerScope: teamId,
    webhookUrl: webhookUrlFor(deps, 'slack'),
  };
}

async function completeGithub(
  deps: IntegrationDeps,
  credentials: ConnectorProviderCredentials,
  code: string,
  orgId: OrgId,
  userId: AutomationActor['subject']['userId'],
  requestId: AutomationActor['requestId'],
): Promise<Extract<CompleteResult, { provider: 'github' }>> {
  const { token, login, repos } = await exchangeGithubCode(deps, credentials, code);
  const integrationId = newId<'IntegrationId'>();

  /* A fresh verify secret on EVERY complete, including a reconnect: a
     re-wiring of the connector is a deliberate act, and the org re-pastes the
     new secret into GitHub's repo webhook config — the "a lost secret means
     recreating the webhook" rule, applied to reconnecting. */
  const verifySecret = secureHex(32);
  const dataKey = await deps.keys.generateDataKey({ orgId });
  const tokenCiphertext = encryptString(
    dataKey.plaintext.key,
    token,
    integrationTokenAad(orgId, integrationId),
  );
  const verifyCiphertext = encryptString(
    dataKey.plaintext.key,
    verifySecret,
    integrationTokenAad(orgId, integrationId),
  );

  /* NO connected event here: the row is keyed on the login and the connect is
     not complete until a repository is chosen. `selectRepo` emits it. What
     DOES emit is `integration.pending` — guardrail 11, and the honest audit
     shape: if the person abandons the picker, this is the only record that
     the org's credential for this login ever existed. */
  const inserted = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .insert(schema.integrations)
      .values({
        id: integrationId,
        orgId,
        provider: 'github',
        name: login,
        providerScope: login,
        status: 'disconnected',
        tokenCiphertext: Buffer.from(tokenCiphertext),
        tokenWrapped: Buffer.from(dataKey.wrapped.wrapped),
        tokenMasterId: dataKey.wrapped.masterKeyId,
        verifyCiphertext: Buffer.from(verifyCiphertext),
        verifyWrapped: Buffer.from(dataKey.wrapped.wrapped),
        verifyMasterId: dataKey.wrapped.masterKeyId,
        createdBy: userId,
      })
      .onConflictDoUpdate({
        target: [
          schema.integrations.orgId,
          schema.integrations.provider,
          schema.integrations.providerScope,
        ],
        set: {
          name: login,
          status: 'disconnected',
          tokenCiphertext: Buffer.from(tokenCiphertext),
          tokenWrapped: Buffer.from(dataKey.wrapped.wrapped),
          tokenMasterId: dataKey.wrapped.masterKeyId,
          verifyCiphertext: Buffer.from(verifyCiphertext),
          verifyWrapped: Buffer.from(dataKey.wrapped.wrapped),
          verifyMasterId: dataKey.wrapped.masterKeyId,
          createdBy: userId,
        },
      })
      .returning({ id: schema.integrations.id });

    const rowId = rows[0]?.id ?? integrationId;
    await outboxWriter.append(tx, [
      createEvent(
        integrationPending,
        { integrationId: rowId, provider: 'github', providerScope: login },
        { orgId, actorId: userId, requestId },
      ),
    ]);
    return rowId;
  });

  return {
    status: 'pending_repo',
    provider: 'github',
    integrationId: inserted,
    login,
    repos,
    webhookUrl: webhookUrlFor(deps, 'github'),
    verifySecret,
  };
}

/* -------------------------------------------------------------------------- *
 * GitHub repo selection — the second half of the GitHub connect
 * -------------------------------------------------------------------------- */

/**
 * The repos a GitHub connection can reach — the picker's options, and the
 * list `selectRepo` validates against. Requires the row's token, so it lives
 * behind the route floor (`integration:manage`) and decrypts under the
 * row-bound key; the resume path for a pending connect after a page refresh.
 */
export async function listReposForIntegration(
  actor: IntegrationActor,
  deps: IntegrationDeps,
  input: { readonly integrationId: string },
): Promise<readonly RepoRef[]> {
  const orgId = orgOf(actor);
  const token = await tokenForRow(orgId, deps, input.integrationId, 'github');
  return githubRepos(deps, token);
}

/**
 * Completes the GitHub connect: validates the chosen repository is genuinely
 * reachable with the stored token (a repo the credential cannot access is not
 * a connector — inbound events for it could never be verified), re-keys the
 * row on the full_name, flips it to 'connected', and fires the connected
 * event that `complete` deliberately withheld.
 */
export async function selectRepo(
  actor: IntegrationActor,
  deps: IntegrationDeps,
  input: { readonly integrationId: string; readonly fullName: string },
): Promise<IntegrationSummary> {
  const orgId = orgOf(actor);

  const token = await tokenForRow(orgId, deps, input.integrationId, 'github');
  const accessible = await githubRepos(deps, token);
  if (!accessible.some((repo) => repo.fullName === input.fullName)) {
    throw errors.validation({
      fullName: 'That repository is not accessible with this connection.',
    });
  }

  return withOrgScope(orgId, async (tx) => {
    /* The claim guard, the `disconnect` precedent: only a row still awaiting
       its repo choice (status 'disconnected' WITH a credential) may be
       completed. A row already connected cannot be re-keyed by a stale
       picker, and a row wiped by a real disconnect has nothing to act with. */
    const rows = await tx
      .update(schema.integrations)
      .set({ providerScope: input.fullName, name: input.fullName, status: 'connected' })
      .where(
        and(
          eq(schema.integrations.id, input.integrationId),
          eq(schema.integrations.status, 'disconnected'),
        ),
      )
      .returning({
        integrationId: schema.integrations.id,
        provider: schema.integrations.provider,
        name: schema.integrations.name,
        providerScope: schema.integrations.providerScope,
        status: schema.integrations.status,
        createdAt: schema.integrations.createdAt,
      });

    const row = rows[0];
    if (row === undefined) throw errors.notFound();

    await outboxWriter.append(tx, [
      createEvent(
        integrationConnected,
        {
          integrationId: row.integrationId,
          provider: 'github',
          providerScope: input.fullName,
          name: input.fullName,
        },
        envelopeOf(actor),
      ),
    ]);

    /* Narrowed explicitly, the same reason as `listIntegrations`: the mirror
       types these columns as text, the CHECK owns the real values. */
    return {
      integrationId: row.integrationId,
      provider: row.provider as ConnectorProvider,
      name: row.name,
      providerScope: row.providerScope,
      status: row.status as IntegrationSummary['status'],
      createdAt: row.createdAt,
    };
  });
}

/* -------------------------------------------------------------------------- *
 * Disconnect — a status flip, never a delete
 * -------------------------------------------------------------------------- */

/**
 * Flips a connected connector to 'disconnected' and WIPES its credential.
 * The row survives (the migration's REVOKE DELETE makes a hard delete
 * unexpressible): it is the org's audit trail of having authorized this
 * scope. But a disconnected row is genuinely dead — the token and verify
 * columns are NULLed, so `tokenForRow` has nothing to decrypt and no stale
 * picker or admin can resurrect the connector with the token the org
 * deliberately revoked. That is what lets one 'disconnected' status mean
 * both "pending repo choice" (credential present) and "revoked"
 * (credential gone): the presence of the credential is the discriminator.
 *
 * The transition lives in the UPDATE's WHERE (`status = 'connected'`), the
 * claim pattern: two racing disconnects cannot both emit
 * `integration.disconnected`. The event fires only on the actual transition.
 */
export async function disconnectIntegration(
  actor: IntegrationActor,
  input: { readonly integrationId: string },
): Promise<{ readonly disconnected: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        provider: schema.integrations.provider,
        providerScope: schema.integrations.providerScope,
      })
      .from(schema.integrations)
      .where(eq(schema.integrations.id, input.integrationId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) throw errors.notFound();

    const updated = await tx
      .update(schema.integrations)
      .set({
        status: 'disconnected',
        /* The wipe. Name and providerScope survive for the audit trail; the
           material that could act as the org is gone. */
        tokenCiphertext: null,
        tokenWrapped: null,
        tokenMasterId: null,
        verifyCiphertext: null,
        verifyWrapped: null,
        verifyMasterId: null,
      })
      .where(
        and(
          eq(schema.integrations.id, input.integrationId),
          eq(schema.integrations.status, 'connected'),
        ),
      );

    if (updated.rowCount === 1) {
      await outboxWriter.append(tx, [
        createEvent(
          integrationDisconnected,
          {
            integrationId: input.integrationId,
            provider: row.provider as ConnectorProvider,
            providerScope: row.providerScope,
          },
          envelopeOf(actor),
        ),
      ]);
    }

    return { disconnected: true as const };
  });
}

/* -------------------------------------------------------------------------- *
 * Provider wire calls — the oauth.service shapes, with fake-able fetch
 * -------------------------------------------------------------------------- */

async function exchangeSlackCode(
  deps: IntegrationDeps,
  credentials: ConnectorProviderCredentials,
  code: string,
  codeVerifier: string,
): Promise<{ readonly token: string; readonly teamId: string; readonly teamName: string }> {
  const fetchFn = deps.fetchImpl ?? fetch;

  const response = await fetchFn('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: deps.redirectUri('slack'),
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    throw errors.validation({ code: 'Slack rejected the authorization code.' });
  }

  const body = (await response.json()) as { ok?: unknown; access_token?: unknown };
  if (body.ok !== true || typeof body.access_token !== 'string') {
    throw errors.validation({ code: 'Slack did not return an access token.' });
  }

  /* `oauth.v2.access` carries the workspace in the `team` field, but the
     honest read of \"who is this token for\" is `auth.test` with the token
     itself — it also proves the token works, the same reason the GitHub flow
     calls /user before trusting the exchange. */
  const testResponse = await fetchFn('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: { authorization: `Bearer ${body.access_token}` },
  });
  const testBody = (await testResponse.json()) as {
    ok?: unknown;
    team_id?: unknown;
    team_name?: unknown;
  };
  if (
    testBody.ok !== true ||
    typeof testBody.team_id !== 'string' ||
    typeof testBody.team_name !== 'string'
  ) {
    throw errors.validation({ code: 'Slack rejected the access token.' });
  }

  return { token: body.access_token, teamId: testBody.team_id, teamName: testBody.team_name };
}

const GITHUB_HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'TaskFlow' };

async function exchangeGithubCode(
  deps: IntegrationDeps,
  credentials: ConnectorProviderCredentials,
  code: string,
): Promise<{ readonly token: string; readonly login: string; readonly repos: readonly RepoRef[] }> {
  const fetchFn = deps.fetchImpl ?? fetch;

  const tokenResponse = await fetchFn('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: deps.redirectUri('github'),
    }).toString(),
  });
  if (!tokenResponse.ok) {
    throw errors.validation({ code: 'GitHub rejected the authorization code.' });
  }
  const tokenBody = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof tokenBody.access_token !== 'string') {
    throw errors.validation({ code: 'GitHub did not return an access token.' });
  }

  const token = tokenBody.access_token;
  const authHeaders = { ...GITHUB_HEADERS, authorization: `Bearer ${token}` };

  const userResponse = await fetchFn('https://api.github.com/user', { headers: authHeaders });
  if (!userResponse.ok) {
    throw errors.validation({ code: 'GitHub rejected the access token.' });
  }
  const user = (await userResponse.json()) as { login?: unknown };
  if (typeof user.login !== 'string') {
    throw errors.validation({ code: 'GitHub returned no login.' });
  }

  const repos = await githubRepos(deps, token);
  return { token, login: user.login, repos };
}

/* One page of `/user/repos`, and the ceiling on how many we will walk.
   GitHub caps `per_page` at 100, so an account with more repositories than
   PAGE_LIMIT * PAGE_SIZE has a truncated picker — bounded rather than
   unbounded on purpose (the search router's 50/100 argument), because an
   unpaged loop against a third party is a request amplifier, not a feature. */
const GITHUB_REPO_PAGE_SIZE = 100;
const GITHUB_REPO_PAGE_LIMIT = 10;

/**
 * The repos a GitHub token can reach — used by complete, repos, and selectRepo.
 *
 * `affiliation`, never `type`. `type=member` means "repositories I am a
 * collaborator or organization member on, EXCLUDING the ones I own" — so the
 * picker listed every repo except the connecting user's own, and because
 * `selectRepo` validates the chosen `full_name` against this same list, an
 * owned repository was not merely hidden but impossible to connect. The
 * refusal read as "that repository is not accessible with this connection",
 * which is exactly the wrong diagnosis. The two parameters are mutually
 * exclusive (GitHub answers 422 if both are sent), and `affiliation` is the
 * one that can express "everything this token reaches".
 *
 * Paginated because the picker is a correctness surface, not a preview: a
 * repository missing from page 2 cannot be selected at all.
 */
async function githubRepos(deps: IntegrationDeps, token: string): Promise<readonly RepoRef[]> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const collected: RepoRef[] = [];

  for (let page = 1; page <= GITHUB_REPO_PAGE_LIMIT; page += 1) {
    const response = await fetchFn(
      `https://api.github.com/user/repos?per_page=${GITHUB_REPO_PAGE_SIZE}` +
        `&sort=full_name&affiliation=owner,collaborator,organization_member&page=${page}`,
      { headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw errors.validation({ code: 'GitHub rejected the access token.' });
    }

    const rows = (await response.json()) as { name?: unknown; full_name?: unknown }[];
    for (const row of rows) {
      if (typeof row.name === 'string' && typeof row.full_name === 'string') {
        collected.push({ name: row.name, fullName: row.full_name });
      }
    }

    // A short page is the last page — GitHub returns exactly `per_page` rows
    // while more remain, so this is the only end condition that does not need
    // a second request to discover.
    if (rows.length < GITHUB_REPO_PAGE_SIZE) break;
  }

  return collected;
}

/** Loads and decrypts the outbound token for one of the org's rows. */
async function tokenForRow(
  orgId: OrgId,
  deps: IntegrationDeps,
  integrationId: string,
  expectedProvider: ConnectorProvider,
): Promise<string> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        provider: schema.integrations.provider,
        tokenCiphertext: schema.integrations.tokenCiphertext,
        tokenWrapped: schema.integrations.tokenWrapped,
        tokenMasterId: schema.integrations.tokenMasterId,
      })
      .from(schema.integrations)
      .where(eq(schema.integrations.id, integrationId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) throw errors.notFound();
    if (row.provider !== expectedProvider) {
      throw errors.validation({
        integrationId: `That connector is not a ${expectedProvider} connector.`,
      });
    }

    /* A credential that is NULL is a REVOKED connector (migration 0057:
       disconnect wipes the six credential columns). The row exists — it is
       the org's audit trail — but nothing may act as the org with it. The
       answer is the same notFound a missing row gets: the connector, as a
       usable thing, is gone. Slice 4's executor refuses an action naming it
       for the same reason. */
    if (row.tokenWrapped === null || row.tokenCiphertext === null || row.tokenMasterId === null) {
      throw errors.notFound();
    }

    const dataKey = await deps.keys.unwrapDataKey({
      wrapped: new Uint8Array(row.tokenWrapped),
      masterKeyId: row.tokenMasterId,
      encryptionContext: { orgId },
    });

    return decryptString(
      dataKey.key,
      new Uint8Array(row.tokenCiphertext),
      integrationTokenAad(orgId, integrationId),
    );
  });
}
