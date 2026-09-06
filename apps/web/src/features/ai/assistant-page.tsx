import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Bot, Send, Sparkles } from 'lucide-react';
import { Button, Empty, PageHeader, Textarea } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useAssistantSeedStore } from '../../lib/assistant-seed.js';
import { sendChatTurn, type ChatMessageWire, type ToolCallWire } from './api.js';

/**
 * The AI assistant chat page (ai/phase-15-ai-copilot-and-permissions.md §4).
 *
 * There was no frontend for `ai.chat.send` at all before this — every wave of
 * the assistant (read-only search, single-card writes, sprint planning,
 * `chat.post_message`, `docs.create_page`) shipped as a tRPC route with no way
 * for a person to actually reach it. This page is the minimum real thing that
 * closes that gap: a message list, an input, and — because §4.2's
 * confirm-before-execute is the whole safety property of every write tool —
 * an explicit Approve/Decline row for whatever the assistant is asking to do.
 *
 * ## The transcript lives in THIS component, not a store
 *
 * `ai.chat.send` is stateless by design (the route's own header): the caller
 * resends the growing array every turn. `messages` is therefore ordinary
 * `useState` here, seeded once from `useAssistantSeedStore` (the one thing
 * that DOES cross a navigation — see that file's own header) — a page nobody
 * else needs to read this conversation from has no business putting it in
 * global state.
 *
 * ## Declining is not silence
 *
 * `assistant.ts`'s own contract: an id absent from `confirmedToolCallIds` is
 * DECLINED, never "undecided". `respondToPending` always sends every pending
 * call's id in one list or the other — approved ones in
 * `confirmedToolCallIds`, nothing else — so a person choosing "Decline" on
 * one out of three pending actions gets exactly that, not all three held open.
 */

export function AssistantPage() {
  /* A seed set by the §6 bootstrap dialog before it navigated here — READ
     (not consumed) as the lazy initial value, so the page's very first
     render already shows it rather than an empty transcript that fills in a
     beat later. Reading `.seed` directly rather than calling `.take()` here
     is what keeps this initializer idempotent: React may invoke a `useState`
     initializer more than once in development (strict mode), and a function
     with a side effect (clearing the store) would silently drop the seed on
     whichever invocation React discards. */
  const [messages, setMessages] = useState<readonly ChatMessageWire[]>(
    () => useAssistantSeedStore.getState().seed ?? [],
  );
  const [pendingToolCalls, setPendingToolCalls] = useState<readonly ToolCallWire[]>([]);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);

  const turn = useMutation({
    mutationFn: sendChatTurn,
    onSuccess: (result) => {
      setMessages(result.messages);
      setPendingToolCalls(result.pendingToolCalls ?? []);
    },
  });

  /* The CONSUME half of the seed handoff — clearing the store (a Zustand
     write, not a React state update) and firing the assistant's own reply to
     it. Guarded by `seeded` rather than an empty dependency array's usual
     once-per-mount guarantee alone, because Strict Mode double-invokes
     effects in development and this must send the turn exactly once. */
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const seed = useAssistantSeedStore.getState().take();
    if (seed === null) return;
    turn.mutate({ messages: seed });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs exactly once, by the ref guard above
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, pendingToolCalls]);

  const send = () => {
    const content = draft.trim();
    if (content === '') return;
    const next = [...messages, { role: 'user' as const, content }];
    setMessages(next);
    setDraft('');
    turn.mutate({ messages: next });
  };

  const respondToPending = (approvedIds: readonly string[]) => {
    turn.mutate({ messages, confirmedToolCallIds: approvedIds });
    setPendingToolCalls([]);
  };

  const busy = turn.isPending;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 p-6">
      <PageHeader
        title="Assistant"
        description="Ask about your work, or let it make a change — every write waits for your OK first."
      />

      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-line bg-surface-raised p-4"
      >
        {messages.length === 0 && !busy ? (
          <Empty
            icon={<Sparkles aria-hidden="true" className="size-5" />}
            title="Nothing here yet"
            description="Ask a question about your projects, cards or people — the assistant only ever sees and does what you can."
          />
        ) : (
          messages
            .filter(isDisplayable)
            .map((message, index) => <MessageBubble key={index} message={message} />)
        )}

        {busy && (
          <div className="flex items-center gap-2 text-xs text-ink-faint">
            <Bot aria-hidden="true" className="size-4 animate-pulse" />
            Thinking…
          </div>
        )}
      </div>

      {pendingToolCalls.length > 0 && (
        <PendingActions calls={pendingToolCalls} disabled={busy} onRespond={respondToPending} />
      )}

      {turn.isError && <ErrorView error={turn.error} title="The assistant could not reply" />}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <Textarea
          aria-label="Message the assistant"
          placeholder="Ask the assistant…"
          rows={2}
          value={draft}
          disabled={busy || pendingToolCalls.length > 0}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          className="flex-1"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={busy || draft.trim() === '' || pendingToolCalls.length > 0}
        >
          <Send aria-hidden="true" className="size-4" />
        </Button>
      </form>
    </div>
  );
}

