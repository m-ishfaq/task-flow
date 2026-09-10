import { useRef, useState } from 'react';
import { Check, Paperclip, Pin } from 'lucide-react';
import { PopoverClose, PopoverContent, PopoverRoot, PopoverTrigger } from '@taskflow/ui';
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
 * A group, WhatsApp/Telegram-style: the viewer's OWN messages align right in
 * an accent bubble with no avatar (the side is already the identity signal —
 * repeating your own name and picture next to it is the thing this layout
 * exists to avoid); everyone else's align left, with an avatar next to the
 * FIRST bubble in the group and a matching space held next to the rest, so
 * the second and third bubbles in a run still line up under the first
 * instead of drifting to the edge once the avatar is gone.
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
    <div className={cn('flex gap-2', isOwn ? 'flex-row-reverse' : 'flex-row')}>
      <div className="w-6 shrink-0 self-end">
        {!isOwn && group.authorId !== null && (
          <Avatar userId={group.authorId} label={authorLabel ?? group.authorId} size="sm" />
        )}
      </div>

      {/* 85% on a phone, 75% from `sm` up.
          A single 75% cap reads as a comfortable margin on a desktop and as a
          cramped column on a phone, because the fixed costs around it do not
          scale: the avatar gutter (`w-6`) and its gap take 2rem, and the list's
          own horizontal padding takes another, before the percentage applies to
          what's left. On a 375px viewport that is 75% of ~19rem rather than 75%
          of the screen — bubbles a third of the width of the device, wrapping
          every few words. Widening the cap below `sm` is what every chat
          product does for the same arithmetic; the point of the cap at all is
          to keep the opposite edge visible so left and right bubbles stay
          distinguishable, and 85% still does that. */}
      <div
        className={cn(
          'flex min-w-0 max-w-[85%] flex-col gap-0.5 sm:max-w-[75%]',
          isOwn && 'items-end',
        )}
      >
        {/* Own bubbles skip the name — the side they're on already says who
            sent them — but every group still gets ONE relative timestamp,
            because "who and when" is what a message header is for and only
            half of that is redundant here. */}
        {!isOwn && (
          <span className="px-1 text-xs font-medium text-ink-muted">
            {authorLabel ?? 'Unknown'}
          </span>
        )}

        {group.messages.map((message, index) => (
          <MessageBubble
            key={message.messageId}
            message={message}
            isOwn={isOwn}
            canModerate={canModerate}
            isFirstInGroup={index === 0}
            isLastInGroup={index === group.messages.length - 1}
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

function MessageBubble({
  message,
  canModerate,
  isOwn,
  isFirstInGroup,
  isLastInGroup,
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
  readonly isFirstInGroup: boolean;
  readonly isLastInGroup: boolean;
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
    return (
      <p
        className={cn(
          'rounded-2xl px-3 py-1.5 text-xs text-ink-faint italic',
          isOwn ? 'bg-accent/10' : 'bg-surface-raised',
        )}
      >
        This message was deleted.
      </p>
    );
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

  /* A run of same-author bubbles gets one rounded corner shaved flat where
     it touches its neighbour — the "tail only on the outermost bubble" shape
     every chat product uses so a run of three reads as one utterance
     instead of three separate boxes stacked with identical corners. */
  const cornerClass = isOwn
    ? cn(!isFirstInGroup && 'rounded-tr-md', !isLastInGroup && 'rounded-br-md')
    : cn(!isFirstInGroup && 'rounded-tl-md', !isLastInGroup && 'rounded-bl-md');

  return (
    <div className={cn('group/message relative flex flex-col gap-1', isOwn && 'items-end')}>
      {/* The bubble's wrapper: a row with exactly one in-flow child (the
          bubble) whose only other job is to be the positioning context for
          the hover toolbar's `absolute top-full` — the toolbar floats BELOW
          the bubble, so it is out of flow and never widens this row. `flex`
          (not a plain block) is what keeps the bubble's `min-w-0` a real
          bound against its widest child (see the bubble's own comment). */}
      <div className="relative flex items-end">
        <div
          className={cn(
            /* `min-w-0` because the bubble is a flex item whose automatic
               minimum size would otherwise be its widest child, and two of
               its children are wider than a phone: a link preview card is
               `max-w-md` (28rem — a cap, but one no small viewport can
               honour), and an attachment row's filename is `truncate`, which
               is `white-space: nowrap` and therefore contributes the WHOLE
               filename to min-content even though it renders as an ellipsis.
               Both are clipped or capped for their own layout and neither can
               shrink the box that contains them. Bounding the bubble here
               instead means every child resolves against the 75% the message
               column actually has, rather than the bubble growing to fit them
               and taking the message list's horizontal scrollbar with it. */
            /* `text-sm` — 14px, the size every chat product (Slack, WhatsApp,
               Discord) sets its message body to. The base 16px is a reading
               size for document surfaces; a message column at 16px reads as
               shouting, and the bubble is the container that owns the size. */
            'min-w-0 rounded-2xl px-3 py-1.5 max-w-2xl text-sm shadow-sm',
            isOwn ? 'bg-accent text-accent-ink' : 'bg-surface-raised text-ink',
            /* Links inside the viewer's own bubble would otherwise be the
               accent hue on an accent fill — invisible (see styles.css's
               `.rich-text-on-accent` rule). Hanging it here scopes that
               override to the accent bubble only; the receiver's side keeps
               the normal accent link color on the light surface. */
            isOwn && 'rich-text-on-accent',
            cornerClass,
          )}
        >
          <RichTextView value={message.body} bare />
          {/* The timestamp sits bottom-RIGHT inside the bubble, under the last
              text line, in a muted tint of the bubble's own colour — metadata
              about the bubble, not a second row of chrome (WhatsApp's own
              placement; right-aligned in both the viewer's and others'). */}
          <div
            className={cn(
              'mt-0.5 flex items-center justify-end gap-1 text-[10px] leading-none',
              isOwn ? 'text-accent-ink/70' : 'text-ink-faint',
            )}
          >
            <span>{formatTime(message.createdAt)}</span>
            {message.editedAt !== null && <span>edited</span>}
            {pinned && <Pin aria-label="Pinned" className="size-2.5" strokeWidth={2.25} />}
          </div>
        </div>

        {/* Hover actions float over the bubble's TOP edge, aligned to its
            outer corner (`right-0` for the viewer's own bubble, `left-0` for
            everyone else's) — the Slack placement. Chosen over "below the
            bubble" for a concrete reason: reactions and the reply count live
            BELOW the bubble, so a toolbar parked there covers the exact
            things a hovering reader is about to click. At the top it
            transiently overlaps the first line of the message's own text,
            which is the trade Slack itself makes and nothing interactive is
            ever hidden. Floating, not in-flow: the row appears on hover
            only, and reserving space would push reactions and the next
            message down for every message nobody is hovering.

            `pointer-events-none` is not cosmetic — it is the other half of
            the fix. An invisible `opacity-0` element still intercepts
            clicks, so a toolbar parked below the bubble was blocking the
            reaction pills beneath it even when it could not be seen.
            Click-through while hidden, interactive only once actually
            shown. The same `opacity-0 group-hover:opacity-100` shape
            `card-tile.tsx`'s quick actions use, visible on hover or
            keyboard focus rather than as permanent clutter on every bubble.

            Edit is author-only with no override, same reasoning as Work's
            comments (CLAUDE.md, §8.2) — nobody else's edit control would ever
            succeed, so it never renders for someone else's bubble regardless
            of side. Delete stays visible wherever a moderator override is
            possible; the server is the one that turns an unearned click into
            an honest FORBIDDEN rather than a silent no-op. React and pin are
            offered to everyone who can post — see `reaction.service.ts` and
            `pin.service.ts` on why neither needs a stronger permission. */}
        <div
          className={cn(
            'pointer-events-none absolute top-0 z-20 flex items-center gap-0.5 rounded-lg border border-line bg-surface-raised px-1 py-0.5 opacity-0 shadow-md transition-opacity',
            isOwn ? 'right-0' : 'left-0',
            'group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100',
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
          {/* Editing is AUTHORSHIP, which the client knows for certain — there
              is no permission that overrides it, so no server answer is needed. */}
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
          {/* Deleting is now TWO actions, Slack-style. "Remove for me" is
              offered to everyone — it only changes the viewer's own list, so
              it can never be refused. "Remove for everyone" is authorship OR
              moderation, and the moderation half is the server's decision
              (`capabilitiesFor`), not recomputed here — but the option is
              hidden rather than shown-and-refused because a button whose only
              outcome is an error toast is not a control. */}
          <DeleteMenu isOwn={isOwn} canModerate={canModerate} onHide={onHide} onDelete={onDelete} />
        </div>
      </div>

      {/* Files and link previews sit BELOW the bubble rather than inside it:
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
 * The bubble's delete control — Slack's two-way delete in one popover.
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
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]">
          Delete
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 p-1.5">
        <p className="px-1.5 pb-1 pt-0.5 text-xs font-medium text-ink-muted">Delete message</p>
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={onHide}
            className="flex flex-col items-start rounded px-1.5 py-1.5 text-left hover:bg-surface-hover"
          >
            <span className="text-sm font-medium text-ink">Remove for me</span>
            <span className="text-xs text-ink-faint">
              Only you won&apos;t see this message anymore.
            </span>
          </button>
          {canRemoveForEveryone && (
            <button
              type="button"
              onClick={onDelete}
              className="flex flex-col items-start rounded px-1.5 py-1.5 text-left hover:bg-surface-hover"
            >
              <span className="text-sm font-medium text-danger">Remove for everyone</span>
              <span className="text-xs text-ink-faint">
                {isOwn
                  ? 'Delete this message for everyone in the conversation.'
                  : 'Only available to moderators. Removes the message for everyone.'}
              </span>
            </button>
          )}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * The reaction bar under a bubble — one pill per emoji, with its count.
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
                    ? 'border-accent bg-accent text-accent-ink'
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

export function EmojiPickerButton({ onPick }: { readonly onPick: (emoji: string) => void }) {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]">
          React
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
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        <Paperclip aria-hidden="true" className="size-4" strokeWidth={2} />
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
