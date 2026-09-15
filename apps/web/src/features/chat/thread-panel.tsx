import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { ChannelId, MessageId } from '@taskflow/contracts';
import { useToast } from '../../lib/toast-context.js';
import { Button, Skeleton } from '../../components/primitives.js';
import { RichTextEditor, RichTextView } from '../work/detail/rich-text-editor.js';
import { EMPTY_DOCUMENT, isEmptyDocument, type DocumentNode } from '../work/detail/rich-text.js';
import { invalidateMessages, sendMessage, threadQuery, type Message } from './api.js';
import { formatTime } from './chat-helpers.js';

/**
 * A message's thread — the root plus its replies, one level deep
 * (`message.service.ts`'s own limit: a reply cannot itself be replied to, so
 * this panel never needs to open a thread from within a thread).
 *
 * `rootMessage` comes from the already-loaded channel page rather than a
 * second fetch — `messages.list` already returned it, and re-requesting a
 * message the caller is already looking at would be the one round trip in
 * this feature with nothing to show for it.
 */
export function ThreadPanel({
  orgId,
  channelId,
  rootMessage,
  personOf,
  onClose,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
  readonly rootMessage: Message;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const replies = useQuery(threadQuery(orgId, channelId, rootMessage.messageId as MessageId));
  const [draft, setDraft] = useState<DocumentNode>(EMPTY_DOCUMENT);

  const scrollRef = useRef<HTMLDivElement>(null);

  /* Bottom-anchored, the same contract as the main channel's scrollRef: a
     thread is read newest-last, so a reply landing (sent here, or arriving
     live through the socket invalidation) must be visible without scrolling.
     Deps are the reply COUNT rather than the array identity — the query's
     data reference can change on refetch without a new reply, and scrolling
     then would yank a reader mid-thread for no message. */
  const replyCount = (replies.data ?? []).length;
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [rootMessage.messageId, replyCount]);

  const reply = useMutation({
    mutationFn: (body: DocumentNode) =>
      sendMessage({
        channelId,
        body,
        parentMessageId: rootMessage.messageId as MessageId,
      }),
    onSuccess: () => {
      invalidateMessages(queryClient, orgId, channelId);
    },
    onError: (error, body) => {
      toast.failure('The reply was not sent', error);
      setDraft((current) => (isEmptyDocument(current) ? body : current));
    },
  });

  const submit = (): void => {
    if (isEmptyDocument(draft)) return;
    const body = draft;
    setDraft(EMPTY_DOCUMENT);
    reply.mutate(body);
  };

  const renderPlain = (message: Message) => {
    const label = message.authorId === null ? 'Unknown' : personOf(message.authorId).label;

    if (message.deletedAt !== null) {
      return <p className="px-2 py-0.5 text-xs text-ink-faint italic">This message was deleted.</p>;
    }

    return (
      <div className="group rounded-md px-2 py-1.5 hover:bg-surface-hover/40 transition-colors">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-[13px] font-semibold text-ink">{label}</span>
          <span className="text-[11px] text-ink-faint leading-none">{formatTime(message.createdAt)}</span>
          {message.editedAt !== null && <span className="text-[11px] text-ink-faint">· edited</span>}
        </div>
        <div className="text-[13px] leading-relaxed text-ink">
          <RichTextView value={message.body} bare />
        </div>
      </div>
    );
  };

  /* Below `md` this panel is a full-width overlay on top of the message
     column (the channel pane is the `relative` parent, see `ChannelPanel`)
     rather than a fixed-width sibling squeezing it — the phone has no room
     for a 320px sidebar next to a conversation. `md:static md:w-80` restores
     the side-by-side layout above the breakpoint. */
  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-line bg-surface-raised md:static md:w-80">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <h3 className="text-sm font-medium text-ink">Thread</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close thread"
          className="flex size-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-hover hover:text-ink transition-colors"
        >
          <X aria-hidden="true" className="size-4" strokeWidth={2} />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {renderPlain(rootMessage)}

        <div className="border-t border-line pt-3">
          {replies.isLoading ? (
            <Skeleton className="h-8 w-3/4" />
          ) : (
            <div className="space-y-3">
              {(replies.data ?? []).map((message) => (
                <div key={message.messageId}>{renderPlain(message)}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line px-3 py-2">
        <RichTextEditor
          value={draft}
          className="text-sm"
          placeholder="Reply in thread…"
          onChange={setDraft}
          onSubmit={submit}
          footer={
            <Button
              size="sm"
              variant="primary"
              disabled={isEmptyDocument(draft) || reply.isPending}
              onClick={submit}
            >
              Reply
            </Button>
          }
        />
      </div>
    </aside>
  );
}
