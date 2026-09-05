import type { SearchProvider } from '@taskflow/contracts';
import { createSearchTool } from './search.js';
import type { ToolDefinition } from './registry.js';

export type { ToolContext, ToolDefinition, ToolResult } from './registry.js';
export { defineTool, toAiToolDefinition } from './registry.js';

export interface ToolRegistryDeps {
  readonly searchProvider: SearchProvider;
}

/**
 * The assistant's whole tool list, built once per server instance —
 * mirroring `createSearchRouter(provider)`'s own "pass the provider in at
 * construction" shape, since `search` needs the same env-configured
 * `SearchProvider` the tRPC route does.
 *
 * §4.1's `summarize_sprint`/`summarize_channel`/`card.*`/`sprint.*`/
 * `chat.post_message`/`docs.create_page`/`web_search` are deliberately NOT
 * here yet — this is Wave 1 (§4.3): read-only, proving the tool-calling
 * loop and the token ledger with the least risk before anything that
 * writes joins the list.
 */
export function buildToolRegistry(deps: ToolRegistryDeps): readonly ToolDefinition[] {
  return [createSearchTool(deps.searchProvider)];
}
