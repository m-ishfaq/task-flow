import { asc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type PageId, type SuggestionId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { decodeAnchor, encodeAnchor } from './anchor.js';
import { pageSuggestionCreated, pageSuggestionDecided } from './events.js';
import { flattenToText, type RichTextNode } from '../work/richtext.js';
import { enforceOnPage, envelopeOf, loadPage, orgOf, type DocsActor } from './shared.js';

/**
 * Suggestions — tracked-change-style proposed edits (ai/phase-6-docs.md
 * §3.6, Wave 3).
 *
 * ## Two authorization questions, deliberately not merged — Work's card
 * ## detail precedent (CLAUDE.md), applied to a third permission tier
 *
 * PROPOSING a change is `comment:create`'s floor: a reviewer with no edit
 * rights can suggest wording without being trusted to change the document
 * directly, the entire point of a suggestion existing as a concept distinct
 * from an edit. DECIDING on someone else's suggestion is `page:update`'s
 * tier — accepting is, functionally, incorporating an edit into the page,
 * and a comment-tier account approving its own proposal would let a
 * non-editor push a change through by way of an escape hatch. WITHDRAWING
 * your own pending suggestion (rejecting it yourself) stays at
 * `comment:create`'s tier, mirroring `deleteComment`'s byAuthor escalation
 * — you can always take back your own proposal.
 *
 * ## What accepting a suggestion does NOT do
 *
 * It flips `status` and emits an event. It does not touch the live
 * document. Applying the proposed text is a client-side edit through the
 * ordinary Yjs sync session — the identical "known limitation, named rather
 * than assumed away" shape `page-version.service.ts`'s restore already
 * documents for the equivalent reason: no server process holds the live
 * `Y.Doc` to edit.
 */

export interface SuggestionSummary {
  readonly suggestionId: string;
  readonly pageId: string;
  readonly anchorFrom: string;
  readonly anchorTo: string;
  readonly kind: string;
  readonly proposedContent: unknown;
  readonly status: string;
  readonly authorId: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
}

export async function listSuggestions(
  actor: DocsActor,
  input: { readonly pageId: PageId },
): Promise<readonly SuggestionSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:read', page);

    const rows = await tx
      .select({
        suggestionId: schema.suggestions.id,
        pageId: schema.suggestions.pageId,
        anchorFrom: schema.suggestions.anchorFrom,
        anchorTo: schema.suggestions.anchorTo,
        kind: schema.suggestions.kind,
        proposedContent: schema.suggestions.proposedContent,
        status: schema.suggestions.status,
        authorId: schema.suggestions.authorId,
        decidedBy: schema.suggestions.decidedBy,
        decidedAt: schema.suggestions.decidedAt,
        createdAt: schema.suggestions.createdAt,
      })
      .from(schema.suggestions)
      .where(eq(schema.suggestions.pageId, input.pageId))
      .orderBy(asc(schema.suggestions.id));

    return rows.map((row) => ({
      ...row,
      anchorFrom: encodeAnchor(row.anchorFrom),
      anchorTo: encodeAnchor(row.anchorTo),
    }));
  });
}

export async function createSuggestion(
  actor: DocsActor,
  input: {
    readonly pageId: PageId;
    readonly anchorFrom: string;
    readonly anchorTo: string;
    readonly kind: 'insert' | 'delete' | 'replace';
    /** Required for 'insert'/'replace', absent for 'delete' — see the CHECK constraint this mirrors. */
    readonly proposedContent?: RichTextNode | null;
  },
): Promise<{ readonly suggestionId: SuggestionId }> {
  const suggestionId = newId<'SuggestionId'>();
  const orgId = orgOf(actor);

  await withOrgScope(orgId, async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'comment:create', page);

    const anchorFrom = decodeAnchor(input.anchorFrom);
    const anchorTo = decodeAnchor(input.anchorTo);

    const hasContent = input.proposedContent != null;
    if (input.kind === 'delete' && hasContent) {
      throw errors.validation({ proposedContent: 'A delete suggestion carries no content.' });
    }
    if (input.kind !== 'delete' && !hasContent) {
      throw errors.validation({ proposedContent: 'Required for an insert or replace suggestion.' });
    }
    if (hasContent && flattenToText(input.proposedContent).length === 0) {
      throw errors.validation({ proposedContent: 'A suggestion cannot propose empty content.' });
    }

    await tx.insert(schema.suggestions).values({
      id: suggestionId,
      orgId,
      pageId: input.pageId,
      anchorFrom,
      anchorTo,
      kind: input.kind,
      proposedContent: input.proposedContent ?? null,
      authorId: actor.subject.userId,
    });

    await outboxWriter.append(tx, [
      createEvent(pageSuggestionCreated, { suggestionId, pageId: input.pageId }, envelopeOf(actor)),
    ]);
  });

  return { suggestionId };
}

/** Accepts or rejects a pending suggestion. See the file header on the authorization split. */
export async function decideSuggestion(
  actor: DocsActor,
  input: { readonly suggestionId: SuggestionId; readonly status: 'accepted' | 'rejected' },
): Promise<{ readonly status: 'accepted' | 'rejected' }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const suggestion = await loadSuggestion(tx, input.suggestionId);
    const page = await loadPage(tx, suggestion.pageId as PageId);

    if (suggestion.status !== 'pending')
      throw errors.conflict('This suggestion was already decided.');

    const byAuthor = suggestion.authorId === actor.subject.userId;
    const withdrawal = byAuthor && input.status === 'rejected';
    enforceOnPage(actor, withdrawal ? 'comment:create' : 'page:update', page);

    await tx
      .update(schema.suggestions)
      .set({ status: input.status, decidedBy: actor.subject.userId, decidedAt: new Date() })
      .where(eq(schema.suggestions.id, input.suggestionId));

    await outboxWriter.append(tx, [
      createEvent(
        pageSuggestionDecided,
        { suggestionId: input.suggestionId, pageId: suggestion.pageId, status: input.status },
        envelopeOf(actor),
      ),
    ]);

    return { status: input.status };
  });
}

interface SuggestionRow {
  readonly orgId: string;
  readonly pageId: string;
  readonly authorId: string | null;
  readonly status: string;
}

async function loadSuggestion(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  suggestionId: SuggestionId,
): Promise<SuggestionRow> {
  const rows = await tx
    .select({
      orgId: schema.suggestions.orgId,
      pageId: schema.suggestions.pageId,
      authorId: schema.suggestions.authorId,
      status: schema.suggestions.status,
    })
    .from(schema.suggestions)
    .where(eq(schema.suggestions.id, suggestionId))
    .limit(1);

  const suggestion = rows[0];
  if (!suggestion) throw errors.notFound();
  return suggestion;
}
