import type { AiMessage, AiProvider, AiToolCall } from '@taskflow/contracts';
import { completeGated, type AiCompletionActor } from './complete.js';
import { toAiToolDefinition, type ToolContext, type ToolDefinition } from './tools/index.js';

/**
 * The tool-calling assistant loop (ai/phase-15-ai-copilot-and-permissions.md
 * §4.1) — Wave 1 (§4.3): read-only tools only, no confirm-before-execute
 * yet (§4.2 applies once a write tool joins the registry).
 *
 * ## Every completion still goes through `completeGated`
 *
 * This loop calls the model possibly several times (once per tool round),
 * and EVERY one of those calls is a real, budget-gated, ledger-recorded
 * completion — there is no "free" intermediate call just because the
 * conversation has not finished. A five-round tool-calling exchange is five
 * rows in `ai.usage_ledger`, not one.
 *
 * ## The bound exists because a tool-calling loop can genuinely spin
 *
 * A model that keeps requesting tools (its own retry logic, a
 * misunderstanding, a tool that keeps returning something it interprets as
 * "try again") would otherwise run until the budget gate finally refuses it
 * — which could be many turns into a single user-facing request.
 * `MAX_TOOL_ITERATIONS` bounds the DAMAGE of that to one conversation turn,
 * the same reasoning `search.query`'s own result limit bounds a fan-out
 * rather than trusting the caller to ask reasonably.
 *
 * ## The client owns history; the server owns the system prompt
 *
 * `RunAssistantTurnInput.messages` is the caller-visible transcript so far —
 * no system message in it, ever, because a system prompt is server policy,
 * not something a caller supplies. This function prepends its own and never
 * returns it, so the caller's stored history can be resent verbatim as the
 * next turn's input without stripping anything back out.
 */

const MAX_TOOL_ITERATIONS = 6;

export interface RunAssistantTurnInput {
  /** e.g. 'assistant.chat' — see `ai.usage_ledger.feature`'s own comment. */
  readonly feature: string;
  readonly providerName: string;
  readonly model: string;
  readonly systemPrompt: string;
  /** The conversation so far, INCLUDING the new user message, EXCLUDING any
      system message. */
  readonly messages: readonly AiMessage[];
}

export interface RunAssistantTurnResult {
  readonly content: string;
  /** `input.messages` plus every turn this call produced (the assistant's
      replies and any tool_result turns) — hand this back as next call's
      `messages` to continue the conversation. */
  readonly messages: readonly AiMessage[];
  /** How many tool-calling rounds this turn actually used, for callers that
      want to surface "the assistant looked something up" in the UI. */
  readonly toolRounds: number;
}

export class AssistantLoopExceededError extends Error {
  constructor() {
    super('The assistant exceeded its maximum number of tool-calling rounds for one turn.');
    this.name = 'AssistantLoopExceededError';
  }
}

export async function runAssistantTurn(
  provider: AiProvider,
  actor: AiCompletionActor,
  toolCtx: ToolContext,
  tools: readonly ToolDefinition[],
  input: RunAssistantTurnInput,
): Promise<RunAssistantTurnResult> {
  const toolDefs = tools.map(toAiToolDefinition);
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));

  const systemMessage: AiMessage = { role: 'system', content: input.systemPrompt };
  let transcript: readonly AiMessage[] = input.messages;
  let working: readonly AiMessage[] = [systemMessage, ...input.messages];

  for (let round = 0; round < MAX_TOOL_ITERATIONS; round += 1) {
    const result = await completeGated(provider, actor, {
      feature: input.feature,
      providerName: input.providerName,
      model: input.model,
      messages: working,
      ...(toolDefs.length === 0 ? {} : { tools: toolDefs }),
    });

    if (result.stopReason !== 'tool_use' || result.toolCalls.length === 0) {
      const finalMessage: AiMessage = { role: 'assistant', content: result.content };
      return {
        content: result.content,
        messages: [...transcript, finalMessage],
        toolRounds: round,
      };
    }

    const assistantTurn: AiMessage = {
      role: 'assistant',
      content: result.content,
      toolCalls: result.toolCalls,
    };

    // Sequential, not `Promise.all` — a future write tool's ordering must
    // not depend on which of several concurrent promises the runtime
    // happens to settle first. Read-only Wave 1 pays a small latency cost
    // for a property it will need the moment Wave 2 lands.
    const toolResults: AiMessage[] = [];
    for (const call of result.toolCalls) {
      toolResults.push(await runTool(byName, toolCtx, call));
    }

    transcript = [...transcript, assistantTurn, ...toolResults];
    working = [...working, assistantTurn, ...toolResults];
  }

  throw new AssistantLoopExceededError();
}

async function runTool(
  byName: ReadonlyMap<string, ToolDefinition>,
  ctx: ToolContext,
  call: AiToolCall,
): Promise<AiMessage> {
  const tool = byName.get(call.name);
  if (tool === undefined) {
    return {
      role: 'tool_result',
      toolCallId: call.id,
      content: `Unknown tool "${call.name}".`,
      isError: true,
    };
  }

  const result = await tool.execute(ctx, call.input);
  return {
    role: 'tool_result',
    toolCallId: call.id,
    content: result.content,
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}
