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
 * Narrating a standup into a short, TEAM-LEVEL callout
 * (ai/phase-15-ai-copilot-and-permissions.md §5 — "AI narrates the raw list
 * into a short summary... reuses §2's provider... no new write path").
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
 * ## REDESIGNED: this file no longer writes a per-member line
 *
 * Two earlier versions of this file asked the model for one sentence per
 * team member — first as free text, then (once that read as one run-on
 * paragraph) forced through a tool call for shape, then prompt-tuned for
 * content. Both were the wrong layer for the job: `standup.service.ts` now
 * buckets every member's cards into real Yesterday/Today/Overdue/Urgent
 * lists (a real product redesign, not a prompt fix — see that file's own
 * header), and once that data exists, a per-person AI SENTENCE describing
 * it is redundant with data the page already renders directly — the classic
 * "classification stays deterministic" rule extended one step further: not
 * just the BUCKETING but the PRESENTATION of a person's own status is a
 * fact, not something worth spending a completion asking a model to
 * paraphrase.
 *
 * What a model IS suited for is the one thing this screen still lacks
 * with buckets alone: a pattern across the WHOLE roster that a PM would
 * otherwise have to find by eyeballing eighteen rows — three people blocked
 * on the same dependency, or one person visibly overloaded relative to
 * everyone else. `narrateStandup` now produces exactly one such paragraph,
 * never a per-member line, and the model is free to say nothing stands out
 * — this is genuinely optional editorial color on top of data the page
 * already shows in full without it, not a structural piece the UI depends
 * on to avoid dropping anyone (the old per-line design's actual reason for
 * forcing a tool call and a fallback line per member no longer applies,
 * because there is no longer a per-member slot an omission could leave
 * empty).
 */
export interface NarrateStandupDeps {
  readonly keys: KeyProvider;
}

export interface StandupCallout {
  /** One short paragraph (2-4 sentences) — team-wide patterns, or an honest
      "nothing stands out" when there genuinely is none. Never per-member. */
  readonly callout: string;
}

const EMIT_CALLOUT_TOOL_NAME = 'emit_team_callout';

const EmitCalloutInput = z.object({ callout: z.string().min(1).max(600) }).strict();

/** The paragraph is short and its length does not grow with team size (unlike
    the old per-member design this replaces, whose fixed budget truncated
    against a real ~18-person team — see CLAUDE.md's account of that bug). A
    fixed budget is correct here specifically because the OUTPUT shape no
    longer scales with input size, even though the input payload still does. */
const MAX_OUTPUT_TOKENS = 400;

export async function narrateStandup(
  deps: NarrateStandupDeps,
  actor: { readonly orgId: OrgId; readonly userId: UserId; readonly requestId: RequestId },
  standup: StandupResult,
): Promise<StandupCallout> {
  const [{ provider, providerName, model }, membershipId] = await Promise.all([
    resolveAiProvider(actor.orgId, deps.keys),
    loadMembershipId(actor.orgId, actor.userId),
  ]);

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
          content: [
            "You are given a team's standup data: for each member, cards done recently (yesterday), cards actively in progress (today), overdue cards, and urgent/high-priority cards.",
            `Call ${EMIT_CALLOUT_TOOL_NAME} exactly once with ONE short paragraph (2-4 sentences) for a project manager scanning this before a daily standup.`,
            "Only report patterns visible ACROSS multiple people, or a single person carrying a genuinely unusual load — never restate one person's own list, which is already shown next to their name.",
            'Good examples: several people blocked on the same dependency or overdue in the same area; one person with far more overdue or urgent work than everyone else; a sprint with unusually many urgent cards concentrated on few people.',
            'If nothing like that is present, say so plainly in one short sentence — do not invent a pattern to fill space.',
            'Do not invent facts not in the data, and do not write anything outside the tool call.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            sprint: standup.sprint,
            urgentSprintCards: standup.urgentSprintCards,
            members: standup.members,
          }),
        },
      ],
      tools: [
        {
          name: EMIT_CALLOUT_TOOL_NAME,
          description: 'Report one short team-wide callout paragraph for the standup view.',
          inputSchema: {
            type: 'object',
            properties: {
              callout: { type: 'string' },
            },
            required: ['callout'],
          },
        },
      ],
      effort: 'low',
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  );

  return { callout: calloutFromCompletion(result) };
}

/**
 * The pure half of `narrateStandup` — parsing, with no network or database
 * dependency, so it is tested directly against a hand-built
 * `AiCompletionResult` rather than only through `router.test.ts`'s
 * real-Postgres-plus-stubbed-`fetch` end-to-end path.
 *
 * Still fails LOUD on a declined or malformed response, unlike the more
 * forgiving "fall back to a computed line" the old per-member design used —
 * that fallback existed because the UI structurally needed one line per
 * member and could not afford to drop anyone; this route's entire output IS
 * the callout, so if the model cannot produce one, the caller should see a
 * clear failure rather than a silently empty success.
 */
export function calloutFromCompletion(result: AiCompletionResult): string {
  if (result.stopReason !== 'tool_use' || result.toolCalls.length === 0) {
    throw errors.internal(undefined, 'The assistant did not return a team callout.');
  }

  const call = result.toolCalls.find((entry) => entry.name === EMIT_CALLOUT_TOOL_NAME);
  if (call === undefined) {
    throw errors.internal(undefined, 'The assistant did not return a team callout.');
  }

  const parsed = EmitCalloutInput.safeParse(call.input);
  if (!parsed.success) {
    throw errors.internal(undefined, 'The assistant returned a malformed team callout.');
  }

  return parsed.data.callout;
}
