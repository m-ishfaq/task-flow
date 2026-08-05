/**
 * Applying one change to many cards (`ai/phase-3.5-work-ux.md` §6).
 *
 * ## Why this is a loop and not an endpoint
 *
 * The spec is explicit: "server side these are loops over existing routes —
 * resist inventing a bulk endpoint that bypasses per-card authorization". A
 * `cards.bulkUpdate` taking fifty ids would authorize once, against something,
 * and the something it authorized would not be each card. `enforceOn` runs per
 * card in `card.service.ts` precisely because a restrictive tuple can take back
 * on ONE board a capability the caller's role granted org-wide (§8.2).
 *
 * ## Which makes partial failure the normal case, not the error case
 *
 * That is the whole reason this module exists rather than a `Promise.all` at a
 * call site. Selecting thirty cards across two boards and setting a due date
 * SHOULD update the twenty-two the caller may edit and refuse the other eight.
 * `Promise.all` rejects on the first failure and discards the successes it
 * already had, which would report a wholly failed operation that in fact
 * changed twenty-two rows. `runBulk` reports both halves.
 *
 * ## Bounded concurrency
 *
 * Fifty simultaneous mutations is fifty simultaneous transactions, and the tRPC
 * client batches by URL length rather than by intent — a burst that long is how
 * `trpc-client.ts` acquired its `maxURLLength` split in the first place. Four at
 * a time keeps a bulk action responsive without turning one click into a
 * self-inflicted load test.
 */

const CONCURRENCY = 4;

export interface BulkOutcome {
  readonly succeeded: readonly string[];
  readonly failed: readonly { readonly cardId: string; readonly error: unknown }[];
}

/**
 * Runs `apply` for every id, never rejecting.
 *
 * Resolving with both halves rather than throwing is deliberate: the caller has
 * to tell the user what actually happened, and an exception carries only the
 * first thing that went wrong.
 */
export async function runBulk(
  cardIds: readonly string[],
  apply: (cardId: string) => Promise<unknown>,
  concurrency: number = CONCURRENCY,
): Promise<BulkOutcome> {
  const succeeded: string[] = [];
  const failed: { cardId: string; error: unknown }[] = [];

  const queue = [...cardIds];

  /* Workers pull from a shared queue rather than the list being sliced into
     fixed chunks. Chunking would make every batch wait for its slowest member,
     and one card that is slow to authorize would stall three that are not. */
  const worker = async (): Promise<void> => {
    for (;;) {
      const cardId = queue.shift();
      if (cardId === undefined) return;

      try {
        await apply(cardId);
        succeeded.push(cardId);
      } catch (error) {
        failed.push({ cardId, error });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, cardIds.length)) }, () => worker()),
  );

  return { succeeded, failed };
}

/**
 * What to tell the user afterwards.
 *
 * Separate from the runner so it can be asserted without mocking a transport,
 * and because the wording is the part that is easy to get quietly wrong: "8
 * cards updated" after selecting ten is a message that reads like success and
 * hides that two were refused.
 */
export function describeOutcome(outcome: BulkOutcome, verb: string): string {
  const done = outcome.succeeded.length;
  const failed = outcome.failed.length;

  const cards = (count: number): string => `${String(count)} card${count === 1 ? '' : 's'}`;

  if (failed === 0) return `${cards(done)} ${verb}.`;
  if (done === 0) return `No cards ${verb} — ${cards(failed)} could not be changed.`;

  return `${cards(done)} ${verb}. ${cards(failed)} could not be changed.`;
}
