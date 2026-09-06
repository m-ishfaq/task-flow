import type { SearchProvider } from '@taskflow/contracts';
import { createSearchTool } from './search.js';
import {
  createCardAssignTool,
  createCardCreateTool,
  createCardSetStatusTool,
  createCardUpdateTool,
} from './card.js';
import { createSprintAddCardsTool, createSprintCreateTool } from './sprint.js';
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
 * Wave 2 (§4.3) added the single-card write tools — `card.create`,
 * `card.update` (also covers `card.set_priority`; see `card.ts`'s own
 * header), `card.assign`, `card.set_status` — every one gated by
 * `requiresConfirmation: true` (`assistant.ts`'s confirm-before-execute
 * gate, §4.2). Wave 3 adds sprint planning — `sprint.create`,
 * `sprint.add_cards` (see `sprint.ts`'s own header) — "multi-card, higher
 * blast radius" per §4.3's own wave order, also confirmation-gated. Still
 * deliberately NOT here: `summarize_sprint`/`summarize_channel`,
 * `chat.post_message`, `docs.create_page`, `web_search` — later waves.
 */
export function buildToolRegistry(deps: ToolRegistryDeps): readonly ToolDefinition[] {
  return [
    createSearchTool(deps.searchProvider),
    createCardCreateTool(),
    createCardUpdateTool(),
    createCardAssignTool(),
    createCardSetStatusTool(),
    createSprintCreateTool(),
    createSprintAddCardsTool(),
  ];
}
