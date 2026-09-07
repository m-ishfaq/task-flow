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
        // Prefixed with the tool name for the identical reason the
        // validation branch above already is: a bare `errors.notFound()` —
        // and there are many call sites across `work/*.service.ts` that
        // throw exactly that, message "Not found.", with zero detail — gave
        // the model (and the transcript) no way to tell which of several
        // tool calls in a turn failed or why. Found from a real transcript:
        // the model, with no label-creation tool available, fabricated a
        // plausible-looking uuid for `card_add_labels`, which failed a
        // foreign-key check translated to `errors.notFound()`, and the
        // resulting bare "Not found." left the model no better informed
        // than before it tried — it retried the identical broken approach a
        // second time rather than recognizing what had actually failed.
        return { content: `Tool "${config.name}" failed: ${messageOf(error)}`, isError: true };
      }
    },
  };
}

/**
 * Walks an error's `.cause` chain for a Postgres SQLSTATE code, the same
 * shape `apps/api/src/work/shared.ts`'s `hasSqlState` already uses (and the
 * five other local copies of it across this codebase) — duplicated locally
 * rather than imported cross-module, since this file has no business
 * depending on `work`'s internals for a generic tool-registry concern.
 */
function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Found from a real transcript: `card_link_pr`/`list_card_prs` failed with
 * the tool result `Tool "card_link_pr" failed: Failed query: insert into
 * "work"."card_pull_requests" (...) params: <uuid>,<uuid>,...` — a
 * `DrizzleQueryError` whose OWN `.message` is exactly that query-plus-params
 * text (`drizzle-orm/errors.js`'s `DrizzleQueryError` constructor), with the
 * real reason (a Postgres error carrying a SQLSTATE code, a human message,
 * sometimes a detail) sitting on `.cause` — which the previous version of
 * this function never looked at. The person reading the transcript got a
 * useless SQL dump instead of the one sentence that would have told them
 * what was actually wrong, and — since query text and raw parameter values
 * (ids the model has no business restating) have no place in a surface an
 * LLM reads and repeats to a person — this also closes a small internals
 * leak, not just a UX gap.
 */
function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return 'The tool failed for an unknown reason.';

  const code = sqlState(error);
  if (code === '42P01') {
    // undefined_table -- a migration this deployment expects has not been
    // applied. Never something retrying will fix, so say that plainly
    // rather than let the model suggest "try again."
    return (
      'A required database table is missing on this deployment — a pending migration has not ' +
      'been applied. This is something an administrator needs to fix, not something to retry.'
    );
  }
  if (code === '23503') return 'That reference no longer exists.';
  if (code === '23505') return 'That already exists.';

  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;

  // A DrizzleQueryError with no informative `.cause` at all (rare, but the
  // driver does not guarantee one) — still better than dumping the raw SQL
  // and parameter values into a tool result the model treats as data.
  if (error.message.startsWith('Failed query:')) {
    return 'The database rejected that operation, with no further detail available.';
  }
  return error.message;
}

/** `ToolDefinition` -> the wire shape `AiProvider.complete` sends the model. */
export function toAiToolDefinition(tool: ToolDefinition): AiToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: tool.jsonSchema };
}
