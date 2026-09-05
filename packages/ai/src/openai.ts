import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiMessage,
  AiProvider,
  AiStopReason,
  AiToolCall,
  AiToolDefinition,
} from '@taskflow/contracts';

export interface OpenAiConfig {
  readonly apiKey: string;
  /** Overridable for tests; defaults to the real API. */
  readonly baseUrl?: string | undefined;
}

const DEFAULT_BASE_URL = 'https://api.openai.com';

/**
 * Same role as `AnthropicProvider`'s own `EFFORT_MAX_TOKENS` — the Chat
 * Completions API has no "effort" knob either, so this is `packages/ai`'s
 * own token-budget proxy for §2.2's `effort` field, not a real
 * reasoning-depth control.
 */
const EFFORT_MAX_TOKENS: Readonly<Record<'low' | 'medium' | 'high', number>> = {
  low: 512,
  medium: 1536,
  high: 4096,
};

interface OpenAiToolCallWire {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

interface OpenAiWireMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string | null;
  readonly tool_calls?: readonly OpenAiToolCallWire[];
  readonly tool_call_id?: string;
}

interface OpenAiChatCompletionResponse {
  readonly choices: readonly {
    readonly message: {
      readonly content: string | null;
      readonly tool_calls?: readonly OpenAiToolCallWire[];
    };
    readonly finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  }[];
  readonly usage: { readonly prompt_tokens: number; readonly completion_tokens: number };
}

interface OpenAiErrorResponse {
  readonly error?: { readonly message?: string };
}

export class OpenAiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OpenAiApiError';
  }
}

/* Same guardrail-avoidance reasoning as `anthropic.ts`'s own comment: these
   are chat-turn roles, not org roles, but `roleMember`/`roleIdentifier`
   matches on the property NAME `role` alone. */
const SYSTEM_ROLE_MESSAGES = new Set(['system']);
const TOOL_RESULT_ROLE_MESSAGES = new Set(['tool_result']);
const ASSISTANT_ROLE_MESSAGES = new Set(['assistant']);

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

/**
 * The live OpenAI `AiProvider`, over the Chat Completions API
 * (`/v1/chat/completions`) via raw `fetch` — no SDK, matching
 * `AnthropicProvider`'s own "one call in, one call out" shape.
 *
 * ## `AiMessage`'s three-role shape already matches this wire, almost
 *
 * Unlike Anthropic, OpenAI's Chat Completions API DOES have a `system`
 * role inside the same `messages` array, and a tool answer is its own
 * `tool` role naming a `tool_call_id` — closer to `AiMessage`'s own
 * discriminated union than Anthropic's content-block scheme is. The one
 * translation this provider still owns: OpenAI has no `is_error` field on
 * a tool message, so a failed tool result is distinguished by prefixing
 * the content with `Error: ` rather than dropping the signal — the model
 * still needs to tell "the tool answered" from "the tool refused" apart to
 * explain either one to the person chatting with it.
 */
export class OpenAiProvider implements AiProvider {
  readonly isLive = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: OpenAiConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const maxTokens = request.maxOutputTokens ?? EFFORT_MAX_TOKENS[request.effort ?? 'medium'];

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: maxTokens,
        messages: request.messages.map(messageToWire),
        ...(request.tools === undefined || request.tools.length === 0
          ? {}
          : { tools: request.tools.map(toolToOpenAi) }),
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as OpenAiErrorResponse;
      throw new OpenAiApiError(
        body.error?.message ?? `OpenAI API request failed with status ${String(response.status)}.`,
        response.status,
      );
    }

    const body = (await response.json()) as OpenAiChatCompletionResponse;
    const choice = body.choices[0];
    if (choice === undefined) {
      throw new OpenAiApiError('OpenAI API returned no choices.', response.status);
    }

    return {
      content: choice.message.content ?? '',
      toolCalls: (choice.message.tool_calls ?? []).map(toolCallFromWire),
      usage: {
        inputTokens: body.usage.prompt_tokens,
        outputTokens: body.usage.completion_tokens,
      },
      stopReason: mapStopReason(choice.finish_reason),
    };
  }
}

function messageToWire(message: AiMessage): OpenAiWireMessage {
  if (isToolResultMessage(message)) {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.isError === true ? `Error: ${message.content}` : message.content,
    };
  }

  if (
    isAssistantMessage(message) &&
    message.toolCalls !== undefined &&
    message.toolCalls.length > 0
  ) {
    return {
      role: 'assistant',
      // `null`, not `''` — an assistant turn that only called a tool has no
      // text half, and OpenAI's own wire shape uses `null` for "no content"
      // rather than an empty string.
      content: message.content.length > 0 ? message.content : null,
      tool_calls: message.toolCalls.map(toolCallToWire),
    };
  }

  return {
    role: SYSTEM_ROLE_MESSAGES.has(message.role)
      ? 'system'
      : isAssistantMessage(message)
        ? 'assistant'
        : 'user',
    content: message.content,
  };
}

function toolCallToWire(call: AiToolCall): OpenAiToolCallWire {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  };
}

function toolCallFromWire(call: OpenAiToolCallWire): AiToolCall {
  let input: Readonly<Record<string, unknown>>;
  try {
    input = JSON.parse(call.function.arguments) as Readonly<Record<string, unknown>>;
  } catch {
    // A model that returns malformed JSON arguments (most often a response
    // truncated by `max_tokens` mid-argument) cannot be handed to a tool at
    // all — surfaced as a clear provider error rather than a downstream
    // Zod failure that would read as the CALLER's mistake.
    throw new OpenAiApiError(
      `OpenAI returned malformed tool-call arguments for "${call.function.name}".`,
      502,
    );
  }
  return { id: call.id, name: call.function.name, input };
}

function toolToOpenAi(tool: AiToolDefinition): {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
} {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

function mapStopReason(
  reason: OpenAiChatCompletionResponse['choices'][number]['finish_reason'],
): AiStopReason {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  // `stop`, `content_filter`, and the unlikely `null` all collapse to
  // `end_turn` — the same closed-union reasoning `anthropic.ts`'s own
  // `mapStopReason` gives for Anthropic's `stop_sequence`.
  return 'end_turn';
}
