import { useRef, useState } from 'react';
import { Check, Paperclip, Pin, Smile } from 'lucide-react';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  PopoverClose,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
} from '@taskflow/ui';
import { cn } from '../../lib/cn.js';
import { ACCEPTED_FILE_TYPES } from '../../lib/accepted-file-types.js';
import { Avatar, Button } from '../../components/primitives.js';
import { RichTextEditor, RichTextView } from '../work/detail/rich-text-editor.js';
import { isEmptyDocument, type DocumentNode } from '../work/detail/rich-text.js';
import type { Message, MessageAttachment, MessagePreview } from './api.js';
import { MessageAttachments, MessagePreviews } from './message-extras.js';
import { matchingCommands } from './slash-commands.js';
import type { MessageGroup } from './grouping.js';
import { flattenDocument, formatTime } from './chat-helpers.js';

/** The fixed emoji palette the reaction picker offers — see `reaction.service.ts`
 * on why the server does not restrict the set: curating taste is a client job. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'] as const;

/**
 * A group, Slack-style: every message — including the viewer's own — renders
 * left-aligned, full width, no bubble. An avatar and a `name · time` header
 * sit once above the FIRST message in the group; the rest sit in the same
 * content column with nothing repeated above them, so a run of several
 * messages from one person reads as one continuous utterance rather than a
 * stack of separately-labelled boxes.
 *
 * `isOwn` still matters for PERMISSIONS (only the author gets an Edit
 * control) — it no longer decides anything about layout.
 */
