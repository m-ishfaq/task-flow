import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Bot, ChevronDown, ChevronUp, Send, Sparkles } from 'lucide-react';
import type { CardId } from '@taskflow/contracts';
import { Button, Empty, PageHeader } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useAssistantSeedStore } from '../../lib/assistant-seed.js';
import { useSession } from '../../lib/session.js';
import { CardQuickView } from '../work/card-quick-view.js';
import { MarkdownLite } from './markdown-lite.js';
import { AssistantComposer, type AssistantComposerHandle } from './assistant-composer.js';
import { stripReferenceEmbeds } from './entity-reference.js';
import { sendChatTurn, windowForRequest, type ChatMessageWire, type ToolCallWire } from './api.js';
import { renderToolResult, toolResultsById } from './tool-results.js';

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
 * ## The full transcript stays local forever; only a window gets SENT
 *
 * `messages` grows without bound as a conversation continues, but
 * `ai.chat.send`'s `ChatSendInput.messages` caps at 40 — real input-size
 * hygiene, not a promise about how long a conversation may run. A real
 * conversation crossed that cap and got a hard `BAD_REQUEST` with no way to
 * continue. The fix is not raising the cap or dropping what a person can
 * see: `send`/`respondToPending`/the seed effect all pass `messages` through
 * `windowForRequest` (`api.ts`) before sending, and `onSuccess` appends only
 * the NEW suffix of what comes back (`result.messages.slice(sentCount)`)
 * onto the untouched full history, rather than replacing `messages` with the
 * server's own (windowed) view of the conversation.
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
 * ## EVERY tool's result renders as real UI, never the model's retyping of it
 *
 * The first version of this idea only covered `my_cards` — and the very
 * next report showed why a one-tool fix was the wrong shape: asked to list
 * every project's boards and sprints, the assistant answered with the
 * model's own nested bullet-point retelling of `list_projects`/
 * `list_boards`' JSON, because nothing on this page knew those results
 * were data either. Every tool in `apps/api/src/ai/tools/index.ts`'s
 * registry already returns real JSON as its `ToolResult.content` — that
 * was never the gap — so `tool-results.tsx` now holds ONE renderer per
 * tool name, dispatched generically by `renderToolResult` for every
 * `toolCalls` entry on every assistant message, not a single special case
 * grown ad hoc per bug report. A renderer reads the REAL `tool_result` (via
 * `toolResultsById`, matched by `toolCallId`), never the model's retelling
 * of it, and falls back to the plain "Used `<tool>`" chip only when it does
 * not recognize the shape — a future tool this file has not been taught
 * about yet, not a routine failure mode. See `tool-results.tsx`'s own
 * header for the full design (how a write tool's identity is read from its
 * CALL's input rather than needing backend output changes, and why error
 * results are rendered per-tool rather than generically). The system
 * prompt (`router.ts`) was widened the same way, generally telling the
 * model every tool's structured result is already shown, not just
 * `my_cards`'.
 *
 * ## The model's own prose renders through `MarkdownLite`, not a bare `<p>`
 *
 * `message.content` used to go straight into `<p>{message.content}</p>` —
 * fine for the one-sentence commentary the system prompt mostly asks for,
 * and wrong the moment the model has to answer something with no tool
 * behind it at all (a fixed-enum question like "what priorities can I set"
 * has no `list_*` tool to render, so the model answers in its own words).
 * The reply came back as literal `1. Urgent 2. High...` markdown syntax,
 * never an actual list. `markdown-lite.tsx`'s own header explains the
 * scope (bold + lists only, real React elements, never
 * `dangerouslySetInnerHTML`) and why a full markdown library would be more
 * surface than a one-sentence reply ever needs.
 */

const CAPABILITIES: readonly { readonly heading: string; readonly items: readonly string[] }[] = [
  {
    heading: 'Look things up',
    items: [
      'Search cards, messages, docs, and comments',
      'What’s assigned to you and still open',
      'A project’s boards, sprints, labels, statuses, and members',
      'Channels and DMs you can see',
    ],
  },
  {
    heading: 'Make changes — always confirmed first',
    items: [
      'Create a card with assignees, labels, priority, due date, and sprint all at once',
      'Update, assign, unassign, or tag a card, or set its status',
      'Move a card to a different list — even on a different board',
      'Comment on a card, tagging people',
      'Create a sprint, or add cards to one',
      'Post a message in a channel or start a DM, or create a Docs page',
    ],
  },
];

/** How to point at a specific thing. The first four are real triggers —
    typing the character opens a picker that inserts an already-resolved
    reference, never a name the model has to look up and possibly
    mismatch. A card's reference and a label's name are the two exceptions:
    a card is typed directly (find_card resolves it), and a label has no
    picker since tagging a card is itself a confirmed step. */
