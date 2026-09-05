import type { OrgId } from '../ids.js';

/**
 * AiProvider — the LLM carrier boundary (Phase 15 §2,
 * ai/phase-15-ai-copilot-and-permissions.md).
 *
 * Same seam as `TelephonyProvider` and `PaymentProvider`: the interface pins
 * behavior, and every call site in `apps/api/src/ai` is written against
 * these members only — never against an SDK directly, the identical
 * discipline that keeps `pg` out of everywhere but `packages/db`. A second
 * model provider is a new implementation of this interface, never a
 * call-site change.
 *
 * ## What makes this provider different from the other five
 *
 * Every other `*Provider` interface moves data the org already agreed to
 * hand a third party (payment details to a processor, an SMS to a carrier).
 * This one moves org-authored CONTENT — card text, chat messages, comments —
 * to a model provider whose only job is to read it and answer. That is why
 * `packages/ai` is a human-review surface (CLAUDE.md) even though the shape
 * of the interface is unremarkable: the risk is not in the plumbing, it is
 * in what gets put on the wire, and that is a call-site decision this
 * interface cannot make for its caller. Nothing here decides WHAT an
 * `AiCompletionRequest` may contain — that is `apps/api/src/ai`'s job, the
 * same way `packages/telephony` never decides which destinations are
 * allowed.
 *
 * ## No streaming, on purpose, for Wave 1
 *
 * `complete` returns the whole result at once. Streaming is a real UX
 * improvement for a chat surface, and a real complication for a spend gate
 * that must know the final token count before it can be trusted — a
 * provider that streamed would need its OWN interim accounting, which is
 * exactly the kind of thing `sumWithFallback`'s comment warns about:
 * "unreconciled" and "free" must never be the same state. Non-streaming
 * first, matching how `packages/telephony`'s `placeCall` returns once the
 * carrier has actually answered rather than reporting ringing as complete.
 */

/**
 * One turn in a conversation. A discriminated union, not a flat
 * `{ role, content }`, because a tool-calling conversation (Phase 15 §4) has
 * two shapes plain text cannot represent: an assistant turn that REQUESTED
 * tools alongside (or instead of) talking, and a turn that answers one of
 * those requests. Both must round-trip back to the provider byte-for-byte —
 * Anthropic's API rejects a `tool_use` content block with no matching
 * `tool_result` in the very next turn — so this is not a convenience type,
 * it is the minimum shape a caller needs to continue the conversation at
 * all after the first tool call.
 *
 * `system` is a distinct role, not a message the model can be asked to
 * imitate.
 */
export type AiMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      /** Present exactly when this turn's `AiCompletionResult.stopReason`
          was `tool_use` — replayed verbatim so the provider sees the SAME
          request it made, not a caller's reconstruction of it. */
      readonly toolCalls?: readonly AiToolCall[] | undefined;
    }
  | {
      /** THE answer to one `AiToolCall` from the immediately preceding
          assistant turn — never a role a caller invents on its own. */
      readonly role: 'tool_result';
      readonly toolCallId: string;
      readonly content: string;
      /** Set when the tool itself failed (not "found nothing" — an actual
          error) so the model can react to that distinctly from a result. */
      readonly isError?: boolean | undefined;
    };

/**
 * One tool the model may call. `inputSchema` is a JSON Schema object, not a
 * Zod schema — the wire format every model provider's tool-calling API
 * actually speaks. `apps/api/src/ai`'s own tool registry is the Zod-typed
 * source of truth; this is what gets serialized out of it per request.
 */
export interface AiToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * One invocation the model is REQUESTING, not one that has happened.
 * `apps/api/src/ai`'s tool-execution loop is what turns this into a real
 * `can()`-checked service call — see §4.1's "always acts as the person
 * chatting with it," which this type has no way to enforce on its own.
 */
export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface AiCompletionRequest {
  /**
   * For redaction/logging/spend attribution — never sent to the provider as
   * part of the prompt. Mirrors `TelephonyProvider`'s subaccount-per-org
   * boundary in spirit, though this interface has no per-org credential of
   * its own (§2.3: keys are global-or-per-org CONFIG, not a subaccount the
   * provider mints).
   */
  readonly orgId: OrgId;
  readonly model: string;
  readonly messages: readonly AiMessage[];
  readonly tools?: readonly AiToolDefinition[] | undefined;
  /**
   * A hint, not a token budget — some providers expose a reasoning-depth
   * knob distinct from `maxOutputTokens`. Absent means "the provider's own
   * default," never "unlimited."
   */
  readonly effort?: 'low' | 'medium' | 'high' | undefined;
  readonly maxOutputTokens?: number | undefined;
}

export type AiStopReason = 'end_turn' | 'tool_use' | 'max_tokens';

export interface AiCompletionResult {
  /** The model's own text. Empty when `stopReason` is `tool_use` and it asked for a tool instead of talking. */
  readonly content: string;
  readonly toolCalls: readonly AiToolCall[];
  /**
   * Integers, always present — never estimated after the fact. This is what
   * `platform.ai_usage_ledger` prices, the identical `actualCents` role
   * `comms.spend_ledger` gives a reconciled telephony row, except here the
   * provider reports it INLINE rather than by a later webhook, so there is
   * no `estimatedCents`/`actualCents` split to begin with — see §3.1.
   */
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly stopReason: AiStopReason;
}

export interface AiProvider {
  /**
   * Whether this instance is wired to a credential that reaches a real model
   * and costs real money — the same reasoning `PaymentProvider.isLive` and
   * `TelephonyProvider.isLive` give: a test asserting "the provider was
   * never reached" needs to prove it was talking to a fake, not trust that
   * it was.
   */
  readonly isLive: boolean;

  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}
