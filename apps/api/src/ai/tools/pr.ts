import { z } from 'zod';
import { CardIdSchema } from '@taskflow/contracts';
import type { AutomationActor } from '../../automation/automation.service.js';
import { connectedGithubRepo } from '../../automation/integration.service.js';
import {
  getPullRequestComments,
  getPullRequestDiff,
  listPullRequests,
  type PrReadDeps,
} from '../../automation/pr-read.service.js';
import {
  closePr,
  mergePr,
  postPrComment,
  requestPrChanges,
  type PrWriteDeps,
} from '../../automation/pr-write.service.js';
import { linkCardPullRequest, listCardPullRequests } from '../../work/card-pull-request.service.js';
import type { WorkActor } from '../../work/shared.js';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.js';

/**
 * GitHub pull-request tools (ai/phase-15-ai-copilot-and-permissions.md §7).
 * Every function here wraps a real, already-`can()`-checked call into
 * `pr-read.service.ts`/`pr-write.service.ts` — never its own authorization
 * logic — so a member who cannot view/review/merge PRs cannot have the
 * assistant do it for them either.
 *
 * Wave 1's three read tools are `requiresConfirmation: false`, the same
 * tier `search`/`my_cards`/`list_*` sit at. Wave 2's four write tools are
 * ALL `requiresConfirmation: true`, no exceptions — including
 * `pr_post_comment`/`pr_request_changes`, even though §7.2's own text never
 * explicitly calls those two out as needing confirmation the way it does for
 * merge/close. This is the identical posture this registry already took for
 * `chat_post_message` and `docs_create_page`, both cases where the spec's
 * "cheap to undo" language was read as a reason NOT to auto-execute: one
 * uniform rule (nothing writes without a human's explicit yes) is simpler to
 * reason about and audit than deciding tool-by-tool which risk is low enough
 * to skip, and a PR comment is visible to the whole GitHub org the instant it
 * posts — read before anyone could undo it, the same property that argument
 * turned on for chat.
 *
 * No id-resolution tool is needed for a PR the way `find_card` exists for a
 * card: a PR number is exactly what a person already sees in GitHub's own
 * UI and would type ("PR #42"), not an opaque id.
 */

function actorOf(ctx: ToolContext): AutomationActor {
  return { subject: ctx.subject, requestId: ctx.requestId };
}

function workActorOf(ctx: ToolContext): WorkActor {
  return { subject: ctx.subject, requestId: ctx.requestId };
}

