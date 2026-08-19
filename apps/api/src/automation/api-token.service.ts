import { and, desc, eq, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { can, isPermission, PERMISSIONS } from '@taskflow/policy';
import { issueToken, newId } from '@taskflow/security';
import type { AutomationActor } from './automation.service.js';
import { apiTokenCreated, apiTokenRevoked } from './api-token-events.js';

/**
 * Programmatic-access token lifecycle (ai/phase-10-automation.md §6.3, Wave 3).
 *
 * Three operations, and the first one is where the security model lives:
 *
 *  - MINT validates every requested scope against the minting user's LIVE
 *    `can()` and refuses any scope they do not currently hold — the
 *    "scopes ⊆ holder's permissions, never a superset" rule, checked at the
 *    only moment the holder is present. It is re-checked per request (§6.4,
 *    slice 3) because membership changes: a demotion weakens every token the
 *    person holds, immediately.
 *  - LIST shows name/prefix/scopes/last-used/revoked and never the hash. The
 *    hash is the lookup key: there is no reason to hand it to a client, and a
 *    value a route returns is a value a log eventually contains.
 *  - REVOKE is a soft delete (`revoked_at`), idempotent, and emits its event
 *    only on the NULL → now transition — the audit log records the revoke
 *    once, not every attempt.
 *
 * The token exists in plaintext exactly once, in the mint response.
 */

type ApiTokenActor = AutomationActor;

const orgOf = (actor: ApiTokenActor) => actor.subject.orgId;
const userOf = (actor: ApiTokenActor) => actor.subject.userId;
const envelopeOf = (actor: ApiTokenActor) => ({
  orgId: actor.subject.orgId,
  actorId: actor.subject.userId,
  requestId: actor.requestId,
});

export interface ApiTokenSummary {
  readonly tokenId: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scopes: readonly string[];
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  /** When the token stops authenticating; null = never expires (§6.3, 0079). */
  readonly expiresAt: Date | null;
}

/**
 * The scope checklist's source (slice 5) — every permission the caller
 * currently holds, answered by ROLE ALONE, which is exactly the set mint
 * accepts (see mint's comment on why `can()` with no target is the right
 * question). Computed with the SAME call mint validates with, so the create
 * form can never offer a scope the server will refuse, and a demotion shows
 * up the next time the form loads.
 */
export function heldApiTokenScopes(actor: AutomationActor): readonly string[] {
  return PERMISSIONS.filter((permission) => can(actor.subject, permission).allowed);
}

export async function listApiTokens(actor: ApiTokenActor): Promise<readonly ApiTokenSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        tokenId: schema.apiTokens.id,
        name: schema.apiTokens.name,
        tokenPrefix: schema.apiTokens.tokenPrefix,
        scopes: schema.apiTokens.scopes,
        lastUsedAt: schema.apiTokens.lastUsedAt,
        revokedAt: schema.apiTokens.revokedAt,
        createdAt: schema.apiTokens.createdAt,
        expiresAt: schema.apiTokens.expiresAt,
      })
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.orgId, orgOf(actor)))
      .orderBy(desc(schema.apiTokens.createdAt));

    return rows.map((row) => ({ ...row, scopes: [...row.scopes] }));
  });
}

/**
 * Mints a `tf_pat` credential and returns it — shown once, never readable
 * again.
 *
 * ## The scope check is the mint
 *
 * Every requested scope must be BOTH a real permission from the closed
 * catalog (a bogus string is inert at enforcement but refused here, because
 * the UI builds its checklist from live `can()` and a typo'd scope should
 * surface at the form, not silently in a log) AND currently held by the
 * minting user, asked with `can()` and no target — the ROLE-ALONE answer.
 * That is deliberate: a token authenticates org-wide, so its scopes must be
 * capabilities the holder holds org-wide. `couldGrant` would be the wrong
 * tool — it answers "might this holder hold it on SOME resource", which is a
 * tuple-granted, per-resource capability, exactly the kind that must not
 * become an org-wide credential claim.
 *
 * The route floor (`apiToken:create`, owner/admin) has already run before
 * this service is reached.
 */
