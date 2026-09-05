import type { z } from 'zod';
import type { AiToolDefinition, RequestId } from '@taskflow/contracts';
import type { Subject } from '@taskflow/policy';

/**
 * The assistant's tool registry (ai/phase-15-ai-copilot-and-permissions.md
 * §4.1) — a fixed, closed list, deliberately mirroring the automation
 * engine's own closed `ACTION_TYPES`. The doctrine is the same: the model
 * chooses WHICH of these to call and with what arguments, never what code
 * runs — every tool wraps a real, already-`can()`-checked call into
 * `apps/api/src/*`'s own service layer, so a member who cannot read
 * something the assistant cannot read it for them either.
 *
 * `ToolContext.subject` is the acting member's own `Subject` — never a
 * superuser identity. **The assistant always acts as the person chatting
 * with it** (§4.1); nothing in this file is the place a tool would ever
 * construct or borrow a different one.
 */

export interface ToolContext {
  readonly subject: Subject;
  /** Needed only by a write tool that builds a `WorkActor` to call a real
      `apps/api/src/work` service — carried through to the domain event's
      envelope exactly as a human's own click would set it, so the audit
      trail reads "AI, on behalf of <user>, did X," never "AI did X." */
  readonly requestId: RequestId;
}

export interface ToolResult {
  /** What the MODEL sees as the tool's answer — plain text or a compact
      JSON string, never a raw database row (this is a public boundary the
      model reasons over, with the same "least surface" instinct a route's
      own `.output()` schema applies). */
  readonly content: string;
  /** Set when the tool itself failed — a permission refusal, a not-found,
      a validation error — so the model can tell the difference between
      "here is your empty result" and "that request could not be served",
      and explain the latter to the person rather than presenting it as
      data. */
  readonly isError?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema, the wire format every tool-calling model API speaks —
      hand-written per tool rather than derived from `inputSchema`, so the
      registry owes no dependency on a Zod-to-JSON-Schema converter for a
      handful of tools. */
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  /**
   * §4.2's confirm-before-execute gate. A REQUIRED field on every tool,
   * deliberately not defaulted — the same reasoning `guardrail 6`'s
   * event-per-mutation lint rule gives for not defaulting a domain event: a
   * new write tool that forgot to set this should fail to compile, not
   * silently inherit whatever the last tool in the file happened to choose.
   * `true` means `assistant.ts`'s loop defers the ENTIRE round it appears in
   * rather than executing anything, and returns the pending call(s) to the
   * caller for an explicit human decision.
   */
  readonly requiresConfirmation: boolean;
  execute(ctx: ToolContext, rawInput: Readonly<Record<string, unknown>>): Promise<ToolResult>;
}

/**
 * Builds a `ToolDefinition` from a Zod input schema and a typed executor,
 * the same "typed inner, erased outer" shape `defineEvent` uses for domain
 * events — callers of the registry work with a uniform `ToolDefinition`,
 * never with each tool's own input type.
 *
 * Two failure modes are caught HERE, both turned into a `ToolResult` rather
 * than a thrown exception: a malformed input from the model (parse failure)
 * and a thrown error from the real service call (most commonly a `can()`
 * refusal). Neither should abort the whole assistant turn — the model can
 * read "you don't have permission for that" and tell the person, the same
 * way a UI would render a denied action as a message rather than a crash.
 */
export function defineTool<Schema extends z.ZodTypeAny>(config: {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  readonly requiresConfirmation: boolean;
  readonly inputSchema: Schema;
  readonly execute: (ctx: ToolContext, input: z.infer<Schema>) => Promise<ToolResult>;
}): ToolDefinition {
  return {
    name: config.name,
    description: config.description,
    jsonSchema: config.jsonSchema,
    requiresConfirmation: config.requiresConfirmation,
    async execute(ctx, rawInput) {
      const parsed = config.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        return {
          content: `Invalid input for tool "${config.name}": ${parsed.error.message}`,
          isError: true,
        };
      }

      try {
        return await config.execute(ctx, parsed.data as z.infer<Schema>);
      } catch (error) {
        return { content: messageOf(error), isError: true };
      }
    },
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The tool failed for an unknown reason.';
}

/** `ToolDefinition` -> the wire shape `AiProvider.complete` sends the model. */
export function toAiToolDefinition(tool: ToolDefinition): AiToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: tool.jsonSchema };
}
