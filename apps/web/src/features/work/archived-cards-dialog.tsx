import { useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, CardId, ListId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { Button, Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { archivedCardsQuery, archivedListsQuery, invalidateCard } from './api.js';

/**
 * The one place archived cards are reachable from (§ card-detail-panel.tsx's
 * `ArchiveCardButton` used to note there was no archived view at all).
 *
 * Fetched only while the dialog is OPEN — `open && <ArchivedCardsList />`
 * below — rather than every time the board renders, since this is a rarely
 * visited list and every board page firing one more query on mount is exactly
 * the batching pressure `trpc-client.ts`'s `maxURLLength` split was added to
 * absorb, not something to add back for a panel most sessions never open.
 */

export interface ArchivedCardsDialogProps {
  readonly orgId: string;
  readonly boardId: BoardId;
}

export function ArchivedCardsDialog({ orgId, boardId }: ArchivedCardsDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button size="sm">Archived</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 max-h-[85vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded border border-line bg-surface-raised p-4 shadow-xl">
          <Dialog.Title className="text-sm font-semibold text-ink">Archived</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-ink-muted">
            Archiving hides something from the board without deleting it — a card keeps its number,
            comments and history. Restore one to bring it back.
          </Dialog.Description>

          {/* One Archive per board rather than a second dialog for columns. The
              restore flows are identical, and somebody hunting for a column
              they archived by mistake looks wherever archived things live —
              not for a separate control they have never needed before. */}
          {open && (
            <>
              <Section title="Cards">
                <ArchivedCardsList orgId={orgId} boardId={boardId} />
              </Section>
              <Section title="Lists">
                <ArchivedListsList orgId={orgId} boardId={boardId} />
              </Section>
            </>
          )}

          <div className="mt-4 flex justify-end">
            <Dialog.Close asChild>
              <Button>Done</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Archived columns, and the way back from one.
 *
 * `lists.archive` used to take no `archived` flag and return `z.literal(true)`,
 * so a column archived by mistake was unrecoverable by anyone — there was no
 * inverse to call, and the cards inside it stayed hidden with it. Restoring is
 * deliberately not gated on the list being empty: the occupancy check exists to
 * stop cards being STRANDED by an archive, and applying it in reverse would
 * refuse exactly the columns worth restoring.
 */
function ArchivedListsList({ orgId, boardId }: ArchivedCardsDialogProps) {
  const queryClient = useQueryClient();
  const archived = useQuery(archivedListsQuery(orgId, boardId));

  const restore = useMutation({
    mutationFn: (listId: ListId) => api.work.lists.archive.mutate({ listId, archived: false }),
    onSuccess: async () => {
      /* `keys.lists` is the PREFIX of this dialog's own query key, so one
         invalidation refreshes both the board's columns and this list. The
         cards query goes too: a restored column brings its cards back onto the
         board, and a stale card list would render it empty. */
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.lists(orgId, boardId) }),
        queryClient.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) }),
      ]);
    },
  });

  if (archived.isPending) {
    return <SkeletonRows rows={2} className="mt-2 *:h-10" />;
  }

  if (archived.isError) {
    return (
      <ErrorView error={archived.error} title="Could not load archived lists" className="mt-2" />
    );
  }

  if (archived.data.length === 0) {
    return (
      <div className="mt-2">
        <Empty
          title="No archived lists"
          description="Columns you archive from this board will show up here, restorable at any time."
        />
      </div>
    );
  }

  return (
    <div className="mt-2">
      <ul className="divide-y divide-line rounded border border-line">
        {archived.data.map((list) => (
          <li key={list.listId} className="flex items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-ink">{list.name}</p>
              <p className="text-[11px] text-ink-faint">
                {list.cardCount === 0
                  ? 'No cards'
                  : `${String(list.cardCount)} card${list.cardCount === 1 ? '' : 's'}`}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={restore.isPending && restore.variables === list.listId}
              onClick={() => {
                restore.mutate(list.listId as ListId);
              }}
            >
              Restore
            </Button>
          </li>
        ))}
      </ul>
      {restore.isError && <ErrorText error={restore.error} />}
    </div>
  );
}

function ArchivedCardsList({ orgId, boardId }: ArchivedCardsDialogProps) {
  const queryClient = useQueryClient();
  const archived = useQuery(archivedCardsQuery(orgId, boardId));

  const restore = useMutation({
    mutationFn: (cardId: CardId) => api.work.cards.archive.mutate({ cardId, archived: false }),
    onSuccess: (_result, cardId) => invalidateCard(queryClient, orgId, cardId, boardId),
  });

  if (archived.isPending) {
    return <SkeletonRows rows={3} className="mt-4 *:h-10" />;
  }

  if (archived.isError) {
    return (
      <ErrorView error={archived.error} title="Could not load archived cards" className="mt-4" />
    );
  }

  if (archived.data.length === 0) {
    return (
      <div className="mt-4">
        <Empty
          title="No archived cards"
          description="Cards you archive from this board will show up here, restorable at any time."
        />
      </div>
    );
  }

  return (
    <div className="mt-4">
      <ul className="divide-y divide-line rounded border border-line">
        {archived.data.map((card) => (
          <li key={card.cardId} className="flex items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-ink">{card.title}</p>
              <p className="text-[11px] text-ink-faint">{card.reference}</p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={restore.isPending && restore.variables === card.cardId}
              onClick={() => {
                restore.mutate(card.cardId as CardId);
              }}
            >
              Restore
            </Button>
          </li>
        ))}
      </ul>
      {restore.isError && <ErrorText error={restore.error} />}
    </div>
  );
}
