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
 * One turn of the assistant conversation — stateless on the server (§4 Wave 1's
 * own header), so the caller resends the WHOLE transcript every time and
 * stores what comes back as the new transcript. `confirmedToolCallIds`
 * defaults to none, which resumes a turn with every pending call declined —
 * see `assistant.ts`'s own comment on why an omitted id is a decline, never
 * an "undecided".
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
