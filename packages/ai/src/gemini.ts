import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiMessage,
  AiProvider,
  AiStopReason,
  AiToolCall,
  AiToolDefinition,
} from '@taskflow/contracts';

export interface GeminiConfig {
  readonly apiKey: string;
  /** Overridable for tests; defaults to the real API. */
  readonly baseUrl?: string | undefined;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

/** Same role as the other two providers' own effort-to-token-ceiling maps. */
const EFFORT_MAX_TOKENS: Readonly<Record<'low' | 'medium' | 'high', number>> = {
  low: 512,
  medium: 1536,
  high: 4096,
};

interface GeminiPart {
  readonly text?: string;
  readonly functionCall?: {
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
  };
  readonly functionResponse?: {
    readonly name: string;
    readonly response: Readonly<Record<string, unknown>>;
  };
}

interface GeminiContent {
  readonly role: 'user' | 'model';
  readonly parts: readonly GeminiPart[];
}

interface GeminiGenerateContentResponse {
  readonly candidates: readonly {
    readonly content?: { readonly parts: readonly GeminiPart[] };
    readonly finishReason?: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER';
  }[];
  readonly usageMetadata: {
    readonly promptTokenCount: number;
    readonly candidatesTokenCount?: number;
  };
}

interface GeminiErrorResponse {
  readonly error?: { readonly message?: string };
}

export class GeminiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GeminiApiError';
  }
}

/* Same guardrail-avoidance reasoning as `anthropic.ts`/`openai.ts`: chat-turn
   roles, not org roles, but the selector matches on the NAME `role` alone. */
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
 * Encodes which tool NAME a synthesized `AiToolCall.id` stands for. Gemini
 * is the one provider of the three with no call-id concept at all — a
 * function call and its answering `functionResponse` are matched by NAME,
 * not by an opaque id the provider mints. `AiToolCall.id` is required by
 * the shared `AiProvider` interface (the tool-execution loop in
 * `apps/api/src/ai/assistant.ts` treats it as opaque and echoes it back
 * verbatim on the `tool_result` message), so this provider manufactures one
 * by encoding the name INTO the id, and decodes it again when it needs to
 * build the `functionResponse` part for the wire. `::` cannot appear in a
 * function/tool name (the tool registry's own names are identifiers), so
 * splitting on the first occurrence is unambiguous.
 */
function encodeCallId(name: string, index: number): string {
  return `${name}::${String(index)}`;
}

function decodeCallName(id: string): string {
  const separatorIndex = id.indexOf('::');
  return separatorIndex === -1 ? id : id.slice(0, separatorIndex);
}

/**
 * The live Gemini `AiProvider`, over the `generateContent` REST endpoint via
 * raw `fetch` — no SDK, matching the other two providers' shape. The API
 * key travels as the `x-goog-api-key` header rather than the `?key=`
 * query-string form Google's own docs lead with — a secret does not belong
 * in a URL that ends up in access logs and proxy history, the same reason
 * this codebase never puts one in a query string anywhere else.
 *
 * ## Three shape differences from the other two providers
 *
 * `system` is pulled out into a top-level `systemInstruction`, matching how
 * `AnthropicProvider` pulls it into a top-level `system` field for the
 * identical reason: Gemini's `contents` array has only `user`/`model`
 * roles, no `system` role at all.
 *
 * A tool result is a `functionResponse` PART inside a `user`-role content
 * entry, not a distinct role the way OpenAI's `tool` role is — Gemini has
 * no third role either.
 *
 * `stopReason` cannot be read off `finishReason` alone: Gemini often
 * reports `STOP` even on a turn that also asked for a tool call, unlike
 * Anthropic/OpenAI, which both use a dedicated finish/stop reason for that
 * case. Whether the model wants a tool is read from the PARTS themselves —
 * any `functionCall` part means `tool_use`, checked before `finishReason`
 * is even consulted.
 */
export class GeminiProvider implements AiProvider {
  readonly isLive = true;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: GeminiConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const system = systemPromptOf(request.messages);
    const contents = request.messages
      .filter((m) => !SYSTEM_ROLE_MESSAGES.has(m.role))
      .map(toContent);
    const maxOutputTokens =
      request.maxOutputTokens ?? EFFORT_MAX_TOKENS[request.effort ?? 'medium'];

    const response = await fetch(
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents,
          ...(system === undefined ? {} : { systemInstruction: { parts: [{ text: system }] } }),
          generationConfig: { maxOutputTokens },
          ...(request.tools === undefined || request.tools.length === 0
            ? {}
            : { tools: [{ functionDeclarations: request.tools.map(toolToGemini) }] }),
        }),
      },
    );

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as GeminiErrorResponse;
      throw new GeminiApiError(
        body.error?.message ?? `Gemini API request failed with status ${String(response.status)}.`,
        response.status,
      );
    }

    const body = (await response.json()) as GeminiGenerateContentResponse;
    const candidate = body.candidates[0];
    if (candidate === undefined) {
      throw new GeminiApiError('Gemini API returned no candidates.', response.status);
    }

    const parts = candidate.content?.parts ?? [];
    const toolCalls = parts
      .map((part, index) => (part.functionCall === undefined ? undefined : { part, index }))
      .filter((entry): entry is { part: GeminiPart; index: number } => entry !== undefined)
      .map(({ part, index }) => toolCallFromPart(part, index));

    return {
      content: parts
        .filter((part) => part.text !== undefined)
        .map((part) => part.text ?? '')
        .join(''),
      toolCalls,
      usage: {
        inputTokens: body.usageMetadata.promptTokenCount,
        outputTokens: body.usageMetadata.candidatesTokenCount ?? 0,
      },
      stopReason: toolCalls.length > 0 ? 'tool_use' : mapStopReason(candidate.finishReason),
    };
  }
}

