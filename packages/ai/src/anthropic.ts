import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiMessage,
  AiProvider,
  AiStopReason,
  AiToolCall,
  AiToolDefinition,
} from '@taskflow/contracts';

export interface AnthropicConfig {
  readonly apiKey: string;
  /** Overridable for tests; defaults to the real API. */
  readonly baseUrl?: string | undefined;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Default output ceiling by `effort`, used only when the caller did not set
 * `maxOutputTokens` explicitly. Anthropic's Messages API has no generic
 * "effort" knob on this endpoint — this is `packages/ai`'s own
 * simplification of §2.2's `effort` field, a token-budget proxy rather than
 * a real reasoning-depth control. A model that later exposes one directly
 * (extended thinking budgets) gets a real implementation without touching
 * `AiProvider`'s own shape.
 */
const EFFORT_MAX_TOKENS: Readonly<Record<'low' | 'medium' | 'high', number>> = {
  low: 512,
  medium: 1536,
  high: 4096,
};

interface AnthropicContentBlock {
  readonly type: 'text' | 'tool_use';
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

interface AnthropicMessageResponse {
  readonly content: readonly AnthropicContentBlock[];
  readonly stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

interface AnthropicErrorResponse {
  readonly error?: { readonly type?: string; readonly message?: string };
}

export class AnthropicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AnthropicApiError';
  }
}

/** The wire shape of one entry in Anthropic's `messages` array. */
interface AnthropicWireMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly AnthropicWireContentBlock[];
}

type AnthropicWireContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> }
  | { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string; readonly is_error?: boolean };

/**
 * The live `AiProvider` (Phase 15 §2.2). Thin wrapper over the Messages API
 * via `fetch` directly — no SDK dependency, matching `StripePaymentProvider`'s
 * own "one call in, one call out" shape, and keeping this package's
 * dependency surface to what `packages/security`'s own audit already covers
 * plus nothing else.
 *
 * `system` is pulled out of `messages` into its own top-level field, because
 * Anthropic's API — unlike the OpenAI-style shape `AiMessage`'s three-role
 * union is written to look familiar against — has no `system` role inside
 * the message array at all; a system-role entry left in `messages` would be
 * a 400 from the real API that the fake would never catch, since the fake
 * never validates roles it does not itself define semantics for.
 *
 * ## Tool calls round-trip as CONTENT BLOCKS, never as text
 *
 * §4's tool-calling assistant needs a multi-turn conversation to survive
 * past the first tool call, and Anthropic's API enforces this at the wire
 * level: an assistant turn's `tool_use` block MUST be followed, in the very
 * next turn, by a `tool_result` block naming the same id — a caller that
 * flattened either into plain text gets a 400 on the second turn, the first
 * time anyone actually tries a follow-up question. `messageToWire` below is
 * where `AiMessage`'s discriminated union becomes those blocks.
 */
export class AnthropicProvider implements AiProvider {
  readonly isLive = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: AnthropicConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const system = systemPromptOf(request.messages);
    const messages = nonSystemMessagesOf(request.messages);
    const maxTokens =
      request.maxOutputTokens ?? EFFORT_MAX_TOKENS[request.effort ?? 'medium'];

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: maxTokens,
        messages,
        ...(system === undefined ? {} : { system }),
        ...(request.tools === undefined || request.tools.length === 0
          ? {}
          : { tools: request.tools.map(toolToAnthropic) }),
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as AnthropicErrorResponse;
      throw new AnthropicApiError(
        body.error?.message ?? `Anthropic API request failed with status ${String(response.status)}.`,
        response.status,
      );
    }

    const body = (await response.json()) as AnthropicMessageResponse;
    return {
      content: body.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join(''),
      toolCalls: body.content.filter(isToolUseBlock).map(toolCallFromBlock),
      usage: {
        inputTokens: body.usage.input_tokens,
        outputTokens: body.usage.output_tokens,
      },
      stopReason: mapStopReason(body.stop_reason),
    };
  }
}

