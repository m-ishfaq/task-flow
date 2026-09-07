import type { SearchProvider } from '@taskflow/contracts';
import { createSearchTool } from './search.js';
import { createMyCardsTool } from './my-cards.js';
import {
  createFindCardTool,
  createListBoardsTool,
  createListLabelsTool,
  createListMembersTool,
  createListProjectsTool,
  createListSprintsTool,
  createListStatusesTool,
} from './lookup.js';
import {
  createCardAddCommentTool,
  createCardAddLabelsTool,
  createCardAssignTool,
  createCardCreateTool,
  createCardMoveTool,
  createCardRemoveLabelsTool,
  createCardSetStatusTool,
  createCardUnassignTool,
  createCardUpdateTool,
} from './card.js';
import { createSprintAddCardsTool, createSprintCreateTool } from './sprint.js';
import { createChatPostMessageTool, createListChannelsTool } from './chat.js';
import { createDocsCreatePageTool } from './docs.js';
import {
  createCardLinkPrTool,
  createGetPrCommentsTool,
  createGetPrDiffTool,
  createListCardPrsTool,
  createListPrsTool,
  createPrCloseTool,
  createPrMergeTool,
  createPrPostCommentTool,
  createPrRequestChangesTool,
} from './pr.js';
import type { PrReadDeps } from '../../automation/pr-read.service.js';
import type { ToolDefinition } from './registry.js';

export type { ToolContext, ToolDefinition, ToolResult } from './registry.js';
export { defineTool, toAiToolDefinition } from './registry.js';

export interface ToolRegistryDeps {
  readonly searchProvider: SearchProvider;
  readonly prReadDeps: PrReadDeps;
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
 *
 * `find_card` (`lookup.ts`) closes the same gap one more entity type over —
 * a card by its own reference ("WEB-142") — found from a real transcript
 * where "move WEB-709" had no path to a real `cardId` at all; `search`
 * indexes card content, never the reference number.
 *
 * `card_move` and `card_add_comment` (`card.ts`) close two more gaps the
 * SAME transcript found the moment `find_card` let it actually reach a
 * card: moving a card between lists/boards had no tool at all (the model
 * tried `card_set_status` — a different concept, a card's STATUS field, not
 * its board/list — and `sprint_add_cards`, mistaking a board for a sprint,
 * both failing), and commenting on a card had no tool either (the model
 * reached for `chat_post_message`, a different subsystem entirely — a chat
 * channel message, not a card comment).
 *
 * A later transcript found three more gaps in one pass, prompted by an
 * explicit "add everything missing, not one bug at a time" request rather
 * than a single failure: `list_statuses` (`lookup.ts`) closes the same
 * name-to-id gap one more entity type over — `card_set_status` failed
 * "Not found." repeatedly because nothing could resolve a status NAME
 * ("In Progress", "Blocked") to a `statusId`, and the model guessed a list
 * id instead, the two vocabularies having overlapped by coincidence in the
 * project it was asked about. `list_channels` and `chat_post_message`'s new
 * `dmUserIds` (`chat.ts`) close the identical gap for Chat: nothing could
 * ever resolve a channel NAME or open a fresh DM to the `channelId`
 * `chat_post_message` requires — "send a msg to @Rosa Pereira" failed
 * "Not found." for exactly this reason. `card_unassign` and
 * `card_remove_labels` (`card.ts`) close the last one: the subtractive
 * counterparts to `card_assign`/`card_add_labels`, which until now could
 * only ever add.
 *
 * `list_prs`/`get_pr_diff`/`get_pr_comments` (`pr.ts`, Phase 15 §7 Wave 1) are
 * this registry's first tools reaching outside TaskFlow entirely — to the
 * org's connected GitHub repository. Read-only, gated on the new `pr:view`
 * permission (checked inside `pr-read.service.ts`, since these tools have no
 * tRPC route of their own to gate them).
 *
 * Wave 2 added the write half: `pr_post_comment`/`pr_request_changes`
 * (`pr:review`) and `pr_merge`/`pr_close` (`pr:merge`, a separate,
 * more-consequential permission) — all four `requiresConfirmation: true`,
 * see `pr.ts`'s own header for why that includes the two tools §7.2's own
 * text never explicitly required it for. They take `deps.prReadDeps`
 * directly — `PrWriteDeps` and `PrReadDeps` are the identical
 * `Pick<IntegrationDeps, 'keys' | 'fetchImpl'>` shape (both just need to
 * reach and decrypt the org's connector), so a second, separately-threaded
 * field here would be redundant plumbing for no functional difference.
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
    createListStatusesTool(),
    createFindCardTool(),
    createCardCreateTool(),
    createCardUpdateTool(),
    createCardAssignTool(),
    createCardUnassignTool(),
    createCardSetStatusTool(),
    createCardAddLabelsTool(),
    createCardRemoveLabelsTool(),
    createCardMoveTool(),
    createCardAddCommentTool(),
    createSprintCreateTool(),
    createSprintAddCardsTool(),
    createListChannelsTool(),
    createChatPostMessageTool(),
    createDocsCreatePageTool(),
    createListPrsTool(deps.prReadDeps),
    createGetPrDiffTool(deps.prReadDeps),
    createGetPrCommentsTool(deps.prReadDeps),
    createPrPostCommentTool(deps.prReadDeps),
    createPrRequestChangesTool(deps.prReadDeps),
    createPrMergeTool(deps.prReadDeps),
    createPrCloseTool(deps.prReadDeps),
    createListCardPrsTool(),
    createCardLinkPrTool(deps.prReadDeps),
  ];
}
