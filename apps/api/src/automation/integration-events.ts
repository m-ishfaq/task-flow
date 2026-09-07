import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Connector governance events (ai/phase-10-automation.md §7.8, Wave 4).
 *
 * The audit facts around the org's provider authorizations — who connected
 * this Slack workspace, when it was disconnected. The names use the lowercase
 * `integration.*` resource per the registry's convention (the `integration`
 * entry has been in RESOURCE_TYPES and the tuples object_type CHECK since
 * 0005, waiting for exactly this surface).
 *
 * Two things never appear in an event:
 *
 *   - the outbound credential, obviously — it is envelope-encrypted at rest
 *     and exists in plaintext only inside the connect flow's own process;
 *   - the GitHub per-org verify secret — the same rule the webhook events
 *     apply: the audit log must not carry a fragment of a secret. It is
 *     shown exactly once, by the mutation that mints it.
 *
 * `providerScope` IS carried: \"which workspace / repository\" is the question
 * an access review of a connector asks, and the row is keyed on it.
 */
export const integrationConnected = defineEvent(
  'integration.connected',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      providerScope: z.string(),
      name: z.string(),
    })
    .strict(),
);

/**
 * A GitHub connect's credential was stored but no repository chosen yet.
 *
 * Emitted by `complete` for GitHub — the row is written (status
 * 'disconnected', awaiting `selectRepo`) and guardrail 11 demands the write be
 * observable: if the person abandons the picker, this event is the ONLY record
 * that the org's credential for this login ever existed. `selectRepo` then
 * emits `integration.connected` and the connect completes; a row that never
 * gets one stays pending in the audit trail, which is the honest shape of "who
 * authorized what" when an access review asks.
 *
 * `provider` is always 'github' in practice; the enum is shared with the
 * other two events so the three read alike and a future provider with a
 * two-step connect inherits the shape without a schema change.
 */
export const integrationPending = defineEvent(
  'integration.pending',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      providerScope: z.string(),
    })
    .strict(),
);

export const integrationDisconnected = defineEvent(
  'integration.disconnected',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      providerScope: z.string(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * The synthetic TRIGGER events (slice 3, §7.5) — what an inbound webhook
 * becomes, as opposed to the governance facts above.
 * -------------------------------------------------------------------------- */

/**
 * The payload every inbound connector event carries (§7.5).
 *
 * `payload` is deliberately `unknown` rather than a closed schema: it is the
 * provider's own event body, whose shape belongs to Slack/GitHub, not to this
 * repo — a closed schema here would either reject a new provider field at the
 * route (turning a benign upstream change into a hard failure) or drift from
 * the registry. What IS closed is the wrapper: a rule keys on
 * `providerScope` (which workspace/repo) and `providerEvent` (which Slack
 * event type / X-GitHub-Event), and the raw body rides along for whatever the
 * action needs. The body is bounded upstream by the API's 1MB `bodyLimit`,
 * the same bound every outbox payload lives under — and `platform.outbox` is
 * never pruned (Phase 11), so a chatty connector's rows are exactly as heavy
 * as the deployment chose to accept.
 */
const connectorTriggerPayload = z
  .object({
    /** Slack team_id, or GitHub repository full_name — the row's scope. */
    providerScope: z.string(),
    /** Slack `event.type` (or top-level type), or the X-GitHub-Event header. */
    providerEvent: z.string(),
    /** The provider's parsed event body — the rule's raw material. */
    payload: z.unknown(),
  })
  .strict();

/**
 * A verified Slack workspace event, ready to trigger a rule.
 *
 * Written to the outbox by the inbound webhook route (§7.5) AFTER signature
 * verification with the deployment-wide signing secret — the signature is the
 * assertion, and `providerScope` (team_id, taken from the VERIFIED body) is a
 * lookup key, never a trust input. `actorId` is null on the envelope: the
 * event came from Slack, not from a user.
 *
 * The one deliberate edit to the body before storage: the deprecated legacy
 * `token` field is dropped from `payload` when present — a shared secret that
 * would otherwise sit in every consumer's view of the outbox for a rule that
 * almost certainly never reads it.
 */
export const integrationSlackEvent = defineEvent(
  'integration.slack_event',
  connectorTriggerPayload,
);

/**
 * A verified GitHub repository event, ready to trigger a rule.
 *
 * Same shape as the Slack event. The resolution order is the mirror image:
 * the org comes from `repository.full_name` in the UNVERIFIED body (the
 * lookup key — the per-org secret this body must be checked against lives on
 * the row the scope names), and only after that signature passes is anything
 * written.
 */
export const integrationGithubEvent = defineEvent(
  'integration.github_event',
  connectorTriggerPayload,
);

/* -------------------------------------------------------------------------- *
 * OUTBOUND effects (slice 4, §7.6) — what this deployment did to a provider,
 * as opposed to what a provider told us.
 *
 * These exist for guardrail 11, and the reason is sharper here than for a card
 * move: an outbound action spends the ORG'S OWN IDENTITY on somebody else's
 * platform. "A message appeared in #general signed by our workspace bot" is a
 * thing an access review has to be able to trace back to a rule and a rule
 * owner, and the provider's side of it is not ours to query.
 *
 * They carry no message body and no issue body. The audit log records that the
 * org posted, where, and under which rule — not what was said, which is on the
 * provider and is already recoverable from the rule's own stored action text.
 * A body copied here would put user text into a hash-chained log that cannot be
 * edited, for a fact the log does not need.
 * -------------------------------------------------------------------------- */

export const integrationMessagePosted = defineEvent(
  'integration.message_posted',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      providerScope: z.string(),
      /** The channel as the rule named it — `#general` or a channel id. */
      channel: z.string(),
      /** The provider's own id for what it created, for correlation. */
      providerMessageId: z.string().nullable(),
    })
    .strict(),
);

