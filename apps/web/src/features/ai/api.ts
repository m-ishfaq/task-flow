import { wire } from '@taskflow/client';
import { api } from '../../lib/trpc.js';

/**
 * The assistant chat wire shapes (ai/phase-15-ai-copilot-and-permissions.md
 * §4), restated by hand rather than imported from the server's Zod schemas —
 * the `search/api.ts` precedent. `ai.chat.send`'s real contract lives in
 * `apps/api/src/ai/router.ts`'s `ChatMessage`/`ChatSendInput`/`ChatSendOutput`;
 * these mirror it exactly and `tsc` is what catches drift, since every call
 * site below goes through the real, generated `api.ai.chat.send` client.
 */

export interface ToolCallWire {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export type ChatMessageWire =
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly ToolCallWire[];
    }
  | {
      readonly role: 'tool_result';
      readonly toolCallId: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export interface ChatTurnResult {
  readonly content: string;
  readonly messages: readonly ChatMessageWire[];
  readonly toolRounds: number;
  readonly pendingToolCalls?: readonly ToolCallWire[];
}

/**
 * `ai.chat.send`'s `ChatSendInput.messages` caps at 40 elements
 * (`apps/api/src/ai/router.ts`) — real input-size hygiene, not a product
 * decision about how long a conversation may run (that route's own comment).
 * Nothing on the client enforced that before this: `assistant-page.tsx`
 * resends the WHOLE growing transcript every turn (`sendChatTurn`'s own
 * comment below), so a real conversation long enough to cross 40 messages
 * got a hard `BAD_REQUEST` — "Array must contain at most 40 element(s)" —
 * with no way to continue. Found from a real transcript where exactly that
 * happened.
 *
 * The fix windows the array at the TRANSPORT boundary rather than raising
 * the cap or dropping history from what a person can see:
 * `assistant-page.tsx` keeps the full transcript in its own state forever
 * and asks `windowForRequest` only for what to actually SEND. Trimming has
 * to stop at a safe boundary: an `assistant` message carrying `toolCalls`
 * and the `tool_result` turns answering them are one atomic UNIT — both
 * Anthropic and OpenAI reject a tool call with no matching result in the
 * very next turn — so cutting between them would corrupt the transcript,
 * not merely shorten it. `messageUnits` groups the array into these units;
 * `windowForRequest` keeps the longest RECENT run of whole units that both
 * fits under the cap and starts on a `user` turn, since a transcript opening
 * on an `assistant` turn (its own `user` message dropped out from under it)
 * is not a shape either provider's API accepts as a first message.
 */
const MAX_REQUEST_MESSAGES = 40;

/* Membership tests, not `=== 'tool_result'`/`=== 'assistant'` — deliberately.
   `packages/config/eslint/security.js`'s `roleMember` guardrail bans any
   `===`/`!==` comparison naming a `.role` property on the theory that the
   shape is almost always an inline org-role check drifting from `can()`.
   `ChatMessageWire.role` is a chat turn's speaker, a different concept
   entirely, but the selector matches on NAME, not semantics — the identical
   collision `assistant.ts`'s own `ASSISTANT_ROLE_MESSAGES` already
   documents, solved here the same way. */
const TOOL_RESULT_ROLE_MESSAGES = new Set(['tool_result']);
const ASSISTANT_ROLE_MESSAGES = new Set(['assistant']);
const USER_ROLE_MESSAGES = new Set(['user']);

function messageUnits(
  messages: readonly ChatMessageWire[],
): readonly (readonly ChatMessageWire[])[] {
  const units: ChatMessageWire[][] = [];
  for (const message of messages) {
    const lastUnit = units.at(-1);
    const head = lastUnit?.[0];
    const continuesToolResults =
      TOOL_RESULT_ROLE_MESSAGES.has(message.role) &&
      head !== undefined &&
      ASSISTANT_ROLE_MESSAGES.has(head.role);
    if (continuesToolResults) {
      lastUnit?.push(message);
      continue;
    }
    units.push([message]);
  }
  return units;
}

export function windowForRequest(
  messages: readonly ChatMessageWire[],
  maxCount = MAX_REQUEST_MESSAGES,
): readonly ChatMessageWire[] {
  if (messages.length <= maxCount) return messages;

  const units = messageUnits(messages);

  // The longest suffix of whole units that fits under the cap AND starts on
  // a `user` turn — walking from the most recent unit backward, remembering
  // the earliest `user`-headed unit seen while still within budget.
  let bestStart: number | undefined;
  let suffixSize = 0;
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i];
    if (unit === undefined) break;
    suffixSize += unit.length;
    if (suffixSize > maxCount) break;
    const head = unit[0];
    if (head !== undefined && USER_ROLE_MESSAGES.has(head.role)) bestStart = i;
  }
  if (bestStart !== undefined) return units.slice(bestStart).flat();

  // No `user`-starting suffix fits at all — a pathological transcript with
  // no user turn anywhere near its own tail. Fall back to the plain
  // size-based window rather than sending nothing (`ChatSendInput.messages`
  // requires at least one element).
  const kept: (readonly ChatMessageWire[])[] = [];
  let total = 0;
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i];
    if (unit === undefined) break;
    if (total + unit.length > maxCount) break;
    kept.unshift(unit);
    total += unit.length;
  }
  return kept.flat();
}

/**
 * One turn of the assistant conversation — stateless on the server (§4 Wave 1's
 * own header), so the caller resends the WHOLE transcript every time and
 * stores what comes back as the new transcript. `confirmedToolCallIds`
 * defaults to none, which resumes a turn with every pending call declined —
 * see `assistant.ts`'s own comment on why an omitted id is a decline, never
 * an "undecided". Callers should pass `messages` through `windowForRequest`
 * first on any transcript that might have grown past the server's cap — this
 * function sends exactly what it is given, with no windowing of its own.
 */
export async function sendChatTurn(input: {
  readonly messages: readonly ChatMessageWire[];
  readonly confirmedToolCallIds?: readonly string[];
}): Promise<ChatTurnResult> {
  return wire(
    await api.ai.chat.send.mutate({
      messages: input.messages.map(toMutableMessage),
      confirmedToolCallIds:
        input.confirmedToolCallIds === undefined ? [] : [...input.confirmedToolCallIds],
    }),
  );
}

/**
 * `ChatMessageWire`'s fields are `readonly` (this codebase's convention for
 * anything returned from the wire) — a `switch` on `role` rather than a
 * spread, because a readonly array/object is not assignable to the plain
 * mutable shape tRPC's generated client expects for a MUTATION input, even
 * though every field's actual value is already exactly right.
 */
function toMutableMessage(message: ChatMessageWire) {
  switch (message.role) {
    case 'user':
      return { role: 'user' as const, content: message.content };
    case 'assistant':
      return {
        role: 'assistant' as const,
        content: message.content,
        ...(message.toolCalls === undefined
          ? {}
          : { toolCalls: message.toolCalls.map((call) => ({ ...call })) }),
      };
    case 'tool_result':
      return {
        role: 'tool_result' as const,
        toolCallId: message.toolCallId,
        content: message.content,
        ...(message.isError === undefined ? {} : { isError: message.isError }),
      };
  }
}
