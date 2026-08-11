import { createEvent } from '@taskflow/events';
import { apiTokenCreated } from '@taskflow/api/events/api-tokens';
import { hashToken, issueToken } from '@taskflow/security';
import { defineSeedModule } from '../registry.js';
import { envelopeFor } from '../support.js';
import { orgsModule } from './tenancy.orgs.js';

/**
 * API tokens (Phase 10 Wave 3) — one working credential per org.
 *
 * ## Minted through the real path, logged once
 *
 * `issueToken('apiToken')` is the exact function `mintApiToken` uses, so the
 * seeded row is a token that `authenticateWithApiToken` will accept the first
 * time a demo script presents it: `tf_pat_` prefix, sha256 hash in the
 * column, ten-character `token_prefix` passing the migration's CHECK. The
 * plaintext is printed once, like the service's own one-time reveal — after
 * that only the hash exists, and the demo user treats the printed value the
 * way they would treat a freshly minted credential.
 *
 * ## Scopes are real permissions, and deliberately modest
 *
 * A seeded token is a standing answer to the scope-intersection gate: its
 * scopes are validated against the closed catalog and refused when the owner
 * does not hold them, exactly like the mint route. The token below claims
 * `card:read` — read-only, boring, and true of every member, which is the
 * safe default for a credential a whole team might copy into scripts.
 */

export interface ApiTokensOutput {
  readonly tokenCount: number;
  /** The plaintext of the LAST minted token — the one-time reveal. */
  readonly token: string | null;
}

export const apiTokensModule = defineSeedModule({
  name: 'platform.api-tokens',
  requires: [orgsModule],
  tables: ['platform.api_tokens'],

  async seed(ctx): Promise<ApiTokensOutput> {
    const { orgs } = ctx.use(orgsModule);
    let tokenCount = 0;
    let token: string | null = null;

    for (const org of orgs) {
      const tokenId = ctx.rng.uuid(ctx.now);
      const issued = issueToken('apiToken');
      const prefix = issued.token.slice('tf_pat_'.length, 'tf_pat_'.length + 10);
      const createdBy = org.owner.id;

      await ctx.orgScope(org.id, () =>
        ctx.db.insert(
          'platform.api_tokens',
          [
            'id',
            'org_id',
            'created_by',
            'name',
            'token_hash',
            'token_prefix',
            'scopes::text[]',
            'created_at',
          ],
          [
            [
              tokenId,
              org.id,
              createdBy,
              `${org.name} script access`,
              hashToken(issued.token),
              prefix,
              ['card:read'],
              org.createdAt.toISOString(),
            ],
          ],
        ),
      );

      ctx.emit(
        createEvent(
          apiTokenCreated,
          { tokenId, name: `${org.name} script access`, scopes: ['card:read'] },
          envelopeFor(org.id, createdBy, org.createdAt),
        ),
      );

      token = issued.token;
      tokenCount += 1;
    }

    ctx.log(`platform.api-tokens: ${String(tokenCount)} token(s) minted`);
    return { tokenCount, token };
  },
});