export function MessageGroupView({
  group,
  canModerate,
  viewerId,
  authorLabel,
  editingId,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  editPending,
  onDelete,
  onHide,
  reactionsByMessage,
  attachmentsByMessage,
  previewsByMessage,
  savedIds,
  onToggleSave,
  personOf,
  onToggleReaction,
  pinnedIds,
  onTogglePin,
  replyCounts,
  onOpenThread,
}: {
  readonly group: MessageGroup;
  /** From the server (`capabilitiesFor`) — never computed in the client. */
  readonly canModerate: boolean;
  readonly viewerId: string | null;
  readonly authorLabel: string | null;
  readonly editingId: string | null;
  readonly onStartEdit: (messageId: string) => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: (messageId: string, body: DocumentNode) => void;
  readonly editPending: boolean;
  readonly onDelete: (messageId: string) => void;
  /** "Remove for me" — hides the message from this viewer's own list. */
  readonly onHide: (messageId: string) => void;
  readonly reactionsByMessage: Map<string, Map<string, string[]>>;
  readonly attachmentsByMessage: ReadonlyMap<string, readonly MessageAttachment[]>;
  readonly savedIds: ReadonlySet<string>;
  readonly onToggleSave: (messageId: string, saved: boolean) => void;
  readonly previewsByMessage: ReadonlyMap<string, readonly MessagePreview[]>;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly onToggleReaction: (messageId: string, emoji: string) => void;
  readonly pinnedIds: Set<string>;
  readonly onTogglePin: (messageId: string, pinned: boolean) => void;
  readonly replyCounts: Map<string, number>;
  readonly onOpenThread: (messageId: string) => void;
}) {
  const isOwn = group.authorId !== null && group.authorId === viewerId;
  const first = group.messages[0];
  if (first === undefined) return null;

  return (
    <div className="group/section flex gap-2.5 px-4 py-1">
      {/* Avatar sits in a sticky gutter — always visible, always left-aligned,
          anchoring every message to its author visually. */}
      <div className="w-8 shrink-0 pt-0.5">
        {group.authorId !== null && (
          <Avatar userId={group.authorId} label={authorLabel ?? group.authorId} size="sm" />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* One header for the whole group — name and the FIRST message's time.
            Subsequent messages in the group sit in this same column with no
            header of their own, making a run read as one utterance. */}
        <span className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold text-ink">
            {authorLabel ?? 'Unknown'}{' '}
            {isOwn && <span className="font-light text-xs text-gray-500"> (You)</span>}
          </span>
          <span className="text-[11px] text-ink-faint">{formatTime(first.createdAt)}</span>
        </span>

        {group.messages.map((message) => (
          <MessageRow
            key={message.messageId}
            message={message}
            isOwn={isOwn}
            canModerate={canModerate}
            isEditing={editingId === message.messageId}
            onStartEdit={() => {
              onStartEdit(message.messageId);
            }}
            onCancelEdit={onCancelEdit}
            onSaveEdit={(body) => {
              onSaveEdit(message.messageId, body);
            }}
            editPending={editPending}
            onDelete={() => {
              onDelete(message.messageId);
            }}
            onHide={() => {
              onHide(message.messageId);
            }}
            reactions={reactionsByMessage.get(message.messageId) ?? new Map()}
            attachments={attachmentsByMessage.get(message.messageId) ?? []}
            isSaved={savedIds.has(message.messageId)}
            onToggleSave={(saved) => {
              onToggleSave(message.messageId, saved);
            }}
            previews={previewsByMessage.get(message.messageId) ?? []}
            viewerId={viewerId}
            personOf={personOf}
            onToggleReaction={(emoji) => {
              onToggleReaction(message.messageId, emoji);
            }}
            pinned={pinnedIds.has(message.messageId)}
            onTogglePin={(pinned) => {
              onTogglePin(message.messageId, pinned);
            }}
            replyCount={replyCounts.get(message.messageId) ?? 0}
            onOpenThread={() => {
              onOpenThread(message.messageId);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function MessageRow({
  message,
  canModerate,
  isOwn,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  editPending,
  onDelete,
  onHide,
  reactions,
  attachments,
  previews,
  isSaved,
  onToggleSave,
  viewerId,
  personOf,
  onToggleReaction,
  pinned,
  onTogglePin,
  replyCount,
  onOpenThread,
}: {
  readonly message: Message;
  readonly isOwn: boolean;
  readonly canModerate: boolean;
  readonly isEditing: boolean;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: (body: DocumentNode) => void;
  readonly editPending: boolean;
  readonly onDelete: () => void;
  /** "Remove for me" — hides this message from the viewer's own list only. */
  readonly onHide: () => void;
  readonly reactions: Map<string, string[]>;
  readonly attachments: readonly MessageAttachment[];
  readonly isSaved: boolean;
  readonly onToggleSave: (saved: boolean) => void;
  readonly previews: readonly MessagePreview[];
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly onToggleReaction: (emoji: string) => void;
  readonly pinned: boolean;
  readonly onTogglePin: (pinned: boolean) => void;
  readonly replyCount: number;
  readonly onOpenThread: () => void;
}) {
  if (message.deletedAt !== null) {
    return <p className="py-0.5 pl-0.5 text-xs text-ink-faint italic">This message was deleted.</p>;
  }

  if (isEditing) {
    return (
      <div className="w-full min-w-56">
        <EditMessage
          initial={message.body}
          pending={editPending}
          onCancel={onCancelEdit}
          onSave={onSaveEdit}
        />
      </div>
    );
  }

  return (
    <div className="group/msg relative flex flex-col gap-1 rounded-md transition-colors duration-[var(--motion-fast)] hover:bg-surface-hover/40">
      {/* The row's own positioning context for the hover toolbar. No bubble
          — the toolbar floats over the plain text row instead. Always
          right-0: there is no "own message" side to switch it for. */}
      <div className="relative">
        {/* `text-sm` — 14px, the standard chat message body size. */}
        <div className="min-w-0 py-0.5 pr-12 text-sm text-ink leading-relaxed">
          <RichTextView value={message.body} bare />
          {/* "(edited)" and the pinned mark travel with the text — there is
              no bubble left to own a metadata row. */}
          {(message.editedAt !== null || pinned) && (
            <span className="ml-1.5 inline-flex items-center gap-1 align-middle text-[10px] text-ink-faint">
              {message.editedAt !== null && <span className="italic">(edited)</span>}
              {pinned && <Pin aria-label="Pinned" className="size-2.5" strokeWidth={2.25} />}
            </span>
          )}
        </div>

        {/* Hover actions float over the row's top edge, aligned right.
            `pointer-events-none` is not cosmetic — an invisible opacity-0
            element still intercepts clicks. Click-through while hidden,
            interactive only once shown. Edit is author-only (CLAUDE.md §8.2).
            Delete stays visible for moderators; the server decides. */}
        <div
          className={cn(
            'pointer-events-none absolute -top-3 right-0 z-20 flex items-center gap-0.5 rounded-lg border border-line bg-surface-raised px-1 py-0.5 opacity-0 shadow-md transition-opacity duration-[var(--motion-fast)]',
            'group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100',
          )}
        >
          <EmojiPickerButton onPick={onToggleReaction} />
          <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={onOpenThread}>
            Reply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1 text-[11px]"
            onClick={() => {
              onTogglePin(pinned);
            }}
          >
            {pinned ? 'Unpin' : 'Pin'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1 text-[11px]"
            onClick={() => {
              onToggleSave(isSaved);
            }}
          >
            {isSaved ? 'Unsave' : 'Save'}
          </Button>
          {isOwn && (
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-[11px]"
              onClick={onStartEdit}
            >
              Edit
            </Button>
          )}
          <DeleteMenu isOwn={isOwn} canModerate={canModerate} onHide={onHide} onDelete={onDelete} />
        </div>
      </div>

      {/* Files and link previews sit BELOW the text rather than inside it:
          a preview card is about something the message points at, not part of
          what was written, and putting it inside would make an edit look like
          it changed the card too. */}
      <MessageAttachments attachments={attachments} />
      <MessagePreviews previews={previews} />

      {reactions.size > 0 && (
        <ReactionBar
          reactions={reactions}
          viewerId={viewerId}
          personOf={personOf}
          onToggle={onToggleReaction}
        />
      )}

      {replyCount > 0 && (
        <button
          type="button"
          onClick={onOpenThread}
          className="px-1 text-xs font-medium text-accent hover:underline"
        >
          {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
        </button>
      )}
    </div>
  );
}

/**
 * The row's delete control — Slack's two-way delete in one popover.
 *
 * "Remove for me" (hide) is always available: it writes a per-viewer hide
 * row and the message stays live for everyone else, so there is nothing to
 * moderate. "Remove for everyone" (tombstone) is authorship or moderation —
 * the moderation half is the server's `capabilitiesFor` answer, not
 * recomputed here.
 */
function DeleteMenu({
  isOwn,
  canModerate,
  onHide,
  onDelete,
}: {
  readonly isOwn: boolean;
  readonly canModerate: boolean;
  readonly onHide: () => void;
  readonly onDelete: () => void;
}) {
  const canRemoveForEveryone = isOwn || canModerate;
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]">
          Delete
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-64">
        <p className="px-2 pb-1 pt-0.5 text-xs font-medium text-ink-muted">Delete message</p>
        <DropdownMenuItem onSelect={onHide} className="flex-col items-start">
          <span className="text-sm font-medium text-ink">Remove for me</span>
          <span className="text-xs text-ink-faint">
            Only you won&apos;t see this message anymore.
          </span>
        </DropdownMenuItem>
        {canRemoveForEveryone && (
          <DropdownMenuItem onSelect={onDelete} tone="danger" className="flex-col items-start">
            <span className="text-sm font-medium text-danger">Remove for everyone</span>
            <span className="text-xs text-ink-faint">
              {isOwn
                ? 'Delete this message for everyone in the conversation.'
                : 'Only available to moderators. Removes the message for everyone.'}
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/**
 * The reaction bar under a row — one pill per emoji, with its count.
 *
 * Each pill is a popover trigger: clicking it shows WHO reacted (the names the
 * bar itself deliberately does not show, so the row stays scannable) and — for
 * the viewer's own reaction — the same click that opened it can be repeated to
 * remove it. The viewer's own reaction is additionally marked on the pill
 * itself: filled accent + a check, so "did I react?" is answered by the bar
 * without opening anything, and "who else did?" is one click away.
 */
function ReactionBar({
  reactions,
  viewerId,
  personOf,
  onToggle,
}: {
  readonly reactions: Map<string, string[]>;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly onToggle: (emoji: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 px-1">
      {[...reactions.entries()].map(([emoji, userIds]) => {
        const mine = viewerId !== null && userIds.includes(viewerId);
        return (
          <PopoverRoot key={emoji}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`${emoji} — ${String(userIds.length)} ${userIds.length === 1 ? 'reaction' : 'reactions'}`}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors',
                  mine
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-line bg-surface-raised text-ink-muted hover:bg-surface-hover',
                )}
              >
                <span>{emoji}</span>
                <span>{userIds.length}</span>
                {mine && <Check aria-hidden="true" className="size-3" strokeWidth={2.5} />}
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-52 p-1.5">
              <p className="px-1.5 pb-1 pt-0.5 text-xs font-medium text-ink-muted">
                {emoji} — {userIds.length} {userIds.length === 1 ? 'reaction' : 'reactions'}
              </p>
              <ul className="flex flex-col">
                {userIds.map((userId) => (
                  <li
                    key={userId}
                    className={cn(
                      'flex items-center justify-between rounded px-1.5 py-1 text-sm text-ink',
                      userId === viewerId && 'font-medium text-accent',
                    )}
                  >
                    <span>{personOf(userId).label}</span>
                    {userId === viewerId && <span className="text-xs text-ink-faint">You</span>}
                  </li>
                ))}
              </ul>
              {mine && (
                <button
                  type="button"
                  onClick={() => {
                    onToggle(emoji);
                  }}
                  className="mt-1 w-full rounded border-t border-line px-1.5 pt-1.5 text-left text-xs font-medium text-danger"
                >
                  Remove your reaction
                </button>
              )}
            </PopoverContent>
          </PopoverRoot>
        );
      })}
    </div>
  );
}

export function EmojiPickerButton({
  onPick,
  label,
}: {
  readonly onPick: (emoji: string) => void;
  readonly label?: string;
}) {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs text-ink-muted">
          <Smile className="size-3.5" />
          {label !== undefined && <span>{label}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" className="flex gap-1 p-1.5 text-base">
        {QUICK_REACTIONS.map((emoji) => (
          <PopoverClose asChild key={emoji}>
            <button
              type="button"
              onClick={() => {
                onPick(emoji);
              }}
              className="rounded p-1 hover:bg-surface-hover"
            >
              {emoji}
            </button>
          </PopoverClose>
        ))}
      </PopoverContent>
    </PopoverRoot>
  );
}

function EditMessage({
  initial,
  pending,
  onSave,
  onCancel,
}: {
  readonly initial: unknown;
  readonly pending: boolean;
  readonly onSave: (body: DocumentNode) => void;
  readonly onCancel: () => void;
}) {
  const [body, setBody] = useState<DocumentNode | null>(null);

  return (
    <RichTextEditor
      value={initial}
      onChange={setBody}
      footer={
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={pending || body === null || isEmptyDocument(body)}
            onClick={() => {
              if (body !== null) onSave(body);
            }}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </>
      }
    />
  );
}

/**
 * The paperclip.
 *
 * A hidden `<input type="file">` driven by a button, which is the standard way
 * to get a styled control — the native one cannot be styled and reads as a
 * foreign object in the composer. The input is reset after every pick so
 * choosing the SAME file twice fires `change` both times.
 */
export function AttachFileButton({
  disabled,
  onPick,
}: {
  readonly disabled: boolean;
  readonly onPick: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) onPick(file);
          event.target.value = '';
        }}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        aria-label="Attach a file"
        className="h-6 px-1.5 text-ink-muted"
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        <Paperclip className="size-3.5" />
      </Button>
    </>
  );
}

/**
 * The slash-command menu.
 *
 * Shown only while the draft is a bare command word — the moment an argument is
 * typed the list stops being useful and starts covering the composer. Purely an
 * affordance: typing the command by hand works identically, because `submit`
 * parses the text rather than reading a selection made here.
 */
export function SlashCommandMenu({ draft }: { readonly draft: DocumentNode }) {
  const text = flattenDocument(draft);
  if (!text.startsWith('/') || text.includes(' ')) return null;

  const matches = matchingCommands(text);
  if (matches.length === 0) return null;

  return (
    <ul className="mb-1 overflow-hidden rounded border border-line bg-surface-raised text-xs shadow-sm">
      {matches.map((command) => (
        <li key={command.name} className="flex gap-2 px-2 py-1">
          <span className="font-mono text-ink">{command.hint}</span>
          <span className="text-ink-faint">{command.description}</span>
        </li>
      ))}
    </ul>
  );
}
