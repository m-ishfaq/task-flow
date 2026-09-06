import type { SearchProvider } from '@taskflow/contracts';
import { createSearchTool } from './search.js';
import { createMyCardsTool } from './my-cards.js';
import {
  createListBoardsTool,
  createListLabelsTool,
  createListMembersTool,
  createListProjectsTool,
  createListSprintsTool,
} from './lookup.js';
import {
  createCardAddLabelsTool,
  createCardAssignTool,
  createCardCreateTool,
  createCardSetStatusTool,
  createCardUpdateTool,
} from './card.js';
import { createSprintAddCardsTool, createSprintCreateTool } from './sprint.js';
import { createChatPostMessageTool } from './chat.js';
import { createDocsCreatePageTool } from './docs.js';
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
 * Wave 2 (§4.3) added the single-card write tools — `card_create`,
 * `card_update` (also covers `card.set_priority`; see `card.ts`'s own
 * header), `card_assign`, `card_set_status` — every one gated by
 * `requiresConfirmation: true` (`assistant.ts`'s confirm-before-execute
 * gate, §4.2). Wave 3 added sprint planning — `sprint_create`,
 * `sprint_add_cards` (see `sprint.ts`'s own header) — "multi-card, higher
 * blast radius" per §4.3's own wave order, also confirmation-gated. §4.3's
 * last item added `chat_post_message` (see `chat.ts`'s own header for why
 * it stays confirmation-gated despite §4.2's own text calling it "cheap to
 * undo"), closing §4.3's wave order entirely. `docs_create_page` — §4.1's
 * table names it as the tool §6's org-onboarding bootstrap will use, and no
 * wave had built it — adds title-only page creation (see `docs.ts`'s own
 * header for why a page's actual CONTENT is out of reach of this or any
 * other HTTP-layer tool). Still deliberately NOT here:
 * `summarize_sprint`/`summarize_channel` (§5's standup view) and the
 * optional, separately-toggled `web_search`.
 *
 * Every tool name here is `snake_case`, never the `card.create`-style
 * dotted names this registry originally shipped with. Anthropic's Messages
 * API and OpenAI's Chat Completions API both validate `tools[].name`
 * against the same `^[a-zA-Z0-9_-]+$` pattern — no dot — and this went
 * unnoticed through every wave because every test here (this file's own
 * suites included) either calls a tool's `execute` directly or stubs
 * `fetch`, so nothing ever sent a real tool list to a real provider until
 * an org actually running on `OpenAiProvider` did, and every write tool's
 * completion started failing with "Invalid 'tools[N].function.name'". A
 * real request is the only thing a wire-shape assumption like this can be
 * proven against — the identical lesson `openai.ts`'s truncation bug and
 * this codebase's other "green suite, live carrier" stories already teach.
 *
 * `my_cards` (`my-cards.ts`) was added after `search` alone was shown, from
 * a real transcript, unable to answer "what are my pending tasks" at
 * all — `search`'s field set has no `assignee` and no due date, a
 * structural gap no amount of prompt tuning on `search` alone could close.
 * See `my-cards.ts`'s own header for the full diagnosis.
 *
 * `list_projects`/`list_boards`/`list_labels` (`lookup.ts`) and
 * `card_add_labels` close the identical gap one level up: a real request to
 * "create a card in project X... tag it Y" had no way to resolve either
 * name to the id every write tool actually requires — there was nothing in
 * the whole registry that could ever produce a project, board, list, or
 * label id from its name. See `lookup.ts`'s own header.
 *
 * `list_members` and `list_sprints`, added after the same report continued
 * "still no way to mention a member or sprint," close the rest of it — see
 * `lookup.ts`'s own header. `card_create` was widened the same day to take
 * `assigneeIds`/`labelIds`/`priority`/`dueDate`/`sprintId` directly, so a
 * fully-specified card ("project X, assign Y, tag Z, due Friday") is ONE
 * confirmation once every name above resolves, not a create followed by
 * three more write-tool round trips each needing its own — see
 * `card.ts`'s own comment on `card_create` for why bundling several real
 * service calls behind one tool call changes nothing about what a caller
 * may do, only how many times a human has to approve it.
 */
export function buildToolRegistry(deps: ToolRegistryDeps): readonly ToolDefinition[] {
  return [
    createSearchTool(deps.searchProvider),
    createMyCardsTool(),
    createListProjectsTool(),
    createListBoardsTool(),
    createListLabelsTool(),
    createListMembersTool(),
    createListSprintsTool(),
    createCardCreateTool(),
    createCardUpdateTool(),
    createCardAssignTool(),
    createCardSetStatusTool(),
    createCardAddLabelsTool(),
    createSprintCreateTool(),
    createSprintAddCardsTool(),
    createChatPostMessageTool(),
    createDocsCreatePageTool(),
  ];
}
