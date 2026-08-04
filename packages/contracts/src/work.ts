import { z } from 'zod';

/**
 * Work vocabulary shared by the frontend and backend (`ai/phase-3.5-work-ux.md` §5.1).
 *
 * Two enums, not two open-ended strings. A status's CATEGORY and a card's
 * PRIORITY are both closed sets the filter compiler, the board's grouping and
 * the (eventual) automation rules all need to agree on — putting them here
 * means a value neither side recognizes is a type error at the call site
 * rather than a card that silently fails to group, filter or render.
 */

/**
 * What a status MEANS, independent of its name.
 *
 * A project can rename "Done" to "Shipped" without breaking anything that asks
 * "is this card finished" — that question is answered by the category, not by
 * string-matching a label a user is free to change. `not_started` is the
 * default for a newly created status; nothing here assumes a project has
 * exactly one status per category.
 */
export const StatusCategory = z.enum(['not_started', 'active', 'done']);
export type StatusCategory = z.infer<typeof StatusCategory>;

/**
 * A card's priority. NULLABLE at every layer — see `card.priority` in the
 * migration — because "no priority set" is a real and common state, and a
 * default of `normal` would make every card look deliberately triaged when
 * none of them were.
 */
export const Priority = z.enum(['urgent', 'high', 'normal', 'low']);
export type Priority = z.infer<typeof Priority>;
