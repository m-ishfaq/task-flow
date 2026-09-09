import { errors, type AiMessage, type AiProvider, type AiToolCall } from '@taskflow/contracts';
import { completeGated, type AiCompletionActor } from './complete.js';
import { toAiToolDefinition, type ToolContext, type ToolDefinition } from './tools/index.js';

/**
 * The tool-calling assistant loop (ai/phase-15-ai-copilot-and-permissions.md
 * §4.1). Wave 2 (§4.3) adds confirm-before-execute (§4.2): a tool whose
 * `ToolDefinition.requiresConfirmation` is `true` never runs on the same
 * round the model requested it.
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
 *
 * ## Confirm-before-execute needs no server-side state at all
 *
 * When a round's tool calls include one that requires confirmation, NONE of
 * that round's calls run — the model's assistant turn (its text plus the
 * requested `toolCalls`) is appended to the returned transcript and the
 * function returns immediately with `pendingToolCalls` set, before calling
 * `completeGated` again. Nothing is persisted: the pending state IS the
 * transcript the caller already received and will resend. The caller
 * resumes by sending that same transcript back, verbatim, with
 * `confirmedToolCallIds` naming which of the pending calls a human actually
 * approved — checked here as a PRE-LOOP step, purely by inspecting whether
 * the transcript's last message is an unresolved assistant tool-call turn,
 * because that shape can only ever exist as this function's own deferred
 * return value (every OTHER path appends matching `tool_result` turns
 * before returning or continuing). A call not named in
 * `confirmedToolCallIds` is treated as declined, not merely unconfirmed —
 * defaulting an omitted id to "run it anyway" would make a client bug the
 * same as a human's "yes."
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
  /**
   * Which of a PRIOR call's `pendingToolCalls` a human has approved to run
   * now. Only meaningful when `messages` ends in an unresolved assistant
   * tool-call turn (see this file's header); ignored otherwise, so a caller
   * with nothing pending can always pass `[]`. A call whose id is not
   * listed is treated as declined, never as "not yet decided."
   */
  readonly confirmedToolCallIds?: readonly string[];
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
  /**
   * Set when the turn stopped because a requested tool call needs §4.2
   * confirmation — none of these ran. Absent (never an empty array) means
   * the turn completed normally; a caller checks for presence, not length.
   */
  readonly pendingToolCalls?: readonly AiToolCall[];
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

  // Refuses a malformed transcript before it can reach the provider — see
  // `assertWellFormedTranscript`'s own header.
  assertWellFormedTranscript(input.messages);

  // Resuming a §4.2 confirmation, not a fresh turn — see this file's header
  // for why an unresolved trailing assistant tool-call turn is unambiguous.
  const pending = pendingCallsIn(input.messages);
  if (pending !== undefined) {
    const confirmed = new Set(input.confirmedToolCallIds ?? []);
    const resolutions: AiMessage[] = [];
    for (const call of pending) {
      resolutions.push(
        confirmed.has(call.id)
          ? await runTool(byName, toolCtx, call)
          : {
              role: 'tool_result',
              toolCallId: call.id,
              content: 'The user declined to run this action.',
              isError: true,
            },
      );
    }
    transcript = [...transcript, ...resolutions];
    working = [...working, ...resolutions];
  }

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

    // §4.2: if ANY call this round names a tool requiring confirmation, NONE
    // of this round's calls run yet — deferred as one group, so a human
    // reviews the whole batch rather than half of it having already
    // happened by the time they see the prompt.
    const needsConfirmation = result.toolCalls.some(
      (call) => byName.get(call.name)?.requiresConfirmation === true,
    );
    if (needsConfirmation) {
      return {
        content: result.content,
        messages: [...transcript, assistantTurn],
        toolRounds: round,
        pendingToolCalls: result.toolCalls,
      };
    }

    // Sequential, not `Promise.all` — a write tool's ordering must not
    // depend on which of several concurrent promises the runtime happens to
    // settle first.
    const toolResults: AiMessage[] = [];
    for (const call of result.toolCalls) {
      toolResults.push(await runTool(byName, toolCtx, call));
    }

    transcript = [...transcript, assistantTurn, ...toolResults];
    working = [...working, assistantTurn, ...toolResults];
  }

  throw new AssistantLoopExceededError();
}

