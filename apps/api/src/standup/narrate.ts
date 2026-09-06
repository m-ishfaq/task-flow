import { z } from 'zod';
import {
  errors,
  type AiCompletionResult,
  type KeyProvider,
  type OrgId,
  type RequestId,
  type UserId,
} from '@taskflow/contracts';
import { completeGated } from '../ai/complete.js';
import { loadMembershipId } from '../ai/router.js';
import { resolveAiProvider } from '../ai/provider-resolver.js';
import type { StandupResult } from './standup.service.js';

/**
 * Narrating a standup's raw data into one short line per person
 * (ai/phase-15-ai-copilot-and-permissions.md §5 — "AI narrates the raw list
 * into a short summary per person... reuses §2's provider... no new write
 * path").
 *
 * A single `completeGated` call, not the §4 tool-calling loop
 * (`runAssistantTurn`): there is nothing for the model to DO here, only text
 * to produce from data this route already queried, so the tool-execution
 * machinery — authorization per tool, confirm-before-execute, the round
 * cap — has no work to do and would only add a network round trip for
 * nothing. `complete.ts`'s own header names `'standup'` as an expected
 * `feature` value for exactly this call.
 *
 * The model sees ONLY the already-authorized `StandupResult` this route
 * queried under the caller's own `project:read` — never a raw database read
 * of its own — so it can narrate no more than the person asking could
 * already see.
 *
 * ## The response is forced through a tool call, not read as free text
 *
 * The first version asked for "one paragraph, plain sentences" and rendered
 * whatever text came back — which reads exactly as loosely as it sounds: a
 * single run-on paragraph mixing every person's status with no structure to
 * key off, because nothing about a text completion GUARANTEES the shape a
 * caller asked for in prose. `AiCompletionRequest.tools` already exists for
 * §4's tool-calling loop, and it forces the same guarantee here for free —
 * `emit_standup_lines` is a one-tool "response schema", not something the
 * model can execute code with; `stopReason` other than `'tool_use'` is
 * treated as the model declining to comply, not something to silently
 * fall back to raw prose for (§2's "have the model return real structured
 * data" decision — a caller depending on this shape should see a clear
 * failure, not a differently-shaped success).
 */
export interface NarrateStandupDeps {
  readonly keys: KeyProvider;
}

export interface StandupNarrationLine {
  readonly userId: string;
  /** One short sentence — no headers, no bullets inside the string itself;
      the CALLER renders one list item per entry, so the model's job is
      just the sentence. */
  readonly line: string;
}

const EMIT_LINES_TOOL_NAME = 'emit_standup_lines';

const EmitLinesInput = z
  .object({
    lines: z
      .array(z.object({ userId: z.string(), line: z.string().min(1).max(240) }).strict())
      .max(200),
  })
  .strict();

export async function narrateStandup(
  deps: NarrateStandupDeps,
  actor: { readonly orgId: OrgId; readonly userId: UserId; readonly requestId: RequestId },
  standup: StandupResult,
): Promise<{ readonly lines: readonly StandupNarrationLine[] }> {
  const [{ provider, providerName, model }, membershipId] = await Promise.all([
    resolveAiProvider(actor.orgId, deps.keys),
    loadMembershipId(actor.orgId, actor.userId),
  ]);

  const memberIds = standup.members.map((member) => member.userId);

  const result = await completeGated(
    provider,
    { orgId: actor.orgId, userId: actor.userId, membershipId, requestId: actor.requestId },
    {
      feature: 'standup',
      providerName,
      model,
      messages: [
        {
          role: 'system',
          content:
            'You write one-line standup updates from structured card data. Call ' +
            `${EMIT_LINES_TOOL_NAME} exactly once, with one entry per member id given to you — ` +
            'never fewer, never an id not given. Each line is a single short sentence (under 20 ' +
            'words): what they finished, what is still open, and call out anything overdue by ' +
            'name if it exists. Do not invent facts not in the data, and do not write anything ' +
            'outside the tool call.',
        },
        {
          role: 'user',
          content: JSON.stringify({ memberIds, standup }),
        },
      ],
      tools: [
        {
          name: EMIT_LINES_TOOL_NAME,
          description: 'Report one short status line per team member for the standup view.',
          inputSchema: {
            type: 'object',
            properties: {
              lines: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    userId: { type: 'string' },
                    line: { type: 'string' },
                  },
                  required: ['userId', 'line'],
                },
              },
            },
            required: ['lines'],
          },
        },
      ],
      effort: 'low',
      maxOutputTokens: 800,
    },
  );

  return { lines: linesFromCompletion(result, standup.members) };
}

/**
 * The pure half of `narrateStandup` — parsing and merging, with no network
 * or database dependency, so it is tested directly against a hand-built
 * `AiCompletionResult` rather than only through `router.test.ts`'s
 * real-Postgres-plus-stubbed-`fetch` end-to-end path. Exported for exactly
 * that: `narrate.test.ts` proves the merge-with-fallback and malformed-
 * input cases here, fast and without a database.
 */
export function linesFromCompletion(
  result: AiCompletionResult,
  members: StandupResult['members'],
): readonly StandupNarrationLine[] {
  if (result.stopReason !== 'tool_use' || result.toolCalls.length === 0) {
    throw errors.internal(undefined, 'The assistant did not return a structured standup summary.');
  }

  const call = result.toolCalls.find((entry) => entry.name === EMIT_LINES_TOOL_NAME);
  if (call === undefined) {
    throw errors.internal(undefined, 'The assistant did not return a structured standup summary.');
  }

  const parsed = EmitLinesInput.safeParse(call.input);
  if (!parsed.success) {
    throw errors.internal(undefined, 'The assistant returned a malformed standup summary.');
  }

  /* Every real member gets a line — the model's own omissions do not
     silently disappear a person from the summary. `Map` dedupes a
     misbehaving model naming the same id twice; the LAST one wins, matching
     "later wins" every other last-write-in-a-batch shape in this codebase
     already uses. */
  const byMember = new Map(parsed.data.lines.map((entry) => [entry.userId, entry.line]));

  return members.map((member) => ({
    userId: member.userId,
    line: byMember.get(member.userId) ?? fallbackLineFor(member),
  }));
}

function fallbackLineFor(member: StandupResult['members'][number]): string {
  if (member.overdue.length > 0) {
    return `${String(member.overdue.length)} overdue, ${String(member.stillOpen.length)} still open.`;
  }
  if (member.recentlyDone.length > 0) {
    return `${String(member.recentlyDone.length)} done recently, ${String(member.stillOpen.length)} still open.`;
  }
  return `${String(member.stillOpen.length)} still open.`;
}
