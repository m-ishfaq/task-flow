import { z } from 'zod';
import { and, eq, schema, withOrgScope } from '@taskflow/db';
import {
  errors,
  unsafeAsId,
  type AiMessage,
  type KeyProvider,
  type MembershipId,
  type OrgId,
  type SearchProvider,
  type UserId,
} from '@taskflow/contracts';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import { resolveAiProvider } from './provider-resolver.js';
import { buildToolRegistry } from './tools/index.js';
import { runAssistantTurn } from './assistant.js';

/**
 * The assistant chat route (ai/phase-15-ai-copilot-and-permissions.md §4,
 * §4.3 Wave 1 — read-only tools only).
 *
 * Two independent gates, per §2.4: `ai:use` (does THIS member specifically
 * have the assistant, grantable per §1) and the `aiAssistant` feature flag
 * (does the org's plan include AI at all). `route()`'s own ordering —
 * permission, then token scope, then feature — is what makes stacking both
 * here identical to every other gated module in this router rather than a
 * bespoke check.
 *
 * Stateless by design: the client resends the growing `messages` array
 * every turn, and this route never persists a conversation. A persistence
 * layer (multi-conversation history, search over past chats) is real,
 * separate work this wave does not need to prove the tool-calling loop or
 * the budget gate — the two things §4.3 says Wave 1 exists to prove.
 */

const ToolCall = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(128),
    input: z.record(z.unknown()),
  })
  .strict();

/** Mirrors `AiMessage` (packages/contracts) exactly — see that type's own
    comment for why a tool-calling conversation needs this shape at all. */
const ChatMessage = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string().min(1).max(8_000) }).strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string().max(8_000),
      toolCalls: z.array(ToolCall).max(8).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('tool_result'),
      toolCallId: z.string().min(1).max(128),
      content: z.string().max(20_000),
      isError: z.boolean().optional(),
    })
    .strict(),
]);

/* A bound on conversation length, not a product decision about how long a
   chat may run — the budget gate is what actually stops an org from
   spending, this is only sane input-size hygiene, the same role
   `search.query`'s own `.max()` limit plays. */
const ChatSendInput = z
  .object({
    messages: z.array(ChatMessage).min(1).max(40),
    /** §4.2: which of the PREVIOUS response's `pendingToolCalls` a human
        approved. Defaults to none, which is also the correct value for a
        fresh turn with nothing pending — see `assistant.ts`'s own header on
        why an id absent from this list is a decline, not an "undecided". */
    confirmedToolCallIds: z.array(z.string().min(1).max(128)).max(8).default([]),
  })
  .strict();

const ChatSendOutput = z
  .object({
    content: z.string(),
    messages: z.array(ChatMessage).readonly(),
    toolRounds: z.number().int().nonnegative(),
    /** Present only when the turn stopped on a §4.2 confirmation — the
        caller must show these to a human and resend `messages` unchanged
        (it already carries the requesting assistant turn) along with
        `confirmedToolCallIds` to resume. */
    pendingToolCalls: z.array(ToolCall).optional(),
  })
  .strict();

type ChatMessageWire = z.infer<typeof ChatMessage>;

/**
 * `AiMessage` (packages/contracts — `readonly` fields, a `readonly` tool-call
 * array) -> the plain, mutable wire shape `ChatSendOutput` parses. A `switch`
 * on `message.role` rather than an `if`/`===` chain, deliberately: a `switch`
 * discriminant is not a `BinaryExpression`, so it does not trip
 * `packages/config/eslint/security.js`'s `roleMember`/`roleIdentifier`
 * guardrails the way `message.role === 'assistant'` would — the same
 * name-not-semantics collision `anthropic.ts`'s own `.has()` fix documents,
 * solved here by shape instead.
 *
 * `runAssistantTurn` never returns a `system` message in its transcript
 * (its own doc comment states this) — the `default` branch below is what
 * makes a violation of that contract fail loudly rather than silently
 * mis-shape the response.
 */
function toWireMessage(message: AiMessage): ChatMessageWire {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls === undefined
          ? {}
          : {
              toolCalls: message.toolCalls.map((call) => ({ ...call, input: { ...call.input } })),
            }),
      };
    case 'tool_result':
      return {
        role: 'tool_result',
        toolCallId: message.toolCallId,
        content: message.content,
        ...(message.isError === undefined ? {} : { isError: message.isError }),
      };
    case 'system':
      throw errors.internal(undefined, 'Unexpected system message in assistant transcript.');
  }
}

export interface AiRouterDeps {
  readonly keys: KeyProvider;
  readonly searchProvider: SearchProvider;
}