const ListPrsInput = z
  .object({
    state: z.enum(['open', 'closed', 'all']).default('open'),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();

export function createListPrsTool(deps: PrReadDeps): ToolDefinition {
  return defineTool({
    name: 'list_prs',
    description:
      "Lists pull requests on the organization's connected GitHub repository, most recent " +
      'first. Defaults to open PRs. Use this before `get_pr_diff`/`get_pr_comments`, which need ' +
      'a real PR number — either from this list, or one the user gave you directly (e.g. "PR #42").',
    jsonSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
    requiresConfirmation: false,
    inputSchema: ListPrsInput,
    async execute(ctx, input) {
      const prs = await listPullRequests(actorOf(ctx), deps, input);
      if (prs.length === 0) return { content: 'No pull requests found.' };
      return { content: JSON.stringify(prs) };
    },
  });
}

const PrNumberInput = z.object({ prNumber: z.number().int().positive() }).strict();

export function createGetPrDiffTool(deps: PrReadDeps): ToolDefinition {
  return defineTool({
    name: 'get_pr_diff',
    description:
      "Fetches a pull request's diff, given its number. Long diffs are truncated — check the " +
      "result's `truncated` field before assuming you have seen the whole change.",
    jsonSchema: {
      type: 'object',
      properties: { prNumber: { type: 'integer', description: 'The pull request number.' } },
      required: ['prNumber'],
      additionalProperties: false,
    },
    requiresConfirmation: false,
    inputSchema: PrNumberInput,
    async execute(ctx, input) {
      const result = await getPullRequestDiff(actorOf(ctx), deps, input);
      return { content: JSON.stringify(result) };
    },
  });
}

export function createGetPrCommentsTool(deps: PrReadDeps): ToolDefinition {
  return defineTool({
    name: 'get_pr_comments',
    description:
      "Fetches a pull request's comments — both the general conversation thread and inline " +
      'code review comments — given its number.',
    jsonSchema: {
      type: 'object',
      properties: { prNumber: { type: 'integer', description: 'The pull request number.' } },
      required: ['prNumber'],
      additionalProperties: false,
    },
    requiresConfirmation: false,
    inputSchema: PrNumberInput,
    async execute(ctx, input) {
      const comments = await getPullRequestComments(actorOf(ctx), deps, input);
      if (comments.length === 0) return { content: 'No comments on this pull request.' };
      return { content: JSON.stringify(comments) };
    },
  });
}

/* -------------------------------------------------------------------------- *
 * Write tools (Wave 2) — every one confirmation-gated, see this file's own
 * header for why that includes the two that §7.2's text never explicitly
 * required it for.
 * -------------------------------------------------------------------------- */

const PrCommentInput = z
  .object({ prNumber: z.number().int().positive(), body: z.string().min(1).max(20_000) })
  .strict();

export function createPrPostCommentTool(deps: PrWriteDeps): ToolDefinition {
  return defineTool({
    name: 'pr_post_comment',
    description: "Posts a general comment on a pull request's conversation thread.",
    jsonSchema: {
      type: 'object',
      properties: {
        prNumber: { type: 'integer', description: 'The pull request number.' },
        body: { type: 'string', description: 'The comment text.' },
      },
      required: ['prNumber', 'body'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: PrCommentInput,
    async execute(ctx, input) {
      const result = await postPrComment(actorOf(ctx), deps, input);
      return { content: JSON.stringify(result) };
    },
  });
}

export function createPrRequestChangesTool(deps: PrWriteDeps): ToolDefinition {
  return defineTool({
    name: 'pr_request_changes',
    description:
      'Submits a "request changes" review on a pull request, with a comment explaining why.',
    jsonSchema: {
      type: 'object',
      properties: {
        prNumber: { type: 'integer', description: 'The pull request number.' },
        body: { type: 'string', description: 'What needs to change, and why.' },
      },
      required: ['prNumber', 'body'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: PrCommentInput,
    async execute(ctx, input) {
      const result = await requestPrChanges(actorOf(ctx), deps, input);
      return { content: JSON.stringify(result) };
    },
  });
}

const PrMergeInput = z
  .object({
    prNumber: z.number().int().positive(),
    mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional(),
  })
  .strict();

export function createPrMergeTool(deps: PrWriteDeps): ToolDefinition {
  return defineTool({
    name: 'pr_merge',
    description:
      "Merges a pull request. Uses the repository's default merge method unless " +
      '`mergeMethod` is given.',
    jsonSchema: {
      type: 'object',
      properties: {
        prNumber: { type: 'integer', description: 'The pull request number.' },
        mergeMethod: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
      },
      required: ['prNumber'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: PrMergeInput,
    async execute(ctx, input) {
      // `input.mergeMethod` is `T | undefined` per Zod's own `.optional()`
      // inference, not merely absent-when-unset — under
      // `exactOptionalPropertyTypes`, passing that straight through would
      // let an explicit `undefined` reach a field typed as plain `T`.
      // Building the object conditionally keeps the key ABSENT rather than
      // present-with-undefined, the same fix `useUpdateCard` (apps/web) uses
      // for the identical Zod-optional-vs-exact-optional mismatch.
      const result = await mergePr(actorOf(ctx), deps, {
        prNumber: input.prNumber,
        ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }),
      });
      return { content: JSON.stringify(result) };
    },
  });
}

export function createPrCloseTool(deps: PrWriteDeps): ToolDefinition {
  return defineTool({
    name: 'pr_close',
    description: 'Closes a pull request without merging it.',
    jsonSchema: {
      type: 'object',
      properties: { prNumber: { type: 'integer', description: 'The pull request number.' } },
      required: ['prNumber'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: PrNumberInput,
    async execute(ctx, input) {
      const result = await closePr(actorOf(ctx), deps, input);
      return { content: JSON.stringify(result) };
    },
  });
}

/* -------------------------------------------------------------------------- *
 * The card <-> PR link (ai/phase-15-ai-copilot-and-permissions.md §7.2,
 * `work/card-pull-request.service.ts`). Neither tool below touches GitHub —
 * `list_card_prs` reads `work.card_pull_requests` directly, and
 * `card_link_pr` only resolves the org's connector to learn `providerScope`
 * (never to make a GitHub call), then writes one row through the real,
 * `card:update`-checked service. See that service's own header for why this
 * needs no `pr:view` and performs no existence check against GitHub.
 * -------------------------------------------------------------------------- */

const ListCardPrsInput = z.object({ cardId: CardIdSchema }).strict();

export function createListCardPrsTool(): ToolDefinition {
  return defineTool({
    name: 'list_card_prs',
    description: 'Lists the pull requests linked to a card.',
    jsonSchema: {
      type: 'object',
      properties: { cardId: { type: 'string', description: 'The card, from `find_card`.' } },
      required: ['cardId'],
      additionalProperties: false,
    },
    requiresConfirmation: false,
    inputSchema: ListCardPrsInput,
    async execute(ctx, input) {
      const links = await listCardPullRequests(workActorOf(ctx), input);
      if (links.length === 0) return { content: 'No pull requests are linked to this card.' };
      return { content: JSON.stringify(links) };
    },
  });
}

const CardLinkPrInput = z
  .object({ cardId: CardIdSchema, prNumber: z.number().int().positive() })
  .strict();

export function createCardLinkPrTool(deps: PrReadDeps): ToolDefinition {
  return defineTool({
    name: 'card_link_pr',
    description:
      "Links a pull request (by number, on the organization's connected repo) to a card, so " +
      'anyone opening the card can see which PR relates to it.',
    jsonSchema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: 'The card, from `find_card`.' },
        prNumber: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['cardId', 'prNumber'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: CardLinkPrInput,
    async execute(ctx, input) {
      const connector = await connectedGithubRepo(ctx.subject.orgId, deps);
      const result = await linkCardPullRequest(workActorOf(ctx), {
        cardId: input.cardId,
        providerScope: connector.providerScope,
        prNumber: input.prNumber,
      });
      return { content: JSON.stringify(result) };
    },
  });
}
