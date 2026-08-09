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
    <div className="mx-auto flex h-full min-h-0 max-w-4xl gap-4">
      <div className="w-64 shrink-0 space-y-1 overflow-y-auto">
        {threads.isPending ? (
          <SkeletonRows rows={4} />
        ) : threads.isError ? (
          <ErrorView error={threads.error} title="Could not load threads" />
        ) : threads.data.length === 0 ? (
          <Empty
            title="No SMS conversations yet"
            description="Inbound texts to your numbers land here."
          />
        ) : (
          threads.data.map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              onClick={() => {
                selectThread(thread.threadId);
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
                thread.threadId === threadId
                  ? 'border-accent/40 bg-accent/10'
                  : 'border-transparent hover:bg-surface-hover',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-ink">
                    {String(thread.counterparty)}
                  </span>
                  {thread.unreadCount > 0 && (
                    <span className="rounded-full bg-accent px-1.5 text-[10px] font-medium text-accent-ink">
                      {thread.unreadCount}
                    </span>
                  )}
                </div>
                {thread.lastMessageAt !== null && (
                  <p className="mt-0.5 text-[10px] text-ink-faint">
                    {formatRelative(thread.lastMessageAt)}
                  </p>
                )}
              </div>
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface-raised">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="font-mono text-xs font-medium text-ink">{counterparty ?? '…'}</span>
        <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-ink-muted">
          SMS
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {messages.isPending ? (
          <SkeletonRows rows={4} />
        ) : messages.isError ? (
          <ErrorView error={messages.error} title="Could not load messages" />
        ) : messages.data.length === 0 ? (
          <p className="text-xs text-ink-muted">No messages yet — send the first one below.</p>
        ) : (
          [...messages.data].reverse().map((message) => (
            <div
              key={message.messageId}
              className={cn(
                'flex',
                message.direction === 'outbound' ? 'justify-end' : 'justify-start',
              )}
            >
              <div
                className={cn(
                  'max-w-[75%] rounded-lg px-2.5 py-1.5 text-xs shadow-sm',
                  message.direction === 'outbound'
                    ? 'rounded-br-sm bg-accent text-accent-ink'
                    : 'rounded-bl-sm bg-surface-hover text-ink',
                )}
              >
                <p className="whitespace-pre-wrap break-words">{message.body}</p>
                <p
                  className={cn(
                    'mt-0.5 text-[10px]',
                    message.direction === 'outbound' ? 'text-accent-ink/70' : 'text-ink-faint',
                  )}
                >
                  {formatRelative(message.createdAt)}
                </p>
              </div>
            </div>
          ))
        )}
      </div>

      <form
        className="flex items-end gap-2 border-t border-line bg-surface p-2.5"
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
            className="h-9 rounded border border-line bg-surface-sunken px-2 text-xs text-ink focus:border-accent focus:outline-none"
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
          placeholder={
            (numbers.data?.length ?? 0) === 0 ? 'Buy a number first…' : 'Type a message…'
          }
          disabled={(numbers.data?.length ?? 0) === 0}
          className="flex-1"
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={send.isPending || body.trim() === '' || (numbers.data?.length ?? 0) === 0}
        >
          {send.isPending ? 'Sending…' : 'Send'}
        </Button>
      </form>
      {send.isError && <ErrorText error={send.error} />}
    </div>
  );
}
