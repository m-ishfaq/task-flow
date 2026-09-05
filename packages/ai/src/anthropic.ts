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
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
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

function systemPromptOf(messages: readonly AiMessage[]): string | undefined {
  const systemMessages = messages.filter((message) => SYSTEM_ROLE_MESSAGES.has(message.role));
  if (systemMessages.length === 0) return undefined;
  // Joined rather than only-the-first: a caller composing a system prompt
  // from several sources (a base persona plus a per-request addendum) should
  // not have the second one silently dropped.
  return systemMessages.map((message) => message.content).join('\n\n');
}

function nonSystemMessagesOf(
  messages: readonly AiMessage[],
): readonly { readonly role: 'user' | 'assistant'; readonly content: string }[] {
  return messages
    .filter(
      (message): message is AiMessage & { role: 'user' | 'assistant' } =>
        !SYSTEM_ROLE_MESSAGES.has(message.role),
    )
    .map((message) => ({ role: message.role, content: message.content }));
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
