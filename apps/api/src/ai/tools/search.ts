import { z } from 'zod';
import type { SearchProvider } from '@taskflow/contracts';
import { performSearch } from '../../search/search.service.js';
import { defineTool, type ToolDefinition } from './registry.js';

/**
 * The `search` tool (§4.1) — a thin wrapper over `performSearch`, the exact
 * pipeline `search.query`'s own tRPC route runs. Read-only, so this needs
 * no confirm-before-execute (§4.2) and emits no domain event (guardrail 6
 * is about state mutation).
 *
 * The `limit` ceiling is far tighter than the route's own 100 — a tool
 * result becomes conversation history the model re-reads on every
 * subsequent turn, so a large result set is not merely slower, it is
 * tokens spent on every future turn of the SAME conversation.
 */

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 8;

const SearchToolInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .describe('A TaskFlow Query Language (TQL) query, e.g. "status = open AND assignee = @me"'),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export function createSearchTool(provider: SearchProvider): ToolDefinition {
  return defineTool({
    name: 'search',
    description:
      'Search cards, chat messages, docs pages, comments, and call transcripts using TaskFlow Query Language (TQL). Returns only results the current user is allowed to see.',
    jsonSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A TQL query, e.g. "status = open AND assignee = @me"',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum results to return (default ${String(DEFAULT_LIMIT)}).`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    inputSchema: SearchToolInput,
    async execute(ctx, input) {
      const hits = await performSearch(provider, ctx.subject, {
        query: input.query,
        limit: input.limit,
      });

      if (hits.length === 0) {
        return { content: 'No results.' };
      }

      // A compact projection, not the raw hit — `snippet`/`title` are what a
      // person would read off a search results page; `metadata` (board ids,
      // channel ids) is plumbing the model has no use for and the search
      // route itself only returns for the CLIENT to build a link with.
      const summarized = hits.map((hit) => ({
        type: hit.type,
        id: hit.entityId,
        title: hit.title,
        snippet: hit.snippet,
      }));

      return { content: JSON.stringify(summarized) };
    },
  });
}
