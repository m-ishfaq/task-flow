import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Saved-search events — guardrail 6 (ai/phase-8-search.md §3.2).
 *
 * The three mutations `saved-search.service.ts` performs, one event each.
 *
 * ## What the payload deliberately does not carry
 *
 * Not the QUERY TEXT. A saved search is a question someone asked about their
 * own workspace, and the questions people ask are more revealing than most of
 * the answers — `assignee = me AND text contains "resignation"` says something
 * about its author that its results do not. An outbox payload is projected
 * into the audit log, which is a longer-lived and more widely-readable record
 * than the row itself, and readable by every Admin rather than only by the
 * search's owner.
 *
 * `chat/events.ts` makes the identical call about message bodies, and
 * `work/events.ts` about filter trees on `view.created` — this is the same
 * decision a third time, at the one place where the stored value IS the
 * sensitive part.
 *
 * `shared` IS carried, because it is the fact an access review needs: who made
 * a search visible to the whole organization, and when.
 */

export const savedSearchCreated = defineEvent(
  'saved_search.created',
  z.object({ searchId: z.string(), name: z.string(), shared: z.boolean() }).strict(),
);

export const savedSearchUpdated = defineEvent(
  'saved_search.updated',
  z
    .object({
      searchId: z.string(),
      name: z.string(),
      /* The BEFORE value, per this codebase's standing rule: an event saying
         only what sharing BECAME cannot answer whether it changed, and
         "someone shared a saved search" is exactly the transition an access
         review is looking for. */
      wasShared: z.boolean(),
      shared: z.boolean(),
    })
    .strict(),
);

export const savedSearchDeleted = defineEvent(
  'saved_search.deleted',
  z.object({ searchId: z.string(), name: z.string(), shared: z.boolean() }).strict(),
);