/* Membership test, not `=== 'assistant'` — deliberately, not a style
   preference. `packages/config/eslint/security.js`'s `roleMember` guardrail
   bans any `===`/`!==` comparison naming a `.role` property, on the theory
   that the shape is almost always an inline org-role check drifting from
   `can()`. `AiMessage.role` is a chat turn's speaker, a different concept
   entirely, but the selector matches on NAME, not semantics — the same
   collision `anthropic.ts`'s own `.has()` fix documents. */
const ASSISTANT_ROLE_MESSAGES = new Set(['assistant']);
const TOOL_RESULT_ROLE_MESSAGES = new Set(['tool_result']);

/**
 * Guards against a malformed transcript reaching the provider: an assistant
 * tool-calls turn with no matching `tool_result` anywhere after it, other
 * than the one legitimate case — the trailing turn a caller is resuming
 * (handled by `pendingCallsIn`/the resume block right after this runs,
 * which always resolves every one of ITS calls before the provider is ever
 * called again). Forwarding an otherwise-unresolved turn straight through
 * produces an opaque, provider-specific 400 ("tool_call_ids did not have
 * response messages") that gives neither caller nor operator anything to
 * act on; refusing it here, with a message naming the actual defect, turns
 * that into an ordinary `VALIDATION_FAILED`.
 *
 * Found from a real transcript: `apps/web`'s `respondToPending` cleared
 * `pendingToolCalls` (and therefore re-enabled the composer) SYNCHRONOUSLY,
 * before its own resume request had resolved — a real race that let a new
 * user message get sent, and appended to the LOCAL transcript, while the
 * still-unresolved confirmation turn from the request already in flight sat
 * one message before it. `pendingCallsIn` only ever looks at the LAST
 * message, so it had no way to see the earlier, still-dangling one, and the
 * malformed shape sailed straight through to OpenAI. The client fix closes
 * the race; this is the server refusing to forward the shape at all if a
 * client — this one after a fix, a different one, or a future regression —
 * ever produces it again.
 */
function assertWellFormedTranscript(messages: readonly AiMessage[]): void {
  for (let i = 0; i < messages.length - 1; i += 1) {
    const message = messages[i];
    if (message === undefined) continue;
    if (!ASSISTANT_ROLE_MESSAGES.has(message.role)) continue;
    if (
      !('toolCalls' in message) ||
      message.toolCalls === undefined ||
      message.toolCalls.length === 0
    ) {
      continue;
    }

    const answeredIds = new Set(
      messages
        .slice(i + 1)
        .filter((candidate) => TOOL_RESULT_ROLE_MESSAGES.has(candidate.role))
        .map((candidate) => (candidate as Extract<AiMessage, { role: 'tool_result' }>).toolCallId),
    );
    const missing = message.toolCalls.filter((call) => !answeredIds.has(call.id));
    if (missing.length > 0) {
      throw errors.validation(
        {
          messages: [
            `Message ${String(i)} requests ${String(missing.length)} tool call(s) with no matching response later in the conversation.`,
          ],
        },
        'This conversation is malformed — a tool call is missing its response.',
      );
    }
  }
}

/**
 * The transcript's own shape tells us whether it ends in an unresolved
 * §4.2 confirmation: only a DEFERRED return ever leaves an assistant
 * tool-call turn with no matching `tool_result` turns after it — every
 * other path in this file appends them before returning or looping.
 * `undefined` means nothing is pending; a fresh conversation's plain `user`
 * last message never matches.
 */
function pendingCallsIn(messages: readonly AiMessage[]): readonly AiToolCall[] | undefined {
  const last = messages.at(-1);
  if (last === undefined) return undefined;
  if (!ASSISTANT_ROLE_MESSAGES.has(last.role)) return undefined;
  if (!('toolCalls' in last)) return undefined;
  if (last.toolCalls === undefined || last.toolCalls.length === 0) return undefined;
  return last.toolCalls;
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