/**
 * Every message shown in the transcript — `tool_result` rows are the model's
 * own scratch space, not something a person reads.
 *
 * `DisplayableMessage['role']` is a chat-turn SPEAKER, a different concept
 * from an org role, but it matches guardrail 7's syntactic selector
 * (`Identifier[name='role']` in a comparison) by name alone — the identical
 * collision `packages/ai/src/anthropic.ts` already documents for
 * `AiMessage.role`. The fix is the same: a `switch` discriminant is not a
 * `BinaryExpression`, so it does not trip the rule, where `message.role ===
 * 'user'` would.
 */
type DisplayableMessage = Extract<ChatMessageWire, { role: 'user' | 'assistant' }>;

function isDisplayable(message: ChatMessageWire): message is DisplayableMessage {
  switch (message.role) {
    case 'user':
    case 'assistant':
      return true;
    case 'tool_result':
      return false;
  }
}

function MessageBubble({ message }: { readonly message: DisplayableMessage }) {
  switch (message.role) {
    case 'user':
      return (
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3.5 py-2 text-sm text-white">
            {message.content}
          </p>
        </div>
      );
    case 'assistant':
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%] space-y-2">
            {message.content !== '' && (
              <p className="rounded-2xl rounded-bl-sm bg-surface-sunken px-3.5 py-2 text-sm text-ink">
                {message.content}
              </p>
            )}
            {(message.toolCalls ?? []).map((call) => (
              <p
                key={call.id}
                className="rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-ink-faint"
              >
                Used <span className="font-mono text-ink-muted">{call.name}</span>
              </p>
            ))}
          </div>
        </div>
      );
  }
}

/**
 * §4.2's confirm-before-execute, rendered. Each call is its own row with its
 * own Approve/Decline — not one blanket "Approve all" — because a batch of
 * proposed actions is exactly the shape a person should be able to say yes to
 * SOME of, per `assistant.ts`'s own per-id semantics.
 */
function PendingActions({
  calls,
  disabled,
  onRespond,
}: {
  readonly calls: readonly ToolCallWire[];
  readonly disabled: boolean;
  readonly onRespond: (approvedIds: readonly string[]) => void;
}) {
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const [approved, setApproved] = useState<ReadonlySet<string>>(new Set());

  const decide = (id: string, approve: boolean) => {
    setDecided((current) => new Set(current).add(id));
    if (approve) setApproved((current) => new Set(current).add(id));
  };

  const allDecided = calls.every((call) => decided.has(call.id));

  return (
    <div className="space-y-2 rounded-xl border border-warning/40 bg-warning/10 p-3">
      <p className="text-xs font-medium text-ink">The assistant wants to:</p>
      <ul className="space-y-1.5">
        {calls.map((call) => (
          <li
            key={call.id}
            className="flex items-center justify-between gap-3 rounded-lg bg-surface px-2.5 py-1.5"
          >
            <span className="min-w-0 truncate font-mono text-xs text-ink">
              {call.name}
              {Object.keys(call.input).length > 0 && (
                <span className="ml-1.5 text-ink-faint">
                  {Object.entries(call.input)
                    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
                    .join(', ')}
                </span>
              )}
            </span>
            {decided.has(call.id) ? (
              <span className="shrink-0 text-xs text-ink-faint">
                {approved.has(call.id) ? 'Approved' : 'Declined'}
              </span>
            ) : (
              <span className="flex shrink-0 gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={disabled}
                  onClick={() => {
                    decide(call.id, true);
                  }}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    decide(call.id, false);
                  }}
                >
                  Decline
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {allDecided && (
        <Button
          size="sm"
          variant="primary"
          disabled={disabled}
          onClick={() => {
            onRespond([...approved]);
          }}
        >
          Continue
        </Button>
      )}
    </div>
  );
}
