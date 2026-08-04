import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, CardId, ProjectId } from '@taskflow/contracts';
import { Button, Input, Skeleton } from '../../../components/primitives.js';
import { ErrorView } from '../../../components/error-view.js';
import { formatDateTime } from '../../../lib/format.js';
import { api } from '../../../lib/trpc.js';
import { cardQuery, invalidateCard } from '../api.js';
import { useUpdateCard } from '../use-update-card.js';
import { RichTextEditor } from './rich-text-editor.js';
import { isEmptyDocument, type DocumentNode } from './rich-text.js';
import { LabelSection } from './label-section.js';
import { PrioritySection, StatusSection } from './status-priority-section.js';
import { ChecklistSection } from './checklist-section.js';
import { CustomFieldSection } from './custom-field-section.js';
import { CommentSection } from './comment-section.js';
import { AttachmentSection } from './attachment-section.js';
import { AssigneeSection } from './assignee-section.js';

/**
 * The card detail — a centred modal, not a side panel (`ai/phase-3.5-work-ux.md` §4.7).
 *
 * Route-driven (`?card=`), so it is deep-linkable, shareable and correct under
 * the back button — §10.5 is explicit about this, and it is why the open card is
 * NOT in the Zustand store with the rest of the ephemeral UI state. The parent
 * only mounts this component while `search.card` is set, so `Dialog.Root` is
 * always `open`; dismissing it — Escape, the overlay, or the Close button, all
 * funnelled through `onOpenChange` — clears the search param instead of
 * flipping local state, which is what keeps the URL the single source of truth.
 *
 * ## Saving is explicit, not on blur
 *
 * Every write here goes through `cards.update`, which is an optimistic-
 * concurrency operation: it carries a `version`, and a mismatch is a CONFLICT
 * rather than a silent overwrite. Autosaving on blur would fire that check on
 * every focus change — turning a colleague's concurrent edit into a stream of
 * conflict toasts, and filling the audit log with one entry per keystroke pause.
 * The API's own `setCardLabels` returns early on a no-op change for the same
 * reason.
 *
 * The sections below are separate because their PERMISSIONS are separate, not
 * for layout. Labels and custom-field definitions are project vocabulary
 * (`project:update`); filling one in is `card:update`; commenting is
 * `comment:create`, which is what makes read-plus-comment access expressible at
 * all.
 *
 * ## The two-column body
 *
 * Content (title, description, checklist, attachments) sits left because it is
 * what someone opens the card to read or write; properties (dates, assignees,
 * labels, custom fields) sit right because they are glanced at and occasionally
 * changed, never the reason the panel was opened. Activity — comments — runs
 * full width below both, since a thread reads better long than narrow.
 */

export interface CardDetailPanelProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
  readonly projectId: ProjectId | null;
  readonly onClose: () => void;
}

export function CardDetailPanel({
  orgId,
  boardId,
  cardId,
  projectId,
  onClose,
}: CardDetailPanelProps) {
  const card = useQuery(cardQuery(orgId, cardId));

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 flex max-h-[90vh] w-full max-w-4xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-line bg-surface-raised shadow-xl">
          <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
            <Dialog.Title className="font-mono text-xs text-ink-faint">
              {card.data?.reference ?? 'Card'}
            </Dialog.Title>
            {/* Not shown — the two-column body under it says everything a
                sighted user needs, and a visible sentence duplicating that
                would just be noise above the title field. */}
            <Dialog.Description className="sr-only">
              Card details: title, description, properties and comments.
            </Dialog.Description>
            <div className="ml-auto flex items-center gap-1">
              <ArchiveCardButton
                orgId={orgId}
                boardId={boardId}
                cardId={cardId}
                onArchived={onClose}
              />
              <Dialog.Close asChild>
                <Button size="sm" variant="ghost">
                  Close
                </Button>
              </Dialog.Close>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {card.isPending && (
              <div aria-busy="true" className="space-y-4 p-4">
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-20 w-full" />
                <div className="grid grid-cols-2 gap-3">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                </div>
                <Skeleton className="h-24 w-full" />
              </div>
            )}

            {card.isError && (
              <div className="p-4">
                <ErrorView error={card.error} title="Could not load this card" />
              </div>
            )}

            {card.isSuccess && (
              <div className="grid gap-6 p-4 md:grid-cols-[1fr_18rem]">
                <div className="min-w-0 space-y-6">
                  {/* Keyed by card id so switching cards REMOUNTS the editor
                      rather than resetting its state in an effect. The effect
                      version works and is a cascade — React renders the
                      previous card's title, then re-renders — and it silently
                      regresses the moment someone adds a field and forgets to
                      reset it. A key cannot be forgotten. */}
                  <TitleAndDescription
                    key={card.data.cardId}
                    orgId={orgId}
                    boardId={boardId}
                    card={card.data}
                  />

                  <ChecklistSection orgId={orgId} boardId={boardId} cardId={cardId} />
                  <AttachmentSection orgId={orgId} cardId={cardId} />
                </div>

                <div className="space-y-6">
                  {projectId !== null && (
                    <StatusSection
                      orgId={orgId}
                      boardId={boardId}
                      cardId={cardId}
                      projectId={projectId}
                      statusId={card.data.statusId}
                    />
                  )}

                  <PrioritySection
                    orgId={orgId}
                    boardId={boardId}
                    cardId={cardId}
                    priority={card.data.priority}
                  />

                  <DatesSection orgId={orgId} boardId={boardId} card={card.data} />

                  <AssigneeSection
                    orgId={orgId}
                    boardId={boardId}
                    cardId={cardId}
                    assigneeIds={card.data.assigneeIds}
                  />

                  {projectId !== null && (
                    <>
                      <LabelSection
                        orgId={orgId}
                        boardId={boardId}
                        cardId={cardId}
                        projectId={projectId}
                      />
                      <CustomFieldSection
                        orgId={orgId}
                        boardId={boardId}
                        cardId={cardId}
                        projectId={projectId}
                      />
                    </>
                  )}
                </div>

                <div className="space-y-6 border-t border-line pt-4 md:col-span-2">
                  <CommentSection orgId={orgId} boardId={boardId} cardId={cardId} />

                  <p className="text-[11px] text-ink-faint">
                    Created {formatDateTime(card.data.createdAt)} · updated{' '}
                    {formatDateTime(card.data.updatedAt)} · v{card.data.version}
                  </p>
                </div>
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Archives the card and closes the panel.
 *
 * Archive, not delete — `archiveCard` sets `archived_at` and the row stays, so
 * the card keeps its number and its history. `cards.list` excludes archived
 * cards, so it leaves the board immediately.
 *
 * Confirmed first because the panel offers no way back: there is no archived
 * view in this build, so an accidental click makes the card unreachable from the
 * UI even though the data is intact.
 */
function ArchiveCardButton({
  orgId,
  boardId,
  cardId,
  onArchived,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly cardId: CardId;
  readonly onArchived: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const archive = useMutation({
    mutationFn: () => api.work.cards.archive.mutate({ cardId, archived: true }),
    onSuccess: async () => {
      await invalidateCard(queryClient, orgId, cardId, boardId);
      onArchived();
    },
  });

  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setConfirming(true);
        }}
      >
        Archive
      </Button>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="danger"
        disabled={archive.isPending}
        onClick={() => {
          archive.mutate();
        }}
      >
        {archive.isPending ? 'Archiving…' : 'Confirm'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setConfirming(false);
        }}
      >
        Keep
      </Button>
    </>
  );
}

