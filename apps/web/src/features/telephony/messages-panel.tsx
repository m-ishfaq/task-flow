import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { api } from '../../lib/trpc.js';
import { formatRelative } from '../../lib/format.js';
import { useToast } from '../../lib/toast-context.js';
import {
  Button,
  Empty,
  Field,
  Input,
  SearchInput,
  SkeletonRows,
} from '../../components/primitives.js';
import { CallButton } from './call-button.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
import { useIsDesktop } from '../../lib/use-media-query.js';
import {
  MESSAGE_THREADS_LIMIT,
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

/**
 * A raw E.164 string, punctuated the way a real phone shows it —
 * "(415) 555-0142" rather than "+14155550142" — the identical formatter
 * `calls-panel.tsx` uses for its own call log, duplicated rather than
 * shared since it is a small, self-contained function (the same "one-line
 * pure function, not worth a cross-file export for" precedent `digitsOf`
 * already sets in that file).
 */
function formatPhoneDisplay(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 11)}`;
  }
  if (digits.length === 12 && digits.startsWith('44')) {
    return `+44 ${digits.slice(2, 4)} ${digits.slice(4, 8)} ${digits.slice(8, 12)}`;
  }
  return e164;
}

export function MessagesPanel({ orgId }: { readonly orgId: string }) {
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const threadId = useSearch({ from: '/calls', select: (value) => value.thread });
  const threads = useQuery(messageThreadsQuery(orgId));

  const [composing, setComposing] = useState(false);

  const selectThread = (id: string | undefined) => {
    setComposing(false);
    void navigate({ to: '/calls', search: { tab: 'messages', thread: id } });
  };

  const [threadSearch, setThreadSearch] = useState('');
  const threadNeedle = threadSearch.trim().toLowerCase();
  const visibleThreads = (threads.data ?? []).filter(
    (thread) =>
      threadNeedle === '' || String(thread.counterparty).toLowerCase().includes(threadNeedle),
  );

  /* Below `md`, the thread list and an open thread can't share a phone-width
     screen — the identical split `chat-page.tsx` already uses for channels,
     driven by whether anything is open rather than a second "which pane"
     flag. At `md` and above both panes are always visible side by side,
     unchanged from before this fix. */
  const opened = composing || threadId !== undefined;
  const showList = isDesktop || !opened;
  const showDetail = isDesktop || opened;

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-[85%] flex-col p-4">
      {/* One bordered card holding both panes — the same unified shape
          `calls-panel.tsx` uses, replacing two independently floating
          columns (one boxed, one not) that used to sit directly in the
          page's own padding. */}
      <div className="flex min-h-0 flex-1 divide-line overflow-hidden rounded-xl border border-line bg-surface-raised md:divide-x">
        {showList && (
          <div className="flex min-h-0 w-full flex-col md:w-64 md:shrink-0">
            <div className="border-b border-line p-2">
              <Button
                variant="primary"
                size="sm"
                className="w-full"
                onClick={() => {
                  setComposing(true);
                }}
              >
                New message
              </Button>
            </div>

            {threads.data !== undefined && threads.data.length > 8 && (
              <div className="border-b border-line p-2">
                <SearchInput
                  value={threadSearch}
                  onChange={setThreadSearch}
                  placeholder="Search by number…"
                />
              </div>
            )}

            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
              {threads.isPending ? (
                <SkeletonRows rows={4} />
              ) : threads.isError ? (
                <ErrorView error={threads.error} title="Could not load threads" />
              ) : threads.data.length === 0 ? (
                <Empty
                  title="No SMS conversations yet"
                  description="Inbound texts to your numbers land here."
                />
              ) : visibleThreads.length === 0 ? (
                <p className="px-2 py-3 text-xs text-ink-faint">No threads match your search.</p>
              ) : (
                visibleThreads.map((thread) => (
                  <button
                    key={thread.threadId}
                    type="button"
                    onClick={() => {
                      selectThread(thread.threadId);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors duration-(--motion-fast)',
                      thread.threadId === threadId
                        ? 'border-suite-calls/40 bg-suite-calls/10'
                        : 'border-transparent hover:bg-surface-hover',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-xs text-ink">
                          {formatPhoneDisplay(String(thread.counterparty))}
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
              {threads.data?.length === MESSAGE_THREADS_LIMIT && (
                <p className="px-2 py-2 text-center text-xs text-ink-faint">
                  Showing your most recent {MESSAGE_THREADS_LIMIT} threads.
                </p>
              )}
            </div>
          </div>
        )}

        {showDetail && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {composing ? (
              <ComposeView
                orgId={orgId}
                onSent={(newThreadId) => {
                  selectThread(newThreadId);
                }}
                onCancel={() => {
                  setComposing(false);
                }}
              />
            ) : threadId === undefined ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                <p className="text-sm font-medium text-ink">No conversation open</p>
                <p className="max-w-xs text-xs text-ink-muted">
                  Pick a thread on the left, or start a new message.
                </p>
              </div>
            ) : (
              <ThreadView
                key={threadId}
                orgId={orgId}
                threadId={threadId}
                onBack={() => {
                  selectThread(undefined);
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ComposeView({
  orgId,
  onSent,
  onCancel,
}: {
  readonly orgId: string;
  readonly onSent: (threadId: string) => void;
  readonly onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const numbers = useQuery(phoneNumbersQuery(orgId));

  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [fromPhoneNumberId, setFromPhoneNumberId] = useState('');
  const activeNumber =
    fromPhoneNumberId !== '' ? fromPhoneNumberId : (numbers.data?.[0]?.phoneNumberId ?? '');

  const send = useMutation({
    mutationFn: () =>
      api.telephony.messages.send.mutate({
        to: to.trim(),
        fromPhoneNumberId: activeNumber,
        body: body.trim(),
      }),
    onSuccess: async (result) => {
      await invalidateAfterMessage(queryClient, orgId, result.threadId);
      onSent(result.threadId);
    },
    onError: (error) => {
      toast.failure('The message was not sent', error);
    },
  });

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (to.trim() !== '' && body.trim() !== '') send.mutate();
      }}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-xs font-medium text-ink">New message</span>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto min-h-8 rounded-md px-2 py-1 text-[11px] text-ink-muted transition-colors duration-(--motion-fast) hover:text-ink"
        >
          Cancel
        </button>
      </div>

      <div className="space-y-3 px-3 py-3">
        <div className="flex flex-wrap items-start gap-2">
          <Field label="To" htmlFor="sms-to" hint="E.164, e.g. +14155550100">
            <Input
              id="sms-to"
              value={to}
              className="w-44"
              placeholder="+14155550100"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setTo(event.target.value);
              }}
            />
          </Field>

          {(numbers.data?.length ?? 0) > 1 && (
            <Field label="From" htmlFor="sms-from">
              <select
                id="sms-from"
                value={activeNumber}
                onChange={(event) => {
                  setFromPhoneNumberId(event.target.value);
                }}
                className="h-9 min-w-36 rounded-md border border-line bg-surface-sunken px-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
              >
                {(numbers.data ?? []).map((number) => (
                  <option key={number.phoneNumberId} value={number.phoneNumberId}>
                    {String(number.e164)}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <Field label="Message" htmlFor="sms-body">
          <textarea
            id="sms-body"
            value={body}
            rows={4}
            maxLength={1600}
            placeholder="Type a message…"
            onChange={(event) => {
              setBody(event.target.value);
            }}
            className="w-full rounded-md border border-line bg-surface-sunken px-2.5 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
          />
        </Field>

        <div className="flex items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={
              send.isPending || activeNumber === '' || to.trim() === '' || body.trim() === ''
            }
          >
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
          {activeNumber === '' && (
            <span className="text-xs text-warning">Buy a number before sending.</span>
          )}
        </div>

        {send.isError && <ErrorText error={send.error} />}
      </div>
    </form>
  );
}

function ThreadView({
  orgId,
  threadId,
  onBack,
}: {
  readonly orgId: string;
  readonly threadId: string;
  readonly onBack: () => void;
}) {
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to conversations"
          className="shrink-0 p-1.5 rounded-md md:hidden"
        >
          <ChevronLeft aria-hidden="true" className="size-4 text-ink-faint" />
        </button>
        <span className="font-mono text-xs font-medium text-ink">
          {counterparty === undefined ? '…' : formatPhoneDisplay(counterparty)}
        </span>
        <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px] text-ink-muted">
          SMS
        </span>
        <CallButton orgId={orgId} to={counterparty ?? ''} className="ml-auto" />
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
            className="h-9 rounded-md border border-line bg-surface-sunken px-2 text-xs text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25"
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
