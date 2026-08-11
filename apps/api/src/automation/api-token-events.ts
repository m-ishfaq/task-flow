import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * API-token governance events (ai/phase-10-automation.md §6.3, Wave 3).
 *
 * The audit facts around the org's programmatic credentials — who minted one,
 * when one was revoked. (Names are `api_token.*` — the registry requires
 * lowercase resource names, and the underscore keeps the resource readable
 * next to the `apiToken` permission and table names.) Two things never appear in any event:
 *
 *   - the TOKEN itself, obviously — it exists in plaintext exactly once, in
 *     the mint response;
 *   - the token_prefix. A prefix is the first ten characters of a live
 *     credential's body, and the audit log is readable by a broader audience
 *     than the token row (audit:read holders). The webhook events' rule
 *     applies verbatim: the audit log must not carry a fragment of a secret.
 *
 * The SCOPES are included, deliberately: "what could this credential do" is
 * the governance question an incident review asks, and the audit entry is the
 * only place that survives even after every token is revoked.
 */
export const apiTokenCreated = defineEvent(
  'api_token.created',
  z.object({ tokenId: z.string(), name: z.string(), scopes: z.array(z.string()) }).strict(),
);

export const apiTokenRevoked = defineEvent(
  'api_token.revoked',
  z.object({ tokenId: z.string(), name: z.string() }).strict(),
);
