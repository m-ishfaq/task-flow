import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  GitPullRequest,
  MessageCircle,
  PencilLine,
  Search as SearchIcon,
  Send,
  Sparkles,
  SquarePen,
} from 'lucide-react';
import type { CardId } from '@taskflow/contracts';
import { Avatar, Button, Empty, PageContainer, PageHeader } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
import { useAssistantSeedStore } from '../../lib/assistant-seed.js';
import { useSession } from '../../lib/session.js';
import { CardQuickView } from '../work/card-quick-view.js';
import { useMembers, type Person } from '../org/use-members.js';
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

/**
 * A hand-curated, human-language restatement of the tool registry
 * (`apps/api/src/ai/tools/index.ts`) — not generated from it, per this
 * file's own header: a tool's `description`/`jsonSchema` is written for the
 * MODEL and reads like an API reference, the wrong thing to show a person.
 *
 * Kept in sync BY HAND with the real registry, the same trade
 * `packages/tokens` accepts for `apps/web/src/styles.css`'s `@theme` block —
 * the GitHub/PR group below is what closes the exact gap a real report
 * found: every wave of Phase 15 §7 (read PRs, write reviews, link a card to
 * one) had shipped as real tools with nothing on this page ever telling a
 * person they existed.
 */
const CAPABILITIES: readonly {
  readonly heading: string;
  readonly icon: ReactNode;
  readonly items: readonly string[];
}[] = [
  {
    heading: 'Find things',
    icon: <SearchIcon aria-hidden="true" className="size-3.5" />,
    items: [
      'Search cards, messages, docs, and comments',
      'What’s assigned to you and still open',
      'A project’s boards, sprints, labels, statuses, and members',
      'Channels and DMs you can see',
    ],
  },
  {
    heading: 'Make changes — always confirmed first',
    icon: <PencilLine aria-hidden="true" className="size-3.5" />,
    items: [
      'Create a card with assignees, labels, priority, due date, and sprint all at once',
      'Update, assign, unassign, or tag a card, or set its status',
      'Move a card to a different list — even on a different board',
      'Comment on a card, tagging people',
      'Create a sprint, or add cards to one',
    ],
  },
  {
    heading: 'Chat & Docs',
    icon: <MessageCircle aria-hidden="true" className="size-3.5" />,
    items: ['Post a message in a channel or start a DM, tagging people', 'Create a new Docs page'],
  },
  {
    heading: 'GitHub & pull requests',
    icon: <GitPullRequest aria-hidden="true" className="size-3.5" />,
    items: [
      'List pull requests — open, closed, or all — on the connected repo',
      'Read a PR’s diff, its comments (conversation and inline review), or a specific file’s ' +
        'full content',
      'Post a comment, or request changes, on a PR',
      'Merge or close a PR',
      'Link a card to the PR that implements it, and see what’s already linked',
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
  { label: 'A person', example: '@Moosa' },
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
  'List all the tools you have',
  'What am I working on this week?',
  'Create a card in',
  'Move the card',
  'What are the overdue tasks for',
  'List the open PRs',
  'Link card to the PR#',
  'What did reviewers say on PR #',
];

/**
 * The assistant's own brand mark — a solid indigo square with a sparkle,
 * Design Bible §12's own page-header identity mark, reused unchanged as the
 * per-message avatar and the "Thinking…" indicator so every place this page
 * speaks carries the identical mark, rather than the page header showing one
 * icon and each reply showing a different one (a faint outlined circle with
 * a `Bot` glyph, what this used to be). A circle would collide with
 * `Avatar`'s own shape for a PERSON; staying square is what keeps "the
 * assistant" reading as a distinct kind of thing from "a person" at a glance,
 * the same distinction `OrgBadge`'s own square already draws against `Avatar`.
 */
function AiMark({ size = 'sm' }: { readonly size?: 'sm' | 'lg' }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent/70 text-white shadow-xs',
        size === 'lg' ? 'size-9' : 'size-6',
      )}
    >
      <Sparkles
        aria-hidden="true"
        className={size === 'lg' ? 'size-4' : 'size-3.5'}
        strokeWidth={2}
      />
    </span>
  );
}

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
  /* Closed by default, always — the wide-screen `<aside>` below is a SEPARATE,
     unconditionally-rendered instance of this same panel (`variant="sidebar"`)
     that never reads this state at all, so there was never anything for a
     "true on wide screens" default to actually show. That stale true value
     used to survive a resize: start wide (state initialized true, invisible —
     the inline block is `lg:hidden` at that width), then shrink the window
     below 1024px with no remount, and the now-relevant inline panel popped
     open uninvited, on exactly the small/inline-variant screen this was
     supposed to stay closed on. Starting `false` unconditionally means there
     is no stale true value left to carry across a resize. */
  const [showCapabilities, setShowCapabilities] = useState(false);
  const orgId = useSession((state) => state.orgId) ?? '';
  const currentUserId = useSession((state) => state.userId) ?? '';
  const { personOf } = useMembers();
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

  /* No route/state gates this — the composer's own `disabled` already
     covers "a turn is in flight" and "a batch is awaiting Approve/Decline",
     so allowing a reset in either state would either discard messages an
     in-flight mutation is about to append to (stale `onSuccess` writing
     into a transcript that has moved on) or abandon a pending confirmation
     with no record of what was declined. Disabled for the identical reason
     the composer itself is. */
  const resetConversation = () => {
    setMessages([]);
    setPendingToolCalls([]);
    // Same default the initializer uses: closed, always — see its own
    // comment for why a wide-screen "open" default here would be dead
    // weight the inline panel doesn't need (the sidebar is separate).
    setShowCapabilities(false);
    // `turn`'s own error/data from the PREVIOUS conversation otherwise
    // survives the reset — `useMutation` keeps its last result until a new
    // mutation runs or `reset()` is called, so without this a fresh, empty
    // transcript rendered "Nothing here yet" with the old "assistant could
    // not reply" banner still sitting underneath it, found the moment this
    // button was first clicked after a failed turn.
    turn.reset();
    composerRef.current?.clear();
    composerRef.current?.focus();
  };

  const busy = turn.isPending;
  const resultsById = toolResultsById(messages);
  const useExample = (prompt: string) => {
    composerRef.current?.insertPlainText(prompt);
    composerRef.current?.focus();
  };

  return (
    /* `maxWidth="2xl"` — the same tier `platform-admin-page.tsx`/`audit-
       page.tsx`/`home-page.tsx` use for their own widest content, replacing
       a one-off `max-w-350` (87.5rem) found nowhere else in the app; the
       two-column chat-plus-sidebar layout below fits comfortably in `2xl`'s
       80rem. `overflow-y-hidden` stays a plain class here rather than
       PageContainer's own concern — this is the one page whose OWN scroll
       region is the message list, not the page itself. */
    <PageContainer maxWidth="2xl" className="flex h-full gap-6 overflow-y-hidden">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <PageHeader
          title="Assistant"
          description="Ask about your work, or let it make a change — every write waits for your OK first."
          icon={<Sparkles aria-hidden="true" className="size-4" strokeWidth={2} />}
          actions={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || pendingToolCalls.length > 0}
                onClick={resetConversation}
              >
                <SquarePen aria-hidden="true" className="size-3.5" />
                New conversation
              </Button>
              {/* The sidebar below covers this on large screens — the toggle
                  (and the panel it opens) exist only for the width the
                  sidebar is hidden at. */}
              <Button
                size="sm"
                className="lg:hidden"
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
            </div>
          }
        />

        {showCapabilities && (
          <div className="lg:hidden">
            <CapabilitiesPanel onUseExample={useExample} />
          </div>
        )}

        <div
          ref={listRef}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-line bg-surface-raised p-4 lg:p-6"
        >
          {messages.length === 0 && !busy ? (
            <Empty
              icon={<Sparkles aria-hidden="true" className="size-5" />}
              title="Nothing here yet"
              description="Try one of the prompts on the side, or just type your question below."
            />
          ) : (
            messages
              .filter(isDisplayable)
              .map((message, index) => (
                <MessageBubble
                  key={index}
                  message={message}
                  resultsById={resultsById}
                  orgId={orgId}
                  onOpenCard={setOpenCardId}
                  currentUser={currentUserId === '' ? null : personOf(currentUserId)}
                />
              ))
          )}

          {busy && (
            <div className="flex items-center gap-2.5">
              <span className="animate-pulse">
                <AiMark />
              </span>
              <span className="text-xs text-ink-faint">Thinking…</span>
            </div>
          )}

          {/* Rendered INSIDE the scroll region, directly after the messages —
              Design Bible §12's own `.pending` row sits inside the very
              assistant bubble that proposed the action, not in a separate
              box floating between the transcript and the composer. Nesting
              it one level deeper than that (inside `MessageBubble` itself)
              would need `pendingToolCalls` threaded per-message instead of
              as one flat list — real, avoidable churn for what is, in
              practice, always the tail end of the LAST assistant turn
              (`assistant.ts`'s own contract: a deferred turn's toolCalls
              are exactly the pending ones). Keeping it here, just moved
              into the scrollable flow, gets the same visual proximity with
              no state-shape change. */}
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
        </div>

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
      </div>

      {/* Persistent on wide screens — the same content the mobile toggle
          above opens inline, just never collapsed here since the width to
          show it alongside the conversation is exactly what's available. */}
      <aside className="hidden w-80 shrink-0 lg:block overflow-y-auto">
        <div className="sticky top-6">
          <CapabilitiesPanel onUseExample={useExample} variant="sidebar" />
        </div>
      </aside>

      {openCardId !== null && (
        <CardQuickView
          orgId={orgId}
          cardId={openCardId}
          onClose={() => {
            setOpenCardId(null);
          }}
        />
      )}
    </PageContainer>
  );
}