export const integrationIssueCreated = defineEvent(
  'integration.issue_created',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      /** The repository — `owner/name`, the row's own scope, never a rule input. */
      providerScope: z.string(),
      /** GitHub's issue number, so the audit row points at the actual issue. */
      issueNumber: z.number().nullable(),
    })
    .strict(),
);

/**
 * The four PR write events (Phase 15 §7 Wave 2 — `pr-write.service.ts`,
 * the AI assistant's PR write tools). Same rule as the two events above and
 * for the identical reason: no comment text, no review text — the audit log
 * records that the org posted, where, and under which PR, never what was
 * said. `prNumber` is public GitHub-side (it's the same number in the PR's
 * own URL), so carrying it here is not the same disclosure a comment body
 * would be.
 */
export const integrationPrCommentPosted = defineEvent(
  'integration.pr_comment_posted',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      providerScope: z.string(),
      prNumber: z.number(),
      /** GitHub's own id for the comment, for correlation. */
      providerCommentId: z.number().nullable(),
    })
    .strict(),
);

export const integrationPrReviewSubmitted = defineEvent(
  'integration.pr_review_submitted',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      providerScope: z.string(),
      prNumber: z.number(),
      /** Only `REQUEST_CHANGES` exists today (§7.2's own text: "post a
          review comment, request changes") — a real enum rather than a
          literal so a future review kind (e.g. `APPROVE`) is a value
          addition, not a schema change. */
      event: z.enum(['REQUEST_CHANGES']),
      providerReviewId: z.number().nullable(),
    })
    .strict(),
);

export const integrationPrMerged = defineEvent(
  'integration.pr_merged',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      providerScope: z.string(),
      prNumber: z.number(),
      /** The merge commit's SHA, for correlation — GitHub's own id for what
          this deployment did. */
      sha: z.string().nullable(),
    })
    .strict(),
);

export const integrationPrClosed = defineEvent(
  'integration.pr_closed',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      providerScope: z.string(),
      prNumber: z.number(),
    })
    .strict(),
);
