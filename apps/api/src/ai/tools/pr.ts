import { z } from 'zod';
import type { AutomationActor } from '../../automation/automation.service.js';
import {
  getPullRequestComments,
  getPullRequestDiff,
  listPullRequests,
  type PrReadDeps,
} from '../../automation/pr-read.service.js';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.js';

/**
 * Read-only GitHub pull-request tools (ai/phase-15-ai-copilot-and-permissions.md
 * §7, Wave 1). Every function here wraps the real `pr-read.service.ts` call —
 * the one already `can(subject, 'pr:view')`-checked — so a member who cannot
 * view PRs cannot have the assistant view them either.
 *
 * All three are `requiresConfirmation: false`: nothing here writes anything,
 * the same tier `search`/`my_cards`/`list_*` already sit at. Write tools
 * (post a review comment, request changes, merge/close) are a later wave —
 * this file only reads.
 *
 * No id-resolution tool is needed for a PR the way `find_card` exists for a
 * card: a PR number is exactly what a person already sees in GitHub's own
 * UI and would type ("PR #42"), not an opaque id.
 */

function actorOf(ctx: ToolContext): AutomationActor {
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