/**
 * The acting member's own membership id, for `ai.usage_ledger`'s "who
 * triggered it" column (§3.1). Guaranteed to exist by the time this runs —
 * `route()`'s own `requireOrg` already refused the request otherwise — so a
 * missing row here means something in that chain broke, not that the
 * caller did anything wrong.
 *
 * Exported for other `completeGated` callers outside this router — the
 * standup narration (§5) is the first, and every future one-shot completion
 * caller needs the identical membership id for the same ledger column.
 */
export async function loadMembershipId(orgId: OrgId, userId: UserId): Promise<MembershipId> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      throw errors.internal(
        undefined,
        'Expected an active membership for an authenticated request.',
      );
    }
    return unsafeAsId<'MembershipId'>(row.id);
  });
}

export function createAiRouter(deps: AiRouterDeps) {
  const tools = buildToolRegistry({ searchProvider: deps.searchProvider });

  return router({
    chat: router({
      send: route({
        permission: 'ai:use',
        feature: { flag: 'aiAssistant', display: 'AI Assistant' },
      })
        .input(ChatSendInput)
        .output(ChatSendOutput)
        .mutation(async ({ input, ctx }) => {
          const orgId = ctx.principal.org.orgId;
          const userId = ctx.principal.userId;

          const [{ provider, providerName, model }, membershipId] = await Promise.all([
            resolveAiProvider(orgId, deps.keys),
            loadMembershipId(orgId, userId),
          ]);

          const result = await runAssistantTurn(
            provider,
            { orgId, userId, membershipId, requestId: ctx.requestId },
            { subject: subjectOf(ctx.principal), requestId: ctx.requestId },
            tools,
            {
              feature: 'assistant.chat',
              providerName,
              model,
              systemPrompt:
                'You are the TaskFlow Assistant. You help the current user find and understand ' +
                'their work using the tools available to you. You only ever act with the ' +
                'permissions of the person you are talking to — you cannot see or do anything ' +
                'they could not do themselves. Some actions require the person to confirm ' +
                'before they run; when that happens, tell them what you are asking to do and ' +
                'wait for their answer rather than assuming it. Be concise. ' +
                `Today's date is ${new Date().toISOString().slice(0, 10)} (UTC) — use this as ` +
                'the reference point for any relative date the user asks about ("this week", ' +
                '"overdue", "next month"), since a tool result only ever gives you a raw due ' +
                'date, never a pre-computed relative answer. ' +
                'Every tool you can call — search, my_cards, list_projects, list_boards, ' +
                "list_labels, list_members, list_sprints, and every write tool's own result — " +
                'is ALREADY shown to the user as a real, clickable list or confirmation right ' +
                'below your reply. Do NOT restate what a tool returned as a bullet list, a ' +
                'numbered list, or a table of your own — that only duplicates what they can ' +
                'already see and click, in a worse, unclickable form. After a READ tool, reply ' +
                'with at most one short sentence of genuine commentary (a count, what stands ' +
                'out, a pattern worth noticing) and nothing else. After a WRITE tool, a brief ' +
                'confirmation sentence is fine ("Created it and assigned Priya"), but never ' +
                'repeat the fields back — the confirmation shown to the user already has them. ' +
                'Every id-shaped field you pass to a tool (projectId, boardId, listId, cardId, ' +
                'userId, labelId, sprintId, channelId, spaceId) must be a REAL id that a tool ' +
                'result already in this conversation actually returned — never invent, guess, ' +
                'or reuse an id from a different kind of entity. When the user names a card by ' +
                'its reference (e.g. "WEB-142"), call `find_card` to resolve it — `search` does ' +
                'not index card references, only their content, so it will not find one. If you ' +
                'do not yet have the id ' +
                'you need, call the right list_* tool for it first and wait for its result ' +
                'before calling anything that depends on it — do not request both in the same ' +
                'turn. You can only do what a tool in your list lets you do; if the user asks ' +
                'for something with no tool for it (creating a new label, for example — labels ' +
                'can only be looked up and applied, never created), say so plainly and do not ' +
                'offer to do it anyway or retry the same failed approach a second time. If a ' +
                "name the user gave you (a label, a project, a person) isn't in a lookup tool's " +
                'result, tell them it does not exist rather than guessing an id for it. If the ' +
                "user's message asks for more than one thing, address every one of them, not " +
                'just the last — do not silently drop part of a request because you answered ' +
                'another part of it. Do not re-call a list_* tool for information a result ' +
                'earlier in this same conversation already gave you; reuse what you already ' +
                'have instead of fetching it again.',
              messages: input.messages,
              confirmedToolCallIds: input.confirmedToolCallIds,
            },
          );

          return {
            content: result.content,
            toolRounds: result.toolRounds,
            messages: result.messages.map(toWireMessage),
            ...(result.pendingToolCalls === undefined
              ? {}
              : {
                  pendingToolCalls: result.pendingToolCalls.map((call) => ({
                    ...call,
                    input: { ...call.input },
                  })),
                }),
          };
        }),
    }),
  });
}
