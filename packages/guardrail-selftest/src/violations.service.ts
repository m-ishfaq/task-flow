/**
 * GUARDRAIL 11 SELF-TEST — mutations without domain events.
 *
 * Named `*.service.ts` because that is the scope the rule applies to
 * (packages/config/eslint/security.js). The file also proves the rule's NEGATIVE
 * cases: a correctly-emitting service and a plain `Map.delete` must NOT be
 * reported, because a guardrail that fires on correct code gets switched off.
 *
 * Asserted by verify.js. Exactly one report is expected from this file.
 */

interface Handle {
  insert(table: string): { values(row: unknown): Promise<void> };
  update(table: string): { set(row: unknown): Promise<void> };
  delete(table: string): Promise<void>;
  select(table: string): Promise<unknown[]>;
}

declare const withOrgScope: (orgId: string, fn: (tx: Handle) => Promise<void>) => Promise<void>;
declare const events: { emit(name: string, payload: unknown): Promise<void> };

/* 1 — VIOLATION: mutates and emits nothing. This is the whole guardrail. */
export async function archiveCard(orgId: string, cardId: string): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.update('work.cards').set({ id: cardId, archivedAt: new Date() });
  });
}

/* 2 — CLEAN: the mutation is inside a callback and the emit is in the outer
   function. This is the mandated shape, and reporting it would make the rule
   unusable. */
export async function moveCard(orgId: string, cardId: string): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.update('work.cards').set({ id: cardId });
  });
  await events.emit('card.moved', { cardId });
}

/* 3 — CLEAN: `delete` on a Map is not a database mutation. Flagging it would
   train people to reach for an inline disable, which is never an acceptable fix
   for a guardrail. */
export function forgetDraft(drafts: Map<string, string>, key: string): void {
  drafts.delete(key);
}

/* 4 — CLEAN: reads need no event. */
export async function listCards(orgId: string): Promise<unknown[]> {
  let rows: unknown[] = [];
  await withOrgScope(orgId, async (tx) => {
    rows = await tx.select('work.cards');
  });
  return rows;
}