export async function mintApiToken(
  actor: ApiTokenActor,
  input: {
    readonly name: string;
    readonly scopes: readonly string[];
    /* An optional lifetime, in days. Omitted means a token that never expires
       — an explicit choice, not a default (§6.3, migration 0079). The lifetime
       is a DURATION rather than an absolute timestamp so the expiry is computed
       from the server clock: a client cannot mint a token that outlives what it
       asked for by lying about the time. */
    readonly expiresInDays?: number | undefined;
  },
): Promise<{ readonly tokenId: string; readonly token: string }> {
  /* Deduped so a token cannot claim the same capability twice — a duplicate
     is not a security hole, it is a row that lies about what the credential
     holds. */
  const scopes = [...new Set(input.scopes)];

  /* Computed here, from the server's own clock, so the stored expiry is
     authoritative. The route bounds the day count; this only turns it into the
     instant the auth lookup compares against. */
  const expiresAt =
    input.expiresInDays === undefined
      ? null
      : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  for (const scope of scopes) {
    if (!isPermission(scope)) {
      throw errors.validation(
        { scopes: [`'${scope}' is not a permission this system knows.`] },
        'One or more requested scopes are not real permissions.',
      );
    }

    const decision = can(actor.subject, scope);
    if (!decision.allowed) {
      throw errors.validation(
        { scopes: [`You do not currently hold '${scope}'.`] },
        'One or more requested scopes are not currently held.',
      );
    }
  }

  const tokenId = newId<'ApiTokenId'>();
  const orgId = orgOf(actor);
  const issued = issueToken('apiToken');

  /* The first ten characters of the token BODY (after `tf_pat_`), per the
     migration's CHECK (length = 10). Enough to tell two tokens both called
     "CI" apart in the list without ever storing or returning a full token. */
  const tokenPrefix = issued.token.slice('tf_pat_'.length, 'tf_pat_'.length + 10);

  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.apiTokens).values({
      id: tokenId,
      orgId,
      createdBy: userOf(actor),
      name: input.name,
      tokenHash: issued.hash,
      tokenPrefix,
      scopes,
      expiresAt,
    });

    await outboxWriter.append(tx, [
      createEvent(apiTokenCreated, { tokenId, name: input.name, scopes }, envelopeOf(actor)),
    ]);
  });

  /* The one time the token exists in plaintext. */
  return { tokenId, token: issued.token };
}

/**
 * Revokes a token — soft delete, idempotent, race-safe.
 *
 * The transition check lives in the UPDATE's WHERE (`revoked_at IS NULL`), not
 * between a SELECT and an UPDATE — the claim pattern this codebase uses
 * everywhere. Two racing revokes would otherwise both read `revoked_at IS
 * NULL` and both emit `api_token.revoked`, recording one revoke twice.
 * The event fires only when the UPDATE actually transitioned a row
 * (`rowCount = 1`); a second revoke of the same token is a no-op success —
 * the outcome the caller wanted is already true, and the audit log must not
 * record the same revoke twice.
 */
export async function revokeApiToken(
  actor: ApiTokenActor,
  input: { readonly tokenId: string },
): Promise<{ readonly revoked: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({ name: schema.apiTokens.name })
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.id, input.tokenId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) throw errors.notFound();

    const updated = await tx
      .update(schema.apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.apiTokens.id, input.tokenId), isNull(schema.apiTokens.revokedAt)));

    if (updated.rowCount === 1) {
      await outboxWriter.append(tx, [
        createEvent(apiTokenRevoked, { tokenId: input.tokenId, name: row.name }, envelopeOf(actor)),
      ]);
    }

    return { revoked: true as const };
  });
}