function systemPromptOf(messages: readonly AiMessage[]): string | undefined {
  const systemMessages = messages.filter((message) => SYSTEM_ROLE_MESSAGES.has(message.role));
  if (systemMessages.length === 0) return undefined;
  return systemMessages.map((message) => message.content).join('\n\n');
}

function toContent(message: AiMessage): GeminiContent {
  if (isToolResultMessage(message)) {
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: decodeCallName(message.toolCallId),
            response:
              message.isError === true ? { error: message.content } : { result: message.content },
          },
        },
      ],
    };
  }

  if (
    isAssistantMessage(message) &&
    message.toolCalls !== undefined &&
    message.toolCalls.length > 0
  ) {
    const parts: GeminiPart[] = [];
    if (message.content.length > 0) parts.push({ text: message.content });
    for (const call of message.toolCalls) {
      parts.push({ functionCall: { name: call.name, args: call.input } });
    }
    return { role: 'model', parts };
  }

  return {
    role: isAssistantMessage(message) ? 'model' : 'user',
    parts: [{ text: message.content }],
  };
}

function toolCallFromPart(part: GeminiPart, index: number): AiToolCall {
  const functionCall = part.functionCall;
  if (functionCall === undefined) {
    throw new GeminiApiError('Expected a functionCall part.', 502);
  }
  return {
    id: encodeCallId(functionCall.name, index),
    name: functionCall.name,
    input: functionCall.args,
  };
}

function toolToGemini(tool: AiToolDefinition): {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
} {
  return { name: tool.name, description: tool.description, parameters: tool.inputSchema };
}

function mapStopReason(
  reason: GeminiGenerateContentResponse['candidates'][number]['finishReason'],
): AiStopReason {
  if (reason === 'MAX_TOKENS') return 'max_tokens';
  // `STOP`, `SAFETY`, `RECITATION`, `OTHER`, and the unlikely `undefined`
  // all collapse to `end_turn` — the same closed-union reasoning the other
  // two providers' own `mapStopReason` gives for their own extra reasons.
  return 'end_turn';
}