const REFERENCE_HINTS: readonly { readonly label: string; readonly example: string }[] = [
  { label: 'A person', example: '@Priya' },
  { label: 'A project', example: '#Website' },
  { label: 'A board', example: '&Delivery' },
  { label: 'A sprint', example: '%Sprint 14' },
  { label: 'A list', example: '~Todo' },
  { label: 'A card', example: 'WEB-142' },
];

/* Plain text, inserted via `insertPlainText` on click — these demonstrate
   the PHRASING, not a real picker interaction, so a trigger character shown
   here (e.g. `#Website`) lands as literal characters, not a resolved
   mention. Retyping the `#` after clicking one in is what actually opens
   the picker and gets the "zero error" benefit `entity-reference.ts`'s own
   header describes. */
const EXAMPLE_PROMPTS: readonly string[] = [
  'What am I working on this week?',
  'Create a card in #Website / &Delivery / ~Todo, "Fix login bug", assign @Priya, due Friday',
  'Move WEB-142 to In Review',
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
  const composerRef = useRef<AssistantComposerHandle>(null);
  const [draftEmpty, setDraftEmpty] = useState(true);
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

  /* `variables.messages` is the WINDOWED array actually sent (see
     `windowForRequest`'s own header) — never the full local transcript once
     a conversation has grown past the server's cap. `result.messages` is
     always exactly that window plus whatever new turns this call produced
     (`runAssistantTurn`'s own contract: `[...transcript, ...newTurns]`), so
     slicing off the sent length and appending the remainder onto the FULL
     local history is what lets the transcript displayed on screen keep
     growing forever even though what gets sent to the server does not. */
  const turn = useMutation({
    mutationFn: sendChatTurn,
    onSuccess: (result, variables) => {
      const sentCount = variables.messages.length;
      setMessages((current) => [...current, ...result.messages.slice(sentCount)]);
      setPendingToolCalls(result.pendingToolCalls ?? []);
    },
  });

  /* The CONSUME half of the seed handoff — firing the assistant's own reply
     to whatever this instance already peeked into `messages` above, and
     best-effort clearing the store so an unrelated LATER visit to
     `/assistant` never replays it. Guarded by `seeded` rather than an empty
     dependency array's usual once-per-mount guarantee alone, because Strict
     Mode double-invokes effects in development and this must send the turn
     exactly once.

     Deliberately reads `messages` here rather than trusting
     `.take()`'s own return value for the content sent — this effect's
     dependency array is `[]`, so the `messages` this closure sees is
     always exactly the FIRST render's value, i.e. exactly what the page
     already committed to displaying. `.take()` is still called, purely to
     clear the store; trusting its RETURN VALUE for content was the bug:
     found from a real report where the setup dialog's opening message
     showed up on `/assistant` but the assistant never replied and the page
     never recovered — `busy` never turned `true`, nothing was ever pending
     to approve or decline. A second, independently-constructed
     `AssistantPage` racing this exact seed hand-off is the only way that
     shape is reachable — some earlier construction's own effect had
     already called `.take()` and fired the real request (a valid response
     for it is what a network capture showed), while THIS instance's own
     `.take()` call, later, found nothing left to consume — even though its
     own `messages` peek had already committed to showing the seeded
     message. Sending from the already-displayed `messages` instead means
     this instance never depends on winning a race against another instance
     for content it already promised to show. */
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    useAssistantSeedStore.getState().take();
    if (messages.length === 0) return;
    turn.mutate({ messages: windowForRequest(messages) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs exactly once, by the ref guard above; `messages` here is always the first render's value, by design
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, pendingToolCalls]);

  const send = () => {
    // Belt-and-suspenders: the Send button and the composer itself are both
    // already `disabled` while a turn is in flight or a batch of tool calls
    // is awaiting Approve/Decline, so this should be unreachable in normal
    // use — but `AssistantComposer`'s Enter-key handler is a second path
    // into this function, and a UI-only gate that this function itself
    // trusts blindly is exactly the shape of bug that gate just had (see
    // `assistant-composer.tsx`'s own fix). Refusing here too means a future
    // caller cannot reintroduce the same class of bug by adding a third path.
    if (busy || pendingToolCalls.length > 0) return;
    // `getText()` is the composer's ENRICHED serialization — any mentioned
    // person/project/board/sprint/list carries its real id inline
    // (`entity-reference.ts`'s own header), not just what a person sees
    // while typing. That is exactly what should be sent; only DISPLAY of a
    // sent message strips it back out (`MessageBubble`'s `user` case).
    const content = composerRef.current?.getText().trim() ?? '';
    if (content === '') return;
    const next = [...messages, { role: 'user' as const, content }];
    setMessages(next);
    composerRef.current?.clear();
    turn.mutate({ messages: windowForRequest(next) });
  };

  const respondToPending = (approvedIds: readonly string[]) => {
    /* Deliberately does NOT clear `pendingToolCalls` here — `onSuccess`
       above already sets it to whatever the resumed turn's own result says
       (empty, or a fresh batch if the model asks for more §4.2
       confirmation). Clearing it eagerly, before this mutation resolves,
       opened a real race: with `pendingToolCalls.length` at 0, the
       composer's `disabled={busy || pendingToolCalls.length > 0}` depends
       on `busy` alone to still block it, and a person fast enough (or a
       render landing between the two) could send a NEW message while this
       request was still in flight. That message got appended, in local
       state, straight after the still-unresolved confirmation turn — a
       transcript shape `pendingCallsIn` (which only ever looks at the LAST
       message) cannot see coming, and forwarding it produced a real
       provider-level failure ("tool_call_ids did not have response
       messages"), found from a live transcript. Leaving `pendingToolCalls`
       populated keeps the composer AND this panel's own Approve/Decline
       correctly disabled (via `busy`) for the whole round trip instead. */
    turn.mutate({ messages: windowForRequest(messages), confirmedToolCallIds: approvedIds });
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
            composerRef.current?.insertPlainText(prompt);
            composerRef.current?.focus();
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
            // The panel above already explains what to ask and how to
            // reference things when it's open — repeating that here is
            // exactly the duplication a real report called out. Only when
            // it's collapsed does this need to say anything more than
            // "type below."
            {...(showCapabilities
              ? {}
              : { description: 'Open "What can I do?" above, or just ask.' })}
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
        <PendingActions
          // Keyed by the batch's own call ids, not the array index or
          // nothing at all — `pendingToolCalls` no longer becomes briefly
          // empty between two batches (see `respondToPending`'s own
          // comment), so this component no longer unmounts/remounts for
          // free between them. Without a key tied to the batch's actual
          // identity, its internal `decided`/`approved` state (keyed by
          // call.id) would carry over into a NEW batch — usually harmless
          // since a fresh completion mints fresh ids, but Gemini's own
          // `AiToolCall.id`s are synthesized as `"<name>::<index>"`
          // (`packages/ai/src/gemini.ts`), which two unrelated rounds can
          // collide on, silently treating a brand-new pending call as
          // already decided.
          key={pendingToolCalls.map((call) => call.id).join('|')}
          calls={pendingToolCalls}
          disabled={busy}
          onRespond={respondToPending}
        />
      )}

      {turn.isError && <ErrorView error={turn.error} title="The assistant could not reply" />}

      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div className="flex-1">
          <AssistantComposer
            ref={composerRef}
            disabled={busy || pendingToolCalls.length > 0}
            onSubmit={send}
            onEmptyChange={setDraftEmpty}
            placeholder="Ask the assistant… (@ for a person, # project, & board, % sprint, ~ list)"
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || draftEmpty || pendingToolCalls.length > 0}
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
      {/* A literal " · " between entries, not CSS gap alone — the identical
          collapse-on-copy bug `tool-results.tsx`'s own header now documents
          for a `Badge` row applies just as much to plain adjacent `<span>`s. */}
      <p className="border-t border-line/60 pt-3 text-xs text-ink-faint">
        <span className="font-semibold text-ink-muted">Point at things: </span>
        {REFERENCE_HINTS.map((hint, index) => (
          <span key={hint.label}>
            {index > 0 && ' · '}
            {hint.label} (<span className="font-mono text-ink-muted">{hint.example}</span>)
          </span>
        ))}
      </p>
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