function TitleAndDescription({
  orgId,
  boardId,
  card,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  /* `description` is OPTIONAL, matching what the route's `z.unknown()` infers —
     Zod treats an unknown field as possibly absent, so a required property here
     would not accept the query's own result type. */
  readonly card: {
    cardId: string;
    title: string;
    description?: unknown;
    version: number;
  };
}) {
  const update = useUpdateCard(orgId, boardId);

  /* Seeded once. The parent keys this component by card id, so pointing the
     panel at a different card remounts it and these start from the new card's
     values — without which the previous card's title would stay in the input
     and the next save would write it onto the new card. */
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState<DocumentNode | null>(null);

  const dirty = title.trim() !== card.title || description !== null;

  const save = () => {
    update.mutate({
      cardId: card.cardId as CardId,
      patch: {
        title: title.trim(),
        /* Only sent when the editor actually produced something. The patch API
           distinguishes "absent" from "null", so leaving the key out is how a
           title-only edit preserves a description this component never saw
           change. */
        ...(description === null
          ? {}
          : { description: isEmptyDocument(description) ? null : description }),
      },
    });
  };

  return (
    <section className="space-y-2">
      <Input
        aria-label="Card title"
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
        className="h-9 text-sm font-medium"
      />

      <RichTextEditor
        value={card.description}
        placeholder="Add a description…"
        onChange={setDescription}
      />

      {update.isError && <ErrorView error={update.error} />}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || update.isPending || title.trim() === ''}
          onClick={save}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
        {dirty && <span className="text-[11px] text-ink-faint">Unsaved changes</span>}
      </div>
    </section>
  );
}

function DatesSection({
  orgId,
  boardId,
  card,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly card: { cardId: string; dueDate: string | null; startDate: string | null };
}) {
  const update = useUpdateCard(orgId, boardId);

  const set = (key: 'dueDate' | 'startDate', day: string) => {
    update.mutate({
      cardId: card.cardId as CardId,
      /* An empty input clears the date, and the patch shape has to say so
         explicitly — `{ dueDate: null }` rather than omitting the key, which
         would mean "leave it as it was". */
      patch: { [key]: day === '' ? null : new Date(`${day}T00:00:00`).toISOString() },
    });
  };

  return (
    <section className="grid grid-cols-2 gap-3">
      <label className="space-y-1 text-xs text-ink-muted">
        <span className="block">Start</span>
        <input
          type="date"
          value={card.startDate?.slice(0, 10) ?? ''}
          onChange={(event) => {
            set('startDate', event.target.value);
          }}
          className="h-8 w-full rounded border border-line bg-surface-sunken px-2 text-xs text-ink"
        />
      </label>

      <label className="space-y-1 text-xs text-ink-muted">
        <span className="block">Due</span>
        <input
          type="date"
          value={card.dueDate?.slice(0, 10) ?? ''}
          onChange={(event) => {
            set('dueDate', event.target.value);
          }}
          className="h-8 w-full rounded border border-line bg-surface-sunken px-2 text-xs text-ink"
        />
      </label>
    </section>
  );
}