/**
 * `CAPABILITIES`/`EXAMPLE_PROMPTS`/`REFERENCE_HINTS`, rendered.
 *
 * REDESIGNED after a direct report: the original layout put every capability
 * bullet on screen at once, in full sentences, with the actual actionable
 * part — the clickable example prompts — pushed to the very bottom, under
 * all of it. That is backwards for what a person actually does with this
 * panel: skim for "can it do X," then click something to try. The example
 * prompts now come FIRST, and the full capability list is one `<details>`
 * disclosure away rather than always-on text — the same native, JS-free
 * collapsible `calls-panel.tsx`'s own transcript expander already uses.
 * Nothing was cut; the same four groups and every item still exist, just
 * not painted on screen unless someone actually asks to see them.
 */
/**
 * `variant="inline"` (default) is the mobile/narrow-screen collapsible
 * panel — dashed off from the conversation like every other "extra info"
 * block in this app. `variant="sidebar"` is the same content, permanently
 * visible in the wide-screen aside, so it drops the border a floating panel
 * needs (the aside itself provides the visual separation) and gives the
 * capability groups room to stack full-width instead of competing for a
 * two-column grid at 320px.
 */
function CapabilitiesPanel({
  onUseExample,
  variant = 'inline',
}: {
  readonly onUseExample: (prompt: string) => void;
  readonly variant?: 'inline' | 'sidebar';
}) {
  const isSidebar = variant === 'sidebar';

  return (
    <div
      className={cn(
        'space-y-4 rounded-xl p-4',
        isSidebar
          ? 'bg-surface-raised ring-1 ring-line/50'
          : 'border border-line/70 bg-surface-sunken/40',
      )}
    >
      <div className="space-y-2">
        <p className="text-xs font-medium text-ink-faint">Try asking</p>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => {
                onUseExample(prompt);
              }}
              className="rounded-full border border-line/50 bg-surface px-2.5 py-1 text-[12px] text-ink-muted transition-colors hover:border-accent/60 hover:text-accent"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>

      {/* No default marker — `ChevronRight` below is the disclosure
          indicator, rotated open via the `group-open:` variant, so the
          native `<details>` triangle would just be a second, redundant one
          sitting next to it. */}
      <details className="group border-t border-line/50 pt-3 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-ink-faint hover:text-ink-muted">
          <ChevronRight
            aria-hidden="true"
            className="size-3 shrink-0 transition-transform group-open:rotate-90"
          />
          Everything it can do
        </summary>
        <div
          className={cn('mt-3 gap-x-5 gap-y-3', isSidebar ? 'space-y-3' : 'grid sm:grid-cols-2')}
        >
          {CAPABILITIES.map((group) => (
            <div key={group.heading} className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-ink-faint">
                <span className="opacity-70">{group.icon}</span>
                {group.heading}
              </p>
              <ul className="space-y-1 pl-0.5 text-[12px] leading-relaxed text-ink-faint">
                {group.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>

      {/* A literal " · " between entries, not CSS gap alone — the identical
          collapse-on-copy bug `tool-results.tsx`'s own header now documents
          for a `Badge` row applies just as much to plain adjacent `<span>`s. */}
      <p className="border-t border-line/50 pt-3 text-xs text-ink-faint/90">
        <span className="font-medium text-ink-faint">Point at things: </span>
        {REFERENCE_HINTS.map((hint, index) => (
          <span key={hint.label}>
            {index > 0 && ' · '}
            {hint.label} (<span className="font-mono">{hint.example}</span>)
          </span>
        ))}
      </p>
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
  orgId,
  onOpenCard,
  currentUser,
}: {
  readonly message: DisplayableMessage;
  readonly resultsById: ReturnType<typeof toolResultsById>;
  readonly orgId: string;
  readonly onOpenCard: (cardId: CardId) => void;
  /** `null` while the member list hasn't loaded yet, or the caller is not
      resolvable (a role with no `member:read`) — the bubble still renders,
      just without the avatar, the same "degrade, don't block" `personOf`
      itself already promises for an unknown id. */
  readonly currentUser: Person | null;
}) {
  switch (message.role) {
    case 'user':
      // The composer's own serialization embeds a resolved id after every
      // mention (`entity-reference.ts`'s own header) — real for the model
      // to read, never for a person to see in their own sent bubble.
      return (
        <div className="flex items-end justify-end gap-2">
          <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-white">
            {stripReferenceEmbeds(message.content)}
          </p>
          {/* Matches Design Bible §12's own sent-message avatar — the same
              `Avatar` every other surface in this app already uses for a
              person, so "who sent this" reads identically here as it does
              on a card's own comment thread. Omitted rather than shown as a
              placeholder when unresolved, per `currentUser`'s own doc
              comment above. */}
          {currentUser !== null && (
            <Avatar userId={currentUser.userId} label={currentUser.label} size="sm" />
          )}
        </div>
      );
    case 'assistant':
      return (
        <div className="flex items-start gap-2.5">
          {/* A small avatar mark, the same "who's speaking" cue Claude/
              ChatGPT both use — the user's own bubble needs none (it's
              already right-aligned in accent color, unambiguous, and now
              carries its own avatar), but a left-aligned assistant reply
              with no mark reads as just another block of page text rather
              than a reply. The SAME mark (`AiMark`) the page header itself
              carries, so the assistant reads as one consistent identity
              wherever it speaks on this page. */}
          <div className="mt-0.5">
            <AiMark />
          </div>
          <div className="min-w-0 max-w-[85%] space-y-2">
            {/* Flat, not a bubble — Design Bible §12's own assistant reply
                has no background at all, unlike the user's own accent
                bubble above: the model's replies are prose next to a real
                tool-result CARD (already its own bordered box, below), and
                wrapping plain text in a second box next to that one reads
                as two boxes competing rather than a reply with evidence
                attached to it. */}
            {message.content !== '' && (
              <div className="text-[13px] leading-relaxed text-ink">
                <MarkdownLite text={message.content} />
              </div>
            )}
            {(message.toolCalls ?? []).map((call) => {
              const rendered = renderToolResult(call, resultsById, { orgId, onOpenCard });
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
 * §4.2's confirm-before-execute, rendered.
 *
 * Design Bible §12's own `.pending` row is two small chips —
 * "Approve · move to In Review" / "Decline" — sized like an ordinary inline
 * control (30px tall, 8px radius), not a boxed warning panel with the raw
 * tool name and JSON args spelled out. `describePendingAction` supplies the
 * verb phrase after "Approve · ", the same hand-curated, deterministic
 * mapping this file's own `CAPABILITIES` constant already is — real tool
 * names read like an API reference, the wrong thing to put in front of a
 * person deciding whether to click a button.
 *
 * The raw name/fields are NOT dropped, though — unlike the mockup's single-
 * call example, this app's confirm step is the one place a person sees
 * exactly what a cross-tenant write is about to do before it happens, and
 * losing that for pure visual lightness would trade away real accountability
 * for polish. They stay, as small dim text under the action row rather than
 * a separate bulky block.
 *
 * The overwhelming common case is exactly ONE pending call (every write tool
 * in this registry is confirmed individually; §4.1's own `card_create`
 * bundling is the one exception, and even that is still ONE tool call) — for
 * that case, clicking Approve or Decline resolves immediately, matching the
 * mockup's actual one-click interaction. A batch of several DISTINCT write
 * tools requested in the same round (real, if rarer — e.g. "create a card
 * and post a message") still needs each call decided before the whole batch
 * is sent in one `confirmedToolCallIds` list, per `assistant.ts`'s own
 * per-id semantics — that per-call decide-then-continue flow is kept for
 * that case, just restyled to match.
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
    if (calls.length === 1) {
      onRespond(approve ? [id] : []);
      return;
    }
    setDecided((current) => new Set(current).add(id));
    if (approve) setApproved((current) => new Set(current).add(id));
  };

  const allDecided = calls.length > 1 && calls.every((call) => decided.has(call.id));

  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 size-6 shrink-0" aria-hidden="true" />
      <div className="min-w-0 max-w-[85%] space-y-2">
        <ul className="space-y-2">
          {calls.map((call) => (
            <li key={call.id} className="space-y-1">
              {decided.has(call.id) ? (
                <span className="text-xs text-ink-faint">
                  {approved.has(call.id) ? 'Approved' : 'Declined'} ·{' '}
                  <span className="font-mono">{call.name}</span>
                </span>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      decide(call.id, true);
                    }}
                    className="flex h-9 items-center rounded-lg bg-accent px-4 text-[13px] font-medium text-white shadow-xs transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    Approve · {describePendingAction(call)}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      decide(call.id, false);
                    }}
                    className="flex h-9 items-center rounded-lg border border-line bg-surface-raised px-4 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-hover disabled:opacity-50"
                  >
                    Decline
                  </button>
                </div>
              )}
              {/* Each field its OWN small segment, not one run-on string —
                  `key: "value", key2: "value2"` reads as raw JSON; this
                  keeps the key dim and the value legible without the
                  quote-marks JSON.stringify adds around a plain string. */}
              {!decided.has(call.id) && Object.keys(call.input).length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                  {Object.entries(call.input).map(([key, value]) => (
                    <span key={key} className="text-xs text-ink-faint">
                      {key}: <span className="text-ink-muted">{formatCallValue(value)}</span>
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
        {allDecided && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onRespond([...approved]);
            }}
            className="flex h-9 items-center rounded-lg bg-accent px-4 text-[13px] font-medium text-white shadow-xs transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A short, hand-curated verb phrase per write tool — the same
 * "hand-maintained, kept in sync by hand" trade this file's own
 * `CAPABILITIES` constant already accepts, for the identical reason: a tool
 * name is written for the model (`apps/api/src/ai/tools/index.ts`'s own
 * registry keys), not for a person deciding whether to click Approve.
 * Deliberately does not attempt to name the concrete target (e.g. the
 * destination LIST's name for `card_move`) — the tool call carries only an
 * id for that, with no name available on this page without a second lookup
 * query the confirm step should not have to wait on. The card/PR reference
 * that IS already on the call's own input (an id the model resolved earlier
 * in the conversation) still shows below, in the dim field list.
 */
function describePendingAction(call: ToolCallWire): string {
  const phrase = PENDING_ACTION_PHRASES[call.name];
  return phrase ?? call.name.replaceAll('_', ' ');
}

const PENDING_ACTION_PHRASES: Readonly<Record<string, string>> = {
  card_create: 'create this card',
  card_update: 'update this card',
  card_assign: 'assign this card',
  card_unassign: 'unassign this card',
  card_set_status: "change this card's status",
  card_add_labels: 'add labels to this card',
  card_remove_labels: 'remove labels from this card',
  card_move: 'move this card',
  card_add_comment: 'add a comment',
  sprint_create: 'create this sprint',
  sprint_add_cards: 'add cards to the sprint',
  chat_post_message: 'post this message',
  docs_create_page: 'create this page',
  pr_post_comment: 'post this comment',
  pr_comment_on_file: 'comment on this file',
  pr_request_changes: 'request changes',
  pr_approve: 'approve this PR',
  pr_merge: 'merge this PR',
  pr_close: 'close this PR',
  card_link_pr: 'link this PR to the card',
  create_branch_from_card: 'create a branch',
};

/** A plain string renders bare, without the quote marks `JSON.stringify`
    would wrap it in — a call.input value is overwhelmingly a plain string
    (a title, a name, an id) and quoted text next to an unquoted key already
    reads as raw JSON, the exact "messy formatting" this row exists to
    avoid. Anything else (a number, a boolean, an array, an object) still
    goes through `JSON.stringify`, since those have no unambiguous bare
    rendering of their own. */
function formatCallValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