function isDisplayable(message: ChatMessageWire): message is DisplayableMessage {
  switch (message.role) {
    case 'user':
    case 'assistant':
      return true;
    case 'tool_result':
      return false;
  }
}

function MessageBubble({
  message,
  resultsById,
  onOpenCard,
}: {
  readonly message: DisplayableMessage;
  readonly resultsById: ReturnType<typeof toolResultsById>;
  readonly onOpenCard: (cardId: CardId) => void;
}) {
  switch (message.role) {
    case 'user':
      // The composer's own serialization embeds a resolved id after every
      // mention (`entity-reference.ts`'s own header) — real for the model
      // to read, never for a person to see in their own sent bubble.
      return (
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3.5 py-2 text-sm text-white">
            {stripReferenceEmbeds(message.content)}
          </p>
        </div>
      );
    case 'assistant':
      return (
        <div className="flex justify-start">
          <div className="max-w-[85%] space-y-2">
            {message.content !== '' && (
              <div className="rounded-2xl rounded-bl-sm bg-surface-sunken px-3.5 py-2 text-sm text-ink">
                <MarkdownLite text={message.content} />
              </div>
            )}
            {(message.toolCalls ?? []).map((call) => {
              const rendered = renderToolResult(call, resultsById, { onOpenCard });
              return (
                <div key={call.id}>
                  {rendered ?? (
                    <p className="rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-ink-faint">
                      Used <span className="font-mono text-ink-muted">{call.name}</span>
                    </p>
                  )}
                </div>
              );
            })}
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
