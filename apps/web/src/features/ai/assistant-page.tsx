import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Bot, ChevronDown, ChevronUp, Send, Sparkles } from 'lucide-react';
import type { CardId } from '@taskflow/contracts';
import { Button, Empty, PageHeader, Textarea } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useAssistantSeedStore } from '../../lib/assistant-seed.js';
import { useSession } from '../../lib/session.js';
import { formatDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { CardQuickView } from '../work/card-quick-view.js';
import type { Priority } from '../work/api.js';
import { PRIORITY_LABEL, PRIORITY_SWATCH } from '../work/priority-colors.js';
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
 *
 * ## What the assistant can do was nowhere on this page
 *
 * A real conversation showed a person having to discover the assistant's
 * actual capabilities by trial and error — trying `search` for something it
 * cannot do, with no indication anywhere that a different tool existed for
 * it. `CAPABILITIES` is a hand-curated, human-language restatement of the
 * tool registry (`apps/api/src/ai/tools/index.ts`), not a generated one —
 * a tool's own `description`/`jsonSchema` is written for the MODEL and
 * reads like an API reference, the same reason `search`'s own tool
 * description is not what a person should see. `EXAMPLE_PROMPTS` fills a
 * text box on click rather than sending immediately, so a person can see
 * the exact phrasing that reaches a given tool and edit it before it goes
 * anywhere — "how do I call this" answered by example, not by exposing the
 * tool name itself, which nobody chatting with the assistant needs to know.
 *
 * ## A `my_cards` result renders as a real, clickable list — not the model's prose
 *
 * A real transcript showed the failure mode plainly: asked for pending
 * tasks, the assistant answered with a numbered list retyped by the model
 * from the tool's JSON, unclickable and only as accurate as the model's own
 * transcription. `myCardsEntriesFrom` looks for the real `tool_result` a
 * `my_cards` call produced (matched by `toolCallId`, not re-derived from the
 * model's reply) and, when it parses, renders the actual cards — reference,
 * title, priority, due date, each opening `CardQuickView` — the exact same
 * component and the exact same board detail panel the standup view already
 * opens a card through. The system prompt (`router.ts`) now tells the model
 * this list is shown separately and asks it to add only genuine commentary
 * rather than restate every field back in prose.
 */

const CAPABILITIES: readonly { readonly heading: string; readonly items: readonly string[] }[] = [
  {
    heading: 'Look things up',
    items: [
      'Search cards, chat messages, docs pages, and comments',
      'List what is assigned to you and still pending',
      'Look up a project’s boards, lists, and labels',
    ],
  },
  {
    heading: 'Make changes — always asks you to confirm first',
    items: [
      'Create a card, with a title and description',
      'Update a card’s title, description, dates, or priority',
      'Assign people to a card',
      'Move a card to a different status',
      'Tag a card with one or more labels',
      'Create a sprint, or add cards to one',
      'Post a message in a channel',
      'Create a new Docs page',
    ],
  },
];

const EXAMPLE_PROMPTS: readonly string[] = [
  'What am I working on this week?',
  'Create a card in the Website project titled "Fix login bug" and tag it Bug',
  'Move MOB-42 to In Review',
];

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
  // Open by default on a fresh conversation — exactly when a person most
  // needs to see what the assistant can do — and toggled from the header
  // afterward via the same button.
  const [showCapabilities, setShowCapabilities] = useState(
    () => (useAssistantSeedStore.getState().seed ?? []).length === 0,
  );
  const orgId = useSession((state) => state.orgId) ?? '';
  const [openCardId, setOpenCardId] = useState<CardId | null>(null);
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
  const resultsById = toolResultsById(messages);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 p-6">
      <PageHeader
        title="Assistant"
        description="Ask about your work, or let it make a change — every write waits for your OK first."
        actions={
          <Button
            size="sm"
            onClick={() => {
              setShowCapabilities((current) => !current);
            }}
          >
            {showCapabilities ? (
              <ChevronUp aria-hidden="true" className="size-3.5" />
            ) : (
              <ChevronDown aria-hidden="true" className="size-3.5" />
            )}
            What can I do?
          </Button>
        }
      />

      {showCapabilities && (
        <CapabilitiesPanel
          onUseExample={(prompt) => {
            setDraft(prompt);
          }}
        />
      )}

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
            .map((message, index) => (
              <MessageBubble
                key={index}
                message={message}
                resultsById={resultsById}
                onOpenCard={setOpenCardId}
              />
            ))
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

      {openCardId !== null && (
        <CardQuickView
          orgId={orgId}
          cardId={openCardId}
          onClose={() => {
            setOpenCardId(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * `CAPABILITIES`, rendered — grouped exactly as they're written above, plus
 * clickable example prompts that fill the draft box rather than sending it,
 * so a person can see the exact wording that reaches a tool and edit it
 * before anything happens.
 */
function CapabilitiesPanel({ onUseExample }: { readonly onUseExample: (prompt: string) => void }) {
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface-sunken/50 p-4 text-sm">
      <div className="grid gap-4 sm:grid-cols-2">
        {CAPABILITIES.map((group) => (
          <div key={group.heading} className="space-y-1.5">
            <p className="text-xs font-semibold text-ink-muted">{group.heading}</p>
            <ul className="space-y-1 text-xs text-ink-faint">
              {group.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="space-y-1.5 border-t border-line/60 pt-3">
        <p className="text-xs font-semibold text-ink-muted">Try one</p>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => {
                onUseExample(prompt);
              }}
              className="rounded-full border border-line/60 bg-surface px-2.5 py-1 text-xs text-ink hover:border-accent hover:text-accent"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
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
type ToolResultMessage = Extract<ChatMessageWire, { role: 'tool_result' }>;

function isDisplayable(message: ChatMessageWire): message is DisplayableMessage {
  switch (message.role) {
    case 'user':
    case 'assistant':
      return true;
    case 'tool_result':
      return false;
  }
}

/** Every `tool_result`, keyed by the `toolCallId` it answers — how a
    displayed assistant turn finds the REAL data behind one of its own
    `toolCalls`, rather than trusting the model's own retelling of it.
    A `switch` on `role`, not `===` — the identical `AiMessage.role`/guardrail
    7 name collision this file's own header already documents for
    `MessageBubble`. */
function toolResultsById(
  messages: readonly ChatMessageWire[],
): ReadonlyMap<string, ToolResultMessage> {
  const byId = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    switch (message.role) {
      case 'tool_result':
        byId.set(message.toolCallId, message);
        break;
      case 'user':
      case 'assistant':
        break;
    }
  }
  return byId;
}

interface MyCardsEntry {
  readonly cardId: string;
  readonly reference: string;
  readonly title: string;
  readonly priority: string | null;
  readonly dueDate: string | null;
}

function isMyCardsEntry(value: unknown): value is MyCardsEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['cardId'] === 'string' &&
    typeof entry['reference'] === 'string' &&
    typeof entry['title'] === 'string' &&
    (entry['priority'] === null || typeof entry['priority'] === 'string') &&
    (entry['dueDate'] === null || typeof entry['dueDate'] === 'string')
  );
}

/** `null` covers every case where this call is not a well-formed `my_cards`
    list — a different tool, a declined/errored result, or (`my_cards`'
    own "nothing pending"/"no cards" replies) a plain string — so the
    caller falls back to the ordinary "Used <tool>" chip for all of them
    rather than needing to special-case each one here. */
function myCardsEntriesFrom(
  call: ToolCallWire,
  resultsById: ReadonlyMap<string, ToolResultMessage>,
): readonly MyCardsEntry[] | null {
  if (call.name !== 'my_cards') return null;
  const result = resultsById.get(call.id);
  if (result === undefined || result.isError === true) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return null;
  }
  return Array.isArray(parsed) && parsed.every(isMyCardsEntry) ? parsed : null;
}

function MessageBubble({
  message,
  resultsById,
  onOpenCard,
}: {
  readonly message: DisplayableMessage;
  readonly resultsById: ReadonlyMap<string, ToolResultMessage>;
  readonly onOpenCard: (cardId: CardId) => void;
}) {
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
            {(message.toolCalls ?? []).map((call) => {
              const cards = myCardsEntriesFrom(call, resultsById);
              return cards !== null ? (
                <ul key={call.id} className="space-y-1">
                  {cards.map((card) => (
                    <AssistantCardRow
                      key={card.cardId}
                      card={card}
                      onOpen={() => {
                        onOpenCard(card.cardId as CardId);
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <p
                  key={call.id}
                  className="rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-ink-faint"
                >
                  Used <span className="font-mono text-ink-muted">{call.name}</span>
                </p>
              );
            })}
          </div>
        </div>
      );
  }
}

/**
 * One `my_cards` entry, rendered like `StandupCardRow` (the standup view's
 * identical shape for the identical reason) — reference, title, a priority
 * dot, and the due date, clicking through to the real card via
 * `CardQuickView`.
 */
function AssistantCardRow({
  card,
  onOpen,
}: {
  readonly card: MyCardsEntry;
  readonly onOpen: () => void;
}) {
  const priority = isPriority(card.priority) ? card.priority : null;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-start gap-1.5 rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-left text-xs hover:border-accent"
      >
        {priority !== null && (
          <span
            aria-hidden="true"
            title={PRIORITY_LABEL[priority]}
            className={cn(
              'mt-1 size-2 shrink-0 rounded-full ring-1 ring-ink/10',
              PRIORITY_SWATCH[priority],
            )}
          />
        )}
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">{card.reference}</span>
        <span className="min-w-0 flex-1 break-words text-ink">{card.title}</span>
        {card.dueDate !== null && (
          <span
            className={cn(
              'shrink-0 text-[10px] whitespace-nowrap',
              isPastDue(card.dueDate) ? 'text-danger' : 'text-ink-faint',
            )}
          >
            {formatDate(card.dueDate)}
          </span>
        )}
      </button>
    </li>
  );
}

function isPriority(value: string | null): value is Priority {
  return value === 'urgent' || value === 'high' || value === 'normal' || value === 'low';
}

/**
 * Kept as a plain function called FROM a render body rather than inlined —
 * `lib/format.ts`'s own `oooStatus` note is the precedent: the React
 * Compiler's purity rule flags `Date.now()`/`new Date()` written directly in
 * a component, so the clock has to live one call behind that.
 */
function isPastDue(dueDate: string): boolean {
  return new Date(dueDate).getTime() < Date.now();
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
