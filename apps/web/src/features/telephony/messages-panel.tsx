import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { api } from '../../lib/trpc.js';
import { formatRelative } from '../../lib/format.js';
import { useToast } from '../../lib/toast-context.js';
import { Button, Empty, Input, SkeletonRows } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
import {
  invalidateAfterMessage,
  messageThreadsQuery,
  phoneNumbersQuery,
  threadMessagesQuery,
} from './api.js';

/**
 * SMS threads (ai/phase-7-voice.md §3.8, Wave 3) — the identical list/detail
 * shape `chat-page.tsx` uses for channels, over a parallel resource rather
 * than a `chat.channels` row (§3.8's own point).
 *
 * `messages.send` takes `to`/`fromPhoneNumberId`, not a thread id —
 * `ThreadRecord` carries the counterparty but not which of the org's numbers
 * owns the thread (`message.service.ts`'s `ThreadRecord`). With one number
 * this is invisible; with several, the compose box lets the sender pick —
 * there is no API surface yet to derive it automatically, so this asks
 * rather than silently sending from the wrong one.
 */

export function MessagesPanel({ orgId }: { readonly orgId: string }) {
  const navigate = useNavigate();
  const threadId = useSearch({ from: '/calls', select: (value) => value.thread });
  const threads = useQuery(messageThreadsQuery(orgId));

  const selectThread = (id: string | undefined) => {
    void navigate({ to: '/calls', search: { tab: 'messages', thread: id } });
  };

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="w-64 shrink-0 space-y-1 overflow-y-auto">
        {threads.isPending ? (
          <SkeletonRows rows={4} />
        ) : threads.isError ? (
          <ErrorView error={threads.error} title="Could not load threads" />
        ) : threads.data.length === 0 ? (
          <Empty title="No SMS conversations yet" />
        ) : (
          threads.data.map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              onClick={() => {
                selectThread(thread.threadId);
              }}
              className={cn(
                'block w-full rounded px-2 py-1.5 text-left',
                thread.threadId === threadId ? 'bg-surface-hover' : 'hover:bg-surface-hover',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-ink">{String(thread.counterparty)}</span>
                {thread.unreadCount > 0 && (
                  <span className="rounded-full bg-accent px-1.5 text-[10px] text-accent-ink">
                    {thread.unreadCount}
                  </span>
                )}
              </div>
              {thread.lastMessageAt !== null && (
                <p className="text-[11px] text-ink-faint">{formatRelative(thread.lastMessageAt)}</p>
              )}
            </button>
          ))
        )}
      </div>

      <div className="min-w-0 flex-1">
        {threadId === undefined ? (
          <Empty title="No conversation open" description="Pick a thread on the left." />
        ) : (
          <ThreadView key={threadId} orgId={orgId} threadId={threadId} />
        )}
      </div>
    </div>
  );
}

function ThreadView({ orgId, threadId }: { readonly orgId: string; readonly threadId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const numbers = useQuery(phoneNumbersQuery(orgId));
  const threads = useQuery(messageThreadsQuery(orgId));
  const messages = useQuery(threadMessagesQuery(orgId, threadId));

  const thread = threads.data?.find((t) => t.threadId === threadId);
  const counterparty = thread === undefined ? undefined : String(thread.counterparty);

  const [body, setBody] = useState('');
  const [fromPhoneNumberId, setFromPhoneNumberId] = useState('');
  const activeNumber =
    fromPhoneNumberId !== '' ? fromPhoneNumberId : (numbers.data?.[0]?.phoneNumberId ?? '');

  const send = useMutation({
    mutationFn: () =>
      api.telephony.messages.send.mutate({
        to: counterparty ?? '',
        fromPhoneNumberId: activeNumber,
        body: body.trim(),
      }),
    onSuccess: async () => {
      setBody('');
      await invalidateAfterMessage(queryClient, orgId, threadId);
    },
    onError: (error) => {
      toast.failure('The message was not sent', error);
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line px-2 pb-2">
        <p className="text-xs font-medium text-ink">{counterparty ?? '…'}</p>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-3">
        {messages.isPending ? (
          <SkeletonRows rows={4} />
        ) : messages.isError ? (
          <ErrorView error={messages.error} title="Could not load messages" />
        ) : messages.data.length === 0 ? (
          <p className="text-xs text-ink-muted">No messages yet.</p>
        ) : (
          [...messages.data].reverse().map((message) => (
            <div
              key={message.messageId}
              className={cn(
                'max-w-[75%] rounded px-2.5 py-1.5 text-xs',
                message.direction === 'outbound'
                  ? 'ml-auto bg-accent text-accent-ink'
                  : 'bg-surface-hover text-ink',
              )}
            >
              <p>{message.body}</p>
              <p className="mt-0.5 text-[10px] opacity-70">{formatRelative(message.createdAt)}</p>
            </div>
          ))
        )}
      </div>

      <form
        className="flex items-end gap-2 border-t border-line px-2 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (body.trim() !== '') send.mutate();
        }}
      >
        {(numbers.data?.length ?? 0) > 1 && (
          <select
            value={activeNumber}
            onChange={(event) => {
              setFromPhoneNumberId(event.target.value);
            }}
            className="h-9 rounded border border-line bg-surface-sunken px-2 text-xs text-ink"
          >
            {(numbers.data ?? []).map((number) => (
              <option key={number.phoneNumberId} value={number.phoneNumberId}>
                From {String(number.e164)}
              </option>
            ))}
          </select>
        )}
        <Input
          value={body}
          placeholder="Type a message…"
          className="flex-1"
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
        <Button type="submit" disabled={send.isPending || body.trim() === ''}>
          Send
        </Button>
      </form>
      {send.isError && <ErrorText error={send.error} />}
    </div>
  );
}