/* Membership lookups rather than `message.role === 'system'` comparisons —
   deliberately, not a style preference. `packages/config/eslint/security.js`'s
   `roleMember`/`roleIdentifier` guardrails ban any `===`/`!==` touching a
   property or bare identifier literally named `role`, because that shape is
   almost always an inline MEMBERSHIP-role check drifting from `can()`'s
   tested matrix (guardrail 7, §8.2). `AiMessage.role` is a different
   concept entirely — a chat turn's speaker, never an org role — but the
   selector matches on NAME, not semantics, so it fires here too. A `Set`
   membership test is both the correct fix (no bypass needed) and, per
   CLAUDE.md's own rule, the required one: "never disable a guardrail
   inline; fix the code." */
const SYSTEM_ROLE_MESSAGES = new Set(['system']);
const TOOL_RESULT_ROLE_MESSAGES = new Set(['tool_result']);
const ASSISTANT_ROLE_MESSAGES = new Set(['assistant']);

function systemPromptOf(messages: readonly AiMessage[]): string | undefined {
  const systemMessages = messages.filter((message) => SYSTEM_ROLE_MESSAGES.has(message.role));
  if (systemMessages.length === 0) return undefined;
  // Joined rather than only-the-first: a caller composing a system prompt
  // from several sources (a base persona plus a per-request addendum) should
  // not have the second one silently dropped.
  return systemMessages.map((message) => message.content).join('\n\n');
}

function nonSystemMessagesOf(messages: readonly AiMessage[]): readonly AnthropicWireMessage[] {
  return messages
    .filter((message) => !SYSTEM_ROLE_MESSAGES.has(message.role))
    .map(messageToWire);
}

/**
 * `AiMessage`'s discriminated union -> one Anthropic wire message.
 *
 * `tool_result` is the one case that changes ROLE: Anthropic has no
 * `tool_result` role at all — a tool answer is a `user` turn carrying a
 * `tool_result` content block, which is why `AiMessage`'s own `tool_result`
 * variant is a distinct role from this provider's perspective but not from
 * the wire's.
 */
function isToolResultMessage(
  message: AiMessage,
): message is Extract<AiMessage, { role: 'tool_result' }> {
  return TOOL_RESULT_ROLE_MESSAGES.has(message.role);
}

function isAssistantMessage(
  message: AiMessage,
): message is Extract<AiMessage, { role: 'assistant' }> {
  return ASSISTANT_ROLE_MESSAGES.has(message.role);
}

function messageToWire(message: AiMessage): AnthropicWireMessage {
  if (isToolResultMessage(message)) {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          ...(message.isError === undefined ? {} : { is_error: message.isError }),
        },
      ],
    };
  }

  if (isAssistantMessage(message) && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    const blocks: AnthropicWireContentBlock[] = [];
    // An empty text block reads as the model "saying nothing" before its
    // tool call, which some providers reject outright — omitted rather than
    // sent as `{ type: 'text', text: '' }`.
    if (message.content.length > 0) blocks.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }
    return { role: 'assistant', content: blocks };
  }

  // `user` message, or a plain `assistant` reply with no tool calls — both
  // are just plain text on the wire.
  return { role: isAssistantMessage(message) ? 'assistant' : 'user', content: message.content };
}

function toolToAnthropic(tool: AiToolDefinition): {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
} {
  return { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
}

function isToolUseBlock(
  block: AnthropicContentBlock,
): block is AnthropicContentBlock & { id: string; name: string; input: Readonly<Record<string, unknown>> } {
  return block.type === 'tool_use';
}

function toolCallFromBlock(block: {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}): AiToolCall {
  return { id: block.id, name: block.name, input: block.input };
}

function mapStopReason(reason: AnthropicMessageResponse['stop_reason']): AiStopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  // `stop_sequence` and `end_turn` (and the unlikely `null`, a response cut
  // off before the API assigned one) all collapse to `end_turn` — this
  // interface's closed union deliberately does not carry a fourth member for
  // "hit a custom stop sequence", since no caller in this codebase sets one
  // yet and inventing the distinction ahead of a consumer is a guess.
  return 'end_turn';
}
