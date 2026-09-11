import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import { api } from '../../lib/trpc.js';
import { formatRelative } from '../../lib/format.js';
import { useToast } from '../../lib/toast-context.js';
import { Button, Empty, Field, Input, SkeletonRows } from '../../components/primitives.js';
import { CallButton } from './call-button.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
import { useIsDesktop } from '../../lib/use-media-query.js';
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
  const isDesktop = useIsDesktop();
  const threadId = useSearch({ from: '/calls', select: (value) => value.thread });
  const threads = useQuery(messageThreadsQuery(orgId));

  /* Composing is local state rather than another search param: an unsent draft
     is not something a shared link should reconstitute, and `thread` already
     owns the shareable half of this view. */
  const [composing, setComposing] = useState(false);

  const selectThread = (id: string | undefined) => {
    setComposing(false);
    void navigate({ to: '/calls', search: { tab: 'messages', thread: id } });
  };

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
              {/* Until this existed there was NO way to start an SMS from the
                  UI — the composer lived only inside an already-open thread,
                  and threads are created by inbound messages. So the first
                  outbound message to anyone required calling the API by hand. */}
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
                      /* Calls' own suite hue for "this is the open thread" —
                         the same module-identity fix already applied to
                         Chat's active channel row and Docs' active page. */
                      thread.threadId === threadId
                        ? 'border-suite-calls/40 bg-suite-calls/10'
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

/**
 * Starting a NEW conversation.
 *
 * `messages.send` is addressed by `to` + `fromPhoneNumberId`, never by thread —
 * a thread is a consequence of a message, not a prerequisite for one — so this
 * is the same mutation the in-thread composer calls, with the destination typed
 * rather than read off an existing row. The reply it produces comes back with
 * the thread id the server either found or created, which is what gets opened.
 */
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
  /* Same defaulting rule as calls-panel: what the select DISPLAYS is what gets
     submitted. Sending the raw state instead means a sender who accepts the
     default posts an empty id and gets `Invalid uuid` from a form that looked
     complete. */
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
          className="ml-auto text-[11px] text-ink-muted hover:text-ink"
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
                className="h-9 min-w-36 rounded-md border border-line bg-surface-sunken px-2 text-sm text-ink focus:border-accent focus:outline-none"
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
            className="w-full rounded-md border border-line bg-surface-sunken px-2.5 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
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
            <span className="text-[11px] text-warning">Buy a number before sending.</span>
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
  /** Below `md`, returns to the thread list — see `MessagesPanel`'s own comment. */
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
          className="shrink-0 md:hidden"
        >
          <ChevronLeft aria-hidden="true" className="size-4 text-ink-faint" />
        </button>
        <span className="font-mono text-xs font-medium text-ink">{counterparty ?? '…'}</span>
        <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px] text-ink-muted">
          SMS
        </span>
        {/* The counterparty's number is already resolved here — this is the
            cheapest click-to-call surface in the app, and PLAN.md §3.4 asks
            for it from "any card/contact/chat thread". */}
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
            className="h-9 rounded-md border border-line bg-surface-sunken px-2 text-xs text-ink focus:border-accent focus:outline-none"
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
