import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  CircleDot,
  FileText,
  GitPullRequest,
  Hash,
  Kanban,
  LayoutGrid,
  MessageCircle,
  MessageSquare,
  Phone,
  Rocket,
  Tag,
  XCircle,
} from 'lucide-react';
import type { BoardId, CardId, ProjectId } from '@taskflow/contracts';
import { Avatar, Badge, SkeletonRows } from '../../components/primitives.js';
import { formatDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import {
  githubReposQuery,
  pullRequestFileDiffQuery,
  pullRequestFilesQuery,
  type Priority,
} from '../work/api.js';
import { PRIORITY_LABEL, PRIORITY_SWATCH } from '../work/priority-colors.js';
import type { ChatMessageWire, ToolCallWire } from './api.js';
import { DiffView, singleFileDiffText } from './diff-view.js';

/**
 * One rendering function per tool in `apps/api/src/ai/tools/index.ts`'s
 * registry, dispatched by tool NAME — replacing the `my_cards`-only special
 * case `assistant-page.tsx` shipped with first. Every tool already returns
 * real JSON as its `ToolResult.content` (that part of the pipeline was
 * never the gap); what was missing was a frontend that read it. A second
 * real report — "render me all the projects, boards, sprints and lists" —
 * came back as the model's own retyped bullet-point prose for exactly the
 * same reason the first `my_cards` report did: nothing on this page knew
 * `list_projects`/`list_boards` results were data rather than something
 * only the model could describe.
 *
 * ## Every renderer reads the REAL tool_result, never the model's reply
 *
 * `renderToolResult` looks up the `tool_result` message a call actually
 * produced (matched by `toolCallId`, via `resultsById` — `assistant-page.tsx`
 * already builds this) and parses ITS content, the same discipline
 * `myCardsEntriesFrom` established. A renderer that cannot recognize the
 * shape (a stale server, a future tool this file has not been taught about
 * yet) returns `null`, and the caller falls back to the plain "Used
 * `<tool>`" chip — never a runtime crash on a shape this file does not
 * expect.
 *
 * ## Write tools need no backend changes to be renderable
 *
 * A write tool's OUTPUT (`{version}`, `{assigneeIds}`, `{statusId}`, ...)
 * rarely carries enough to identify the card on its own — but the tool
 * CALL's own INPUT always does (`cardId` is a required field on every
 * single-card write tool), so every card-write renderer reads `call.input`
 * for identity and `result` only for outcome/error. This is why none of
 * `card_update`/`card_assign`/`card_set_status`/`card_add_labels`'s real
 * service outputs needed enriching — the id was already sitting in the
 * one place every renderer already has to look regardless.
 *
 * ## An error result is rendered as an error, per tool, not generically
 *
 * `ToolResult.isError` on a real permission refusal or validation failure
 * still carries the tool's own real error text in `content` — every
 * renderer below checks it FIRST and renders that message plainly (styled
 * as a failure) rather than attempting to parse a success shape out of it.
 *
 * `list_prs`/`get_pr_diff`/`get_pr_comments` (Phase 15 §7 Wave 1) are this
 * file's first renderers reaching outside the app: a GitHub PR has no
 * TaskFlow route, so `renderListPrs` is the first plain external `<a>` here
 * rather than a `<Link>`, and `renderGetPrDiff` is the first renderer
 * showing preformatted text instead of a structured list.
 *
 * ## `get_pr_diff`/`get_pr_files` browse a file's diff directly, no round trip
 *
 * The card panel's own `PrDiffButton` (`pr-diff-dialog.tsx`) lets a person
 * click a file from a PR's file list and see just that file's diff, with no
 * detour back through anything that has to re-decide what to fetch — a
 * plain `work.pullRequests.files`/`.fileDiff` query. `GetPrDiffResult`/
 * `GetPrFilesResult` below give the assistant transcript the identical
 * capability, reached the identical way (a click), rather than requiring a
 * person to type a follow-up message asking the model to call
 * `get_pr_file_diff` on their behalf. Inline in the transcript, not a modal:
 * this page has no card-panel dialog context to open one into, and a tool
 * result already renders inside its own bordered panel in the flow of the
 * conversation. `ctx.orgId` is what makes this possible — the one new field
 * this context needed, since these two are the first renderers to query
 * anything beyond what the tool result itself already carried.
 */

export interface ToolResultRenderContext {
  readonly orgId: string;
  readonly onOpenCard: (cardId: CardId) => void;
}

type ToolResultMessage = Extract<ChatMessageWire, { role: 'tool_result' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/** Every renderer below shares this shell — the same bordered-list style
    `standup-page.tsx`'s buckets and this file's own `EntityList` use.
    `header` is the Design Bible §12's own "✓ my_cards · 2 results" line —
    optional, and left to each renderer to opt into, rather than forced on
    every call site: a one-row `CardActionResult` confirming a single write
    has nothing a tool-name-plus-count header would add over its own
    "Assigned WEB-142 · Open card" text, which already names the action.

    `rounded-xl` and a real `border-line` (not the fainter `/60`), plus a
    `shadow-xs`, rather than the small, flat `rounded-lg` box this used to
    be — the mockup's own result card reads as a genuine card sitting on
    the transcript, the same visual weight `home-page.tsx`'s own list rows
    and `card-detail-panel.tsx`'s sections already carry, not a dense debug
    readout. `bg-surface` (not `-raised`, which the message list's own
    background already is) is what keeps the card visible AS a card against
    that backdrop rather than blending into it. */
function ResultPanel({
  header,
  children,
}: {
  readonly header?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5 rounded-xl border border-line bg-surface px-3 py-2.5 text-[13px] shadow-xs">
      {header !== undefined && (
        <div className="flex items-center gap-1.5 border-b border-line/60 pb-2 text-[12px] font-medium text-ink-muted">
          {header}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Every GitHub 401 hint in `apps/api/src/automation` — `pr-read`/`pr-write`/
 * `branch`/`integration-action`.service.ts, all four independently, per
 * CLAUDE.md's own "a missing 401 hint" section — carries this exact
 * substring. It is the one GitHub failure this codebase already knows is
 * unrecoverable without a real reconnect (a dead token, never something a
 * retry or a background refresh can fix — see `connectorFor`'s own "migration
 * 0109" doc comment for why: refresh only ever applies to a token GitHub
 * itself marked as expiring, and a token GitHub does not track that way
 * answers 401 only once it has actually been revoked). Matched on the
 * message TEXT rather than a structured error code because every tool error
 * in this registry is a plain string by design (`defineTool`'s own
 * `{ content, isError: true }` shape) — there is no error taxonomy to
 * switch on instead, and this substring is stable across every call site
 * that can produce it.
 */
const DEAD_GITHUB_TOKEN_MARKER = 'the connector token is invalid or was revoked';

function ErrorNote({ message }: { readonly message: string }) {
  const isDeadGithubToken = message.includes(DEAD_GITHUB_TOKEN_MARKER);
  return (
    <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2.5 text-[13px] text-danger">
      <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1">
        {message}
        {isDeadGithubToken && (
          <>
            {' '}
            <Link
              to="/automations"
              search={{ tab: 'integrations' }}
              className="font-medium underline underline-offset-2 hover:no-underline"
            >
              Reconnect the repository
            </Link>
          </>
        )}
      </span>
    </div>
  );
}

function EntityList({ children }: { readonly children: ReactNode }) {
  return <ul className="space-y-0.5">{children}</ul>;
}

function EntityRow({
  icon,
  primary,
  secondary,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly primary: ReactNode;
  readonly secondary?: ReactNode;
  readonly onClick?: (() => void) | undefined;
}) {
  const content = (
    <>
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ink">{primary}</span>
        {secondary !== undefined && (
          <span className="block truncate text-[12px] text-ink-faint">{secondary}</span>
        )}
      </span>
    </>
  );

  return (
    <li>
      {onClick === undefined ? (
        <div className="flex items-center gap-2 rounded-lg px-2 py-1.5">{content}</div>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-[var(--motion-fast)] hover:bg-surface-hover"
        >
          {content}
        </button>
      )}
    </li>
  );
}

/** A compact "did the write succeed" line — every card-write tool's shared
    shape, since the interesting information (which card, what changed) is
    the same regardless of which of the five tools produced it. */
function CardActionResult({
  cardId,
  verb,
  onOpenCard,
  note,
}: {
  readonly cardId: string;
  readonly verb: string;
  readonly onOpenCard: (cardId: CardId) => void;
  readonly note?: ReactNode;
}) {
  return (
    <ResultPanel>
      <button
        type="button"
        onClick={() => {
          onOpenCard(cardId as CardId);
        }}
        className="flex w-full items-center gap-1.5 text-left text-ink hover:text-accent"
      >
        <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-success" />
        <span>{verb}</span>
        <span className="ml-auto shrink-0 text-[11px] text-accent underline">Open card</span>
      </button>
      {note}
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * search
 * -------------------------------------------------------------------------- */

const SEARCH_TYPE_ICON: Readonly<Record<string, ReactNode>> = {
  card: <Kanban aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />,
  message: <MessageSquare aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />,
  page: <FileText aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />,
  comment: <MessageCircle aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />,
  transcript: <Phone aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />,
};

function renderSearch(result: ToolResultMessage, ctx: ToolResultRenderContext): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return <ResultPanel>{result.content}</ResultPanel>;

  const hits: { type: string; id: string; title: string; snippet: string }[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const type = stringField(entry, 'type');
    const id = stringField(entry, 'id');
    const title = stringField(entry, 'title');
    const snippet = stringField(entry, 'snippet');
    if (type === null || id === null || title === null || snippet === null) return null;
    hits.push({ type, id, title, snippet });
  }

  return (
    <ResultPanel>
      <EntityList>
        {hits.map((hit) => (
          <EntityRow
            key={`${hit.type}-${hit.id}`}
            icon={SEARCH_TYPE_ICON[hit.type] ?? SEARCH_TYPE_ICON['page']}
            primary={hit.title}
            secondary={hit.snippet}
            onClick={
              hit.type === 'card'
                ? () => {
                    ctx.onOpenCard(hit.id as CardId);
                  }
                : undefined
            }
          />
        ))}
      </EntityList>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * my_cards
 * -------------------------------------------------------------------------- */

interface MyCardsEntry {
  readonly cardId: string;
  readonly reference: string;
  readonly title: string;
  readonly priority: string | null;
  readonly dueDate: string | null;
}

function isMyCardsEntry(value: unknown): value is MyCardsEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value['cardId'] === 'string' &&
    typeof value['reference'] === 'string' &&
    typeof value['title'] === 'string' &&
    (value['priority'] === null || typeof value['priority'] === 'string') &&
    (value['dueDate'] === null || typeof value['dueDate'] === 'string')
  );
}

function isPriority(value: string | null): value is Priority {
  return value === 'urgent' || value === 'high' || value === 'normal' || value === 'low';
}

function isPastDue(dueDate: string): boolean {
  return new Date(dueDate).getTime() < Date.now();
}

function renderMyCards(result: ToolResultMessage, ctx: ToolResultRenderContext): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed) || !parsed.every(isMyCardsEntry)) {
    // A plain-string reply ("No cards are assigned...", "Nothing pending...")
    // is still worth showing verbatim rather than falling through to "Used
    // my_cards" — it IS the whole answer.
    return <ResultPanel>{result.content}</ResultPanel>;
  }
  if (parsed.length === 0) return <ResultPanel>{result.content}</ResultPanel>;

  return (
    <ResultPanel
      header={
        <>
          <Check aria-hidden="true" className="size-3 shrink-0 text-success" />
          <span className="font-mono text-ink-faint">my_cards</span>
          <span>
            · {parsed.length} {parsed.length === 1 ? 'result' : 'results'}
          </span>
        </>
      }
    >
      <EntityList>
        {parsed.map((card) => {
          const priority = isPriority(card.priority) ? card.priority : null;
          return (
            <li key={card.cardId}>
              <button
                type="button"
                onClick={() => {
                  ctx.onOpenCard(card.cardId as CardId);
                }}
                className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-[var(--motion-fast)] hover:bg-surface-hover"
              >
                {/* A reference PILL, matching how a card reference already
                    reads everywhere else in this app (`list-view.tsx`'s own
                    row, `table-view.tsx`'s Ref column) — a bare mono string
                    with no background read as debug output, not a card id
                    someone recognizes. */}
                <span className="mt-0.5 shrink-0 rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-faint">
                  {card.reference}
                </span>
                <span className="min-w-0 flex-1 break-words text-ink">{card.title}</span>
                {card.dueDate !== null && (
                  <span
                    className={cn(
                      'mt-0.5 shrink-0 text-[11px] whitespace-nowrap',
                      isPastDue(card.dueDate) ? 'text-danger' : 'text-ink-faint',
                    )}
                  >
                    {formatDate(card.dueDate)}
                  </span>
                )}
                {/* A trailing colored bar rather than a leading dot — the
                    Design Bible's own `my_cards` row (§12) marks priority at
                    the row's TRAILING edge, the same "priority as an edge
                    bar" language `card-tile.tsx`'s own board card already
                    uses (there, the full tile's left edge; here, one row's
                    right edge — a scaled-down version of the identical
                    idea, not a different one). */}
                {priority !== null && (
                  <span
                    aria-hidden="true"
                    title={PRIORITY_LABEL[priority]}
                    className={cn(
                      'mt-0.5 h-4 w-[3px] shrink-0 rounded-full',
                      PRIORITY_SWATCH[priority],
                    )}
                  />
                )}
              </button>
            </li>
          );
        })}
      </EntityList>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * list_projects
 * -------------------------------------------------------------------------- */

function renderListProjects(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const projects: { projectId: string; name: string; key: string }[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const projectId = stringField(entry, 'projectId');
    const name = stringField(entry, 'name');
    const key = stringField(entry, 'key');
    if (projectId === null || name === null || key === null) return null;
    projects.push({ projectId, name, key });
  }

  return (
    <ResultPanel>
      <EntityList>
        {projects.map((project) => (
          <li key={project.projectId}>
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.projectId as ProjectId }}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-hover"
            >
              <Badge>{project.key}</Badge>
              <span className="min-w-0 flex-1 truncate text-ink">{project.name}</span>
            </Link>
          </li>
        ))}
      </EntityList>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * list_boards
 * -------------------------------------------------------------------------- */

function renderListBoards(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const boards: { boardId: string; name: string; lists: { listId: string; name: string }[] }[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const boardId = stringField(entry, 'boardId');
    const name = stringField(entry, 'name');
    const listsRaw = entry['lists'];
    if (boardId === null || name === null || !Array.isArray(listsRaw)) return null;
    const lists: { listId: string; name: string }[] = [];
    for (const listEntry of listsRaw) {
      if (!isRecord(listEntry)) return null;
      const listId = stringField(listEntry, 'listId');
      const listName = stringField(listEntry, 'name');
      if (listId === null || listName === null) return null;
      lists.push({ listId, name: listName });
    }
    boards.push({ boardId, name, lists });
  }

  return (
    <ResultPanel>
      <ul className="space-y-2">
        {boards.map((board) => (
          <li key={board.boardId}>
            <Link
              to="/boards/$boardId"
              params={{ boardId: board.boardId as BoardId }}
              className="flex items-center gap-1.5 font-medium text-ink hover:text-accent"
            >
              <LayoutGrid aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
              {board.name}
            </Link>
            {board.lists.length > 0 && (
              // A joined text string, not a `Badge` cloud — the identical
              // collapse-on-copy bug `renderListLabels`' own header now
              // documents ("BacklogTo DoIn ProgressIn Review..." in a real
              // pasted transcript, one board's worth of `Badge` spans with
              // only CSS `gap` between them). A board's own lists read
              // naturally as one compact line, so the fix here is a real
              // separator character in the text itself rather than
              // switching to a vertical list the way labels did.
              <p className="mt-1 truncate pl-5 text-[11px] text-ink-faint">
                {board.lists.map((list) => list.name).join(' · ')}
              </p>
            )}
          </li>
        ))}
      </ul>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * list_labels
 * -------------------------------------------------------------------------- */

function renderListLabels(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const labels: { labelId: string; name: string }[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const labelId = stringField(entry, 'labelId');
    const name = stringField(entry, 'name');
    if (labelId === null || name === null) return null;
    labels.push({ labelId, name });
  }

  // A real vertical list, not a wrapped row of `Badge` spans — two reasons,
  // not one. Visually, a flat wrapped chip cloud is genuinely harder to scan
  // than one label per line once there are more than a handful. And a
  // `Badge` is a `<span>` with only CSS `gap` between siblings, so a plain-
  // text copy of a chip row (a browser only inserts a line break between
  // BLOCK-level elements) collapsed every label into one unreadable run —
  // "choredesigndocsfeature..." — found from a real pasted transcript. Each
  // `<li>` here is block-level, so both problems are the same fix.
  return (
    <ResultPanel>
      <EntityList>
        {labels.map((label) => (
          <EntityRow
            key={label.labelId}
            icon={<Tag aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />}
            primary={label.name}
          />
        ))}
      </EntityList>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * list_members
 * -------------------------------------------------------------------------- */

function renderListMembers(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const members: { userId: string; name: string; email: string }[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const userId = stringField(entry, 'userId');
    const name = stringField(entry, 'name');
    const email = stringField(entry, 'email');
    if (userId === null || name === null || email === null) return null;
    members.push({ userId, name, email });
  }

  return (
    <ResultPanel>
      <EntityList>
        {members.map((member) => (
          <li key={member.userId}>
            <Link
              to="/people/$userId"
              params={{ userId: member.userId }}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-hover"
            >
              <Avatar userId={member.userId} label={member.name} size="xs" />
              <span className="min-w-0 flex-1 truncate text-ink">{member.name}</span>
              <span className="shrink-0 truncate text-[11px] text-ink-faint">{member.email}</span>
            </Link>
          </li>
        ))}
      </EntityList>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * list_sprints
 * -------------------------------------------------------------------------- */

function renderListSprints(result: ToolResultMessage, call: ToolCallWire): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const sprints: { sprintId: string; name: string; status: string }[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const sprintId = stringField(entry, 'sprintId');
    const name = stringField(entry, 'name');
    const status = stringField(entry, 'status');
    if (sprintId === null || name === null || status === null) return null;
    sprints.push({ sprintId, name, status });
  }

  const projectId = typeof call.input['projectId'] === 'string' ? call.input['projectId'] : null;

  return (
    <ResultPanel>
      <EntityList>
        {sprints.map((sprint) => (
          <EntityRow
            key={sprint.sprintId}
            icon={<Rocket aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />}
            primary={sprint.name}
            secondary={<Badge>{sprint.status}</Badge>}
          />
        ))}
      </EntityList>
      {projectId !== null && (
        <Link
          to="/projects/$projectId/sprints"
          params={{ projectId: projectId as ProjectId }}
          className="block pt-1 text-[11px] text-accent underline"
        >
          View sprints
        </Link>
      )}
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * list_statuses
 * -------------------------------------------------------------------------- */

function renderListStatuses(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const statuses: { statusId: string; name: string; category: string }[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const statusId = stringField(entry, 'statusId');
    const name = stringField(entry, 'name');
    const category = stringField(entry, 'category');
    if (statusId === null || name === null || category === null) return null;
    statuses.push({ statusId, name, category });
  }

  return (
    <ResultPanel>
      <EntityList>
        {statuses.map((status) => (
          <EntityRow
            key={status.statusId}
            icon={<CircleDot aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />}
            primary={status.name}
            secondary={<Badge>{status.category}</Badge>}
          />
        ))}
      </EntityList>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * list_channels
 * -------------------------------------------------------------------------- */

function renderListChannels(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const channels: {
    channelId: string;
    name: string | null;
    participantIds: string[];
  }[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const channelId = stringField(entry, 'channelId');
    const name = entry['name'];
    const participantsRaw = entry['participantIds'];
    if (
      channelId === null ||
      (name !== null && typeof name !== 'string') ||
      !Array.isArray(participantsRaw) ||
      !participantsRaw.every((id): id is string => typeof id === 'string')
    ) {
      return null;
    }
    channels.push({ channelId, name, participantIds: participantsRaw });
  }

  return (
    <ResultPanel>
      <EntityList>
        {channels.map((channel) => (
          <EntityRow
            key={channel.channelId}
            icon={<Hash aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />}
            primary={
              channel.name ??
              (channel.participantIds.length === 1
                ? 'Direct message (1 person)'
                : `Direct message (${channel.participantIds.length.toString()} people)`)
            }
          />
        ))}
      </EntityList>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * find_card
 * -------------------------------------------------------------------------- */

function renderFindCard(result: ToolResultMessage, ctx: ToolResultRenderContext): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!isRecord(parsed)) return null;
  const cardId = stringField(parsed, 'cardId');
  const reference = stringField(parsed, 'reference');
  const title = stringField(parsed, 'title');
  if (cardId === null || reference === null || title === null) return null;

  return (
    <ResultPanel>
      <EntityList>
        <EntityRow
          icon={<Kanban aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />}
          primary={
            <>
              <span className="font-mono text-[10px] text-ink-faint">{reference}</span> {title}
            </>
          }
          onClick={() => {
            ctx.onOpenCard(cardId as CardId);
          }}
        />
      </EntityList>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * card_create / card_update / card_assign / card_set_status / card_add_labels
 * -------------------------------------------------------------------------- */

function renderCardCreate(
  result: ToolResultMessage,
  ctx: ToolResultRenderContext,
): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!isRecord(parsed)) return null;
  const cardId = stringField(parsed, 'cardId');
  const reference = stringField(parsed, 'reference');
  if (cardId === null || reference === null) return null;

  const warnings = parsed['warnings'];
  const warningList = Array.isArray(warnings)
    ? warnings.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return (
    <CardActionResult
      cardId={cardId}
      verb={`Created ${reference}`}
      onOpenCard={ctx.onOpenCard}
      note={
        warningList.length > 0 ? (
          <div className="mt-1 space-y-0.5 border-t border-line/40 pt-1">
            {warningList.map((warning) => (
              <p key={warning} className="flex items-start gap-1 text-[11px] text-warning">
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                {warning}
              </p>
            ))}
          </div>
        ) : undefined
      }
    />
  );
}

function cardWriteRenderer(verb: string) {
  return (
    result: ToolResultMessage,
    call: ToolCallWire,
    ctx: ToolResultRenderContext,
  ): ReactNode | null => {
    if (result.isError === true) return <ErrorNote message={result.content} />;
    const cardId = typeof call.input['cardId'] === 'string' ? call.input['cardId'] : null;
    if (cardId === null) return null;
    return <CardActionResult cardId={cardId} verb={verb} onOpenCard={ctx.onOpenCard} />;
  };
}

const renderCardUpdate = cardWriteRenderer('Card updated');
const renderCardAssign = cardWriteRenderer('Assignees updated');
const renderCardUnassign = cardWriteRenderer('Assignees updated');
const renderCardSetStatus = cardWriteRenderer('Status updated');
const renderCardAddLabels = cardWriteRenderer('Labels updated');
const renderCardRemoveLabels = cardWriteRenderer('Labels updated');
const renderCardMove = cardWriteRenderer('Card moved');
const renderCardAddComment = cardWriteRenderer('Comment added');

/* -------------------------------------------------------------------------- *
 * sprint_create / sprint_add_cards
 * -------------------------------------------------------------------------- */

function renderSprintCreate(result: ToolResultMessage, call: ToolCallWire): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!isRecord(parsed) || stringField(parsed, 'sprintId') === null) return null;

  const name = typeof call.input['name'] === 'string' ? call.input['name'] : 'the sprint';
  const projectId = typeof call.input['projectId'] === 'string' ? call.input['projectId'] : null;

  return (
    <ResultPanel>
      <div className="flex items-center gap-1.5 text-ink">
        <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-success" />
        Created sprint “{name}”
        {projectId !== null && (
          <Link
            to="/projects/$projectId/sprints"
            params={{ projectId: projectId as ProjectId }}
            className="ml-auto shrink-0 text-[11px] text-accent underline"
          >
            View
          </Link>
        )}
      </div>
    </ResultPanel>
  );
}

function renderSprintAddCards(result: ToolResultMessage): ReactNode | null {
  const parsed = parseJson(result.content);
  if (!isRecord(parsed))
    return result.isError === true ? <ErrorNote message={result.content} /> : null;

  const succeeded = parsed['succeeded'];
  const failed = parsed['failed'];
  if (!Array.isArray(succeeded) || !Array.isArray(failed)) return null;

  const failedEntries: { cardId: string; reason: string }[] = [];
  for (const entry of failed) {
    if (!isRecord(entry)) return null;
    const cardId = stringField(entry, 'cardId');
    const reason = stringField(entry, 'reason');
    if (cardId === null || reason === null) return null;
    failedEntries.push({ cardId, reason });
  }

  return (
    <ResultPanel>
      <p className="flex items-center gap-1.5 text-ink">
        <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-success" />
        {succeeded.length} of {succeeded.length + failedEntries.length} cards added to the sprint
      </p>
      {failedEntries.length > 0 && (
        <div className="mt-1 space-y-0.5 border-t border-line/40 pt-1">
          {failedEntries.map((entry) => (
            <p key={entry.cardId} className="flex items-start gap-1 text-[11px] text-danger">
              <XCircle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
              {entry.reason}
            </p>
          ))}
        </div>
      )}
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * chat_post_message / docs_create_page
 * -------------------------------------------------------------------------- */

function renderChatPostMessage(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!isRecord(parsed) || stringField(parsed, 'messageId') === null) return null;

  // Read from the RESULT, not `call.input` — a DM opened via `dmUserIds`
  // has no `channelId` in the call's own input at all, only in what
  // `chat_post_message` resolved it to.
  const channelId = stringField(parsed, 'channelId');

  return (
    <ResultPanel>
      <div className="flex items-center gap-1.5 text-ink">
        <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-success" />
        Message posted
        {channelId !== null && (
          <Link
            to="/chat"
            search={{ channel: channelId }}
            className="ml-auto shrink-0 text-[11px] text-accent underline"
          >
            View
          </Link>
        )}
      </div>
    </ResultPanel>
  );
}

function renderDocsCreatePage(result: ToolResultMessage, call: ToolCallWire): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!isRecord(parsed)) return null;
  const pageId = stringField(parsed, 'pageId');
  if (pageId === null) return null;

  const title = typeof call.input['title'] === 'string' ? call.input['title'] : 'the page';
  const spaceId = typeof call.input['spaceId'] === 'string' ? call.input['spaceId'] : null;

  return (
    <ResultPanel>
      <div className="flex items-center gap-1.5 text-ink">
        <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-success" />
        Created page “{title}”
        {spaceId !== null && (
          <Link
            to="/docs"
            search={{ space: spaceId, page: pageId }}
            className="ml-auto shrink-0 text-[11px] text-accent underline"
          >
            Open
          </Link>
        )}
      </div>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * list_prs / get_pr_diff / get_pr_comments
 * -------------------------------------------------------------------------- */

/**
 * The first renderers in this file that link OUTSIDE TaskFlow. A GitHub pull
 * request has no TaskFlow route — every other renderer here uses a TanStack
 * `<Link>` into a real `apps/web` page, but there is no page for a PR to open
 * into, so this is a plain `<a target="_blank" rel="noopener noreferrer">` to
 * the PR's own `html_url` instead.
 *
 * `renderGetPrDiff` is also this file's first renderer showing preformatted
 * TEXT rather than a structured list — a diff has no natural row-per-item
 * shape the way every other tool result here does.
 */

function renderListPrs(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const prs: { number: number; title: string; url: string; isDraft: boolean }[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const number = entry['number'];
    const title = stringField(entry, 'title');
    const url = stringField(entry, 'url');
    if (typeof number !== 'number' || title === null || url === null) return null;
    prs.push({ number, title, url, isDraft: entry['isDraft'] === true });
  }

  return (
    <ResultPanel>
      <EntityList>
        {prs.map((pr) => (
          <li key={pr.number}>
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-hover"
            >
              <GitPullRequest aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
              <span className="shrink-0 font-mono text-[10px] text-ink-faint">#{pr.number}</span>
              <span className="min-w-0 flex-1 truncate text-ink">{pr.title}</span>
              {pr.isDraft && <Badge>Draft</Badge>}
            </a>
          </li>
        ))}
      </EntityList>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * Shared: resolving which connected repo a PR call is about, and one file's
 * own diff, browsed inline — no assistant round trip.
 * -------------------------------------------------------------------------- */

/**
 * `get_pr_diff`/`get_pr_files`' own JSON never carries a `providerScope` —
 * neither result needed one before this file could query anything itself,
 * on the identical "no backend enrichment for a frontend convenience"
 * reasoning `cardWriteRenderer`'s own header states for `cardId`. A click
 * here needs a real repo to ask `work.pullRequests.fileDiff` about, so it
 * has to be resolved from what IS available: the call's own `repoScope`
 * input when the model named one explicitly (a multi-repo org), or — the
 * common case — the org's one connected repo, the same default
 * `connectedGithubRepo` itself falls back to server-side. `null` means
 * neither holds (more than one connected repo, no explicit scope in this
 * call): the drill-down below stays non-interactive rather than guessing
 * which repo a click should ask about.
 */
function useResolvedRepoScope(orgId: string, explicitRepoScope: string | null): string | null {
  const repos = useQuery({ ...githubReposQuery(orgId), enabled: explicitRepoScope === null });
  if (explicitRepoScope !== null) return explicitRepoScope;
  if (repos.data?.length !== 1) return null;
  return repos.data[0]?.providerScope ?? null;
}

/**
 * One file's own diff, fetched directly through `work.pullRequests.fileDiff`
 * — the fix for "instead of us calling the assistant to get diff for
 * specific file." Mirrors `pr-diff-dialog.tsx`'s own `PrSingleFileDiff` (the
 * card panel's identical drill-down over the same route), reached inline in
 * the transcript rather than inside a modal — this page has no card-panel
 * dialog to open one into, and a tool result already renders inside its own
 * bordered panel in the flow of the conversation.
 */
function InlineFileDiff({
  orgId,
  providerScope,
  prNumber,
  path,
  onBack,
}: {
  readonly orgId: string;
  readonly providerScope: string;
  readonly prNumber: number;
  readonly path: string;
  readonly onBack: () => void;
}) {
  const fileDiff = useQuery(pullRequestFileDiffQuery(orgId, providerScope, prNumber, path));

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink"
      >
        <ChevronLeft aria-hidden="true" className="size-3.5" strokeWidth={2} />
        All files
      </button>
      {fileDiff.isPending ? (
        <SkeletonRows rows={4} />
      ) : fileDiff.isError ? (
        <ErrorNote message="Could not load this file's diff." />
      ) : (
        <DiffView
          diff={singleFileDiffText(fileDiff.data.path, fileDiff.data.patch)}
          truncated={fileDiff.data.truncated}
        />
      )}
    </div>
  );
}

interface PrFileEntry {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
}

/** One file row — clickable straight into `InlineFileDiff` once a repo is
    resolved, a plain (non-interactive) row otherwise. Shared by
    `GetPrFilesResult` and `GetPrDiffResult`'s own "Browse by file" fallback
    below, so a click behaves identically from either entry point. */
function PrFileRow({
  file,
  onSelect,
}: {
  readonly file: PrFileEntry;
  readonly onSelect: (() => void) | null;
}) {
  const content = (
    <>
      <FileText aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{file.path}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">
        {file.status}
      </span>
      <span className="shrink-0 font-mono text-[10px] text-success">+{file.additions}</span>
      <span className="shrink-0 font-mono text-[10px] text-danger">-{file.deletions}</span>
    </>
  );

  if (onSelect === null) {
    return <li className="flex items-center gap-2 rounded-md px-1.5 py-1 text-ink">{content}</li>;
  }
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-ink hover:bg-surface-hover"
      >
        {content}
      </button>
    </li>
  );
}

/**
 * `get_pr_diff`'s result, with an inline "Browse by file" fallback — the
 * identical dual view `pr-diff-dialog.tsx`'s `PrDiffDialogBody` already
 * gives the card panel, minus the modal: a whole-PR diff has a real ceiling
 * (GitHub's own 406 past a certain size, and `fitDiffToBudget`'s own
 * truncation under that), and this is how a person recovers from either
 * without typing a follow-up message asking the model to call
 * `get_pr_file_diff` on their behalf. The toggle is offered whenever a repo
 * resolves, not only when truncated — matching the card panel's own
 * always-available "Browse by file" button — while the truncation NOTE
 * stays conditional on `truncated`, since that sentence is only true then.
 */
function GetPrDiffResult({
  diff,
  truncated,
  orgId,
  prNumber,
  explicitRepoScope,
}: {
  readonly diff: string;
  readonly truncated: boolean;
  readonly orgId: string;
  readonly prNumber: number;
  readonly explicitRepoScope: string | null;
}) {
  const [browseFiles, setBrowseFiles] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const repoScope = useResolvedRepoScope(orgId, explicitRepoScope);
  const files = useQuery({
    ...pullRequestFilesQuery(orgId, repoScope ?? '', prNumber),
    enabled: browseFiles && repoScope !== null && selectedPath === null,
  });

  return (
    <ResultPanel>
      {repoScope !== null && (
        <div className="mb-1 flex justify-end">
          <button
            type="button"
            className="text-[11px] text-accent underline"
            onClick={() => {
              setBrowseFiles((current) => !current);
              setSelectedPath(null);
            }}
          >
            {browseFiles ? 'View full diff' : 'Browse by file'}
          </button>
        </div>
      )}
      {browseFiles && repoScope !== null ? (
        selectedPath !== null ? (
          <InlineFileDiff
            orgId={orgId}
            providerScope={repoScope}
            prNumber={prNumber}
            path={selectedPath}
            onBack={() => {
              setSelectedPath(null);
            }}
          />
        ) : files.isPending ? (
          <SkeletonRows rows={4} />
        ) : files.isError ? (
          <ErrorNote message="Could not load the file list." />
        ) : files.data.length === 0 ? (
          <p className="text-[11px] text-ink-faint">This pull request changes no files.</p>
        ) : (
          <ul className="space-y-1">
            {files.data.map((file) => (
              <PrFileRow
                key={file.path}
                file={file}
                onSelect={() => {
                  setSelectedPath(file.path);
                }}
              />
            ))}
          </ul>
        )
      ) : (
        <>
          <DiffView diff={diff} truncated={truncated} />
          {truncated && repoScope !== null && (
            <p className="mt-1 text-[11px] text-ink-faint">
              This diff was too large to show in full.{' '}
              <button
                type="button"
                className="text-accent underline"
                onClick={() => {
                  setBrowseFiles(true);
                }}
              >
                Browse by file
              </button>{' '}
              to see any one file&apos;s own change in full.
            </p>
          )}
        </>
      )}
    </ResultPanel>
  );
}

function renderGetPrDiff(
  result: ToolResultMessage,
  call: ToolCallWire,
  ctx: ToolResultRenderContext,
): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!isRecord(parsed)) return null;
  const diff = stringField(parsed, 'diff');
  if (diff === null) return null;
  const truncated = parsed['truncated'] === true;

  const prNumber = call.input['prNumber'];
  if (typeof prNumber !== 'number') {
    // No PR number to browse files by — the plain diff is still the whole
    // answer, just without the interactive fallback.
    return (
      <ResultPanel>
        <DiffView diff={diff} truncated={truncated} />
      </ResultPanel>
    );
  }
  const explicitRepoScope =
    typeof call.input['repoScope'] === 'string' ? call.input['repoScope'] : null;

  return (
    <GetPrDiffResult
      diff={diff}
      truncated={truncated}
      orgId={ctx.orgId}
      prNumber={prNumber}
      explicitRepoScope={explicitRepoScope}
    />
  );
}

/**
 * `get_pr_files`' result, each row clickable straight into `InlineFileDiff`
 * — the direct counterpart to `GetPrDiffResult`'s own "Browse by file"
 * fallback, for a person (or the model) that called this tool first rather
 * than reaching it from a truncated diff.
 */
function GetPrFilesResult({
  files,
  orgId,
  prNumber,
  explicitRepoScope,
}: {
  readonly files: readonly PrFileEntry[];
  readonly orgId: string;
  readonly prNumber: number;
  readonly explicitRepoScope: string | null;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const repoScope = useResolvedRepoScope(orgId, explicitRepoScope);

  if (selectedPath !== null && repoScope !== null) {
    return (
      <ResultPanel>
        <InlineFileDiff
          orgId={orgId}
          providerScope={repoScope}
          prNumber={prNumber}
          path={selectedPath}
          onBack={() => {
            setSelectedPath(null);
          }}
        />
      </ResultPanel>
    );
  }

  return (
    <ResultPanel>
      <ul className="space-y-1">
        {files.map((file) => (
          <PrFileRow
            key={file.path}
            file={file}
            onSelect={
              repoScope === null
                ? null
                : () => {
                    setSelectedPath(file.path);
                  }
            }
          />
        ))}
      </ul>
    </ResultPanel>
  );
}

function renderGetPrFiles(
  result: ToolResultMessage,
  call: ToolCallWire,
  ctx: ToolResultRenderContext,
): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const files: PrFileEntry[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const path = stringField(entry, 'path');
    const status = stringField(entry, 'status');
    const additions = entry['additions'];
    const deletions = entry['deletions'];
    if (
      path === null ||
      status === null ||
      typeof additions !== 'number' ||
      typeof deletions !== 'number'
    ) {
      return null;
    }
    files.push({ path, status, additions, deletions });
  }

  const prNumber = call.input['prNumber'];
  if (typeof prNumber !== 'number') {
    // No PR number to drill into a file's diff with — the plain list is
    // still the whole answer, just without the interactive fallback.
    return (
      <ResultPanel>
        <ul className="space-y-1">
          {files.map((file) => (
            <PrFileRow key={file.path} file={file} onSelect={null} />
          ))}
        </ul>
      </ResultPanel>
    );
  }
  const explicitRepoScope =
    typeof call.input['repoScope'] === 'string' ? call.input['repoScope'] : null;

  return (
    <GetPrFilesResult
      files={files}
      orgId={ctx.orgId}
      prNumber={prNumber}
      explicitRepoScope={explicitRepoScope}
    />
  );
}

/**
 * A single file's content, at the PR's own branch — a scrollable code
 * block, the identical "show real preformatted text, not a structured
 * list" shape `renderGetPrDiff`'s own `<pre>` fallback already established
 * for content that has no natural row-per-item form. Path and a truncation
 * note sit in the header rather than inline with the code, so a long first
 * line of real content is never confused with metadata about the file.
 */
function renderGetPrFileContent(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!isRecord(parsed)) return null;
  const path = stringField(parsed, 'path');
  const content = stringField(parsed, 'content');
  if (path === null || content === null) return null;
  const truncated = parsed['truncated'] === true;

  return (
    <ResultPanel>
      <div className="overflow-hidden rounded-md border border-line/60">
        <div className="flex items-center gap-2 border-b border-line/60 bg-surface-sunken/60 px-2 py-1">
          <FileText aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{path}</span>
          {truncated && (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-warning">
              Truncated
            </span>
          )}
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink">
          {content}
        </pre>
      </div>
    </ResultPanel>
  );
}

/**
 * One file's own diff within a PR — reuses `DiffView`/`parseUnifiedDiff`
 * wholesale rather than a second implementation, via `diff-view.tsx`'s own
 * `singleFileDiffText` (shared with the card panel's own single-file diff
 * view — see that helper's own header for why the synthetic `diff --git`
 * wrapping it does is conditional, not unconditional).
 */
function renderGetPrFileDiff(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!isRecord(parsed)) return null;
  const path = stringField(parsed, 'path');
  const patch = stringField(parsed, 'patch');
  if (path === null || patch === null) return null;
  const truncated = parsed['truncated'] === true;

  return (
    <ResultPanel>
      <DiffView diff={singleFileDiffText(path, patch)} truncated={truncated} />
    </ResultPanel>
  );
}

function renderListRepos(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const repos: string[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const providerScope = stringField(entry, 'providerScope');
    if (providerScope === null) return null;
    repos.push(providerScope);
  }

  return (
    <ResultPanel>
      <EntityList>
        {repos.map((scope) => (
          <EntityRow
            key={scope}
            icon={
              <GitPullRequest aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
            }
            primary={<span className="font-mono">{scope}</span>}
          />
        ))}
      </EntityList>
    </ResultPanel>
  );
}

function renderGetPrComments(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const comments: { id: number; author: string | null; body: string }[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const id = entry['id'];
    const body = stringField(entry, 'body');
    if (typeof id !== 'number' || body === null) return null;
    comments.push({ id, author: stringField(entry, 'author'), body });
  }

  return (
    <ResultPanel>
      <EntityList>
        {comments.map((comment) => (
          <EntityRow
            key={comment.id}
            icon={<MessageSquare aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />}
            primary={comment.body}
            secondary={comment.author ?? 'unknown'}
          />
        ))}
      </EntityList>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * pr_post_comment / pr_request_changes / pr_merge / pr_close
 * -------------------------------------------------------------------------- */

/**
 * The write-tool factory, mirroring `cardWriteRenderer` — but reading the
 * PR's `prNumber` from `call.input` (the model already put it there, same
 * as `cardWriteRenderer`'s `cardId`) and its `providerScope` from the
 * RESULT rather than `call.input`, because — unlike a `cardId` — the model
 * never sees `providerScope` anywhere; `pr-write.service.ts`'s own header
 * explains why it has to be returned at all. Links externally, like
 * `renderListPrs` above — a PR has no TaskFlow route to open.
 */
function prWriteRenderer(verb: string) {
  return (result: ToolResultMessage, call: ToolCallWire): ReactNode | null => {
    if (result.isError === true) return <ErrorNote message={result.content} />;
    const prNumber = call.input['prNumber'];
    if (typeof prNumber !== 'number') return null;
    const parsed = parseJson(result.content);
    const providerScope = isRecord(parsed) ? stringField(parsed, 'providerScope') : null;

    return (
      <ResultPanel>
        <div className="flex items-center gap-1.5 text-ink">
          <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-success" />
          {verb} PR #{prNumber}
          {providerScope !== null && (
            <a
              href={`https://github.com/${providerScope}/pull/${String(prNumber)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto shrink-0 text-[11px] text-accent underline"
            >
              Open
            </a>
          )}
        </div>
      </ResultPanel>
    );
  };
}

const renderPrPostComment = prWriteRenderer('Commented on');
const renderPrRequestChanges = prWriteRenderer('Requested changes on');
const renderPrApprove = prWriteRenderer('Approved');
const renderPrMerge = prWriteRenderer('Merged');
const renderPrClose = prWriteRenderer('Closed');

/**
 * `pr_comment_on_file` — a real, small variant of `prWriteRenderer` rather
 * than that same factory: unlike the general-thread write tools above, this
 * one has a `path` (from `call.input`, the model already put it there —
 * same reasoning `cardWriteRenderer`/`prWriteRenderer` both give for
 * reading identity off the call rather than the service's own output)
 * worth showing alongside the PR number, and it links to GitHub's own
 * "Files changed" tab rather than the bare PR page, since that's where the
 * comment actually lives.
 */
function renderPrCommentOnFile(result: ToolResultMessage, call: ToolCallWire): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const prNumber = call.input['prNumber'];
  const path = call.input['path'];
  if (typeof prNumber !== 'number' || typeof path !== 'string') return null;
  const parsed = parseJson(result.content);
  const providerScope = isRecord(parsed) ? stringField(parsed, 'providerScope') : null;

  return (
    <ResultPanel>
      <div className="flex items-center gap-1.5 text-ink">
        <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-success" />
        <span className="min-w-0 flex-1 truncate">
          Commented on <span className="font-mono text-[11px]">{path}</span> in PR #{prNumber}
        </span>
        {providerScope !== null && (
          <a
            href={`https://github.com/${providerScope}/pull/${String(prNumber)}/files`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto shrink-0 text-[11px] text-accent underline"
          >
            Open
          </a>
        )}
      </div>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * list_card_prs / card_link_pr (work/card-pull-request.service.ts)
 * -------------------------------------------------------------------------- */

function renderListCardPrs(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!Array.isArray(parsed)) return <ResultPanel>{result.content}</ResultPanel>;

  const links: { providerScope: string; prNumber: number }[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) return null;
    const providerScope = stringField(entry, 'providerScope');
    const prNumber = entry['prNumber'];
    if (providerScope === null || typeof prNumber !== 'number') return null;
    links.push({ providerScope, prNumber });
  }

  return (
    <ResultPanel>
      <EntityList>
        {links.map((link) => (
          <li key={`${link.providerScope}#${String(link.prNumber)}`}>
            <a
              href={`https://github.com/${link.providerScope}/pull/${String(link.prNumber)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-hover"
            >
              <GitPullRequest aria-hidden="true" className="size-3.5 shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-ink">
                {link.providerScope}#{link.prNumber}
              </span>
            </a>
          </li>
        ))}
      </EntityList>
    </ResultPanel>
  );
}

/** Reads `cardId` from the CALL's input (the model already has it, same as
    every other card-write renderer) — `linkCardPullRequest`'s own output
    carries no card identity back, on the identical "no backend enrichment
    for a frontend convenience" reasoning `cardWriteRenderer`'s own header
    states. */
function renderCardLinkPr(
  result: ToolResultMessage,
  call: ToolCallWire,
  ctx: ToolResultRenderContext,
): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const cardId = call.input['cardId'];
  const prNumber = call.input['prNumber'];
  if (typeof cardId !== 'string' || typeof prNumber !== 'number') return null;

  return (
    <CardActionResult
      cardId={cardId}
      verb={`Linked PR #${String(prNumber)}`}
      onOpenCard={ctx.onOpenCard}
    />
  );
}

/* -------------------------------------------------------------------------- *
 * create_branch_from_card (automation/branch.service.ts)
 * -------------------------------------------------------------------------- */

function renderCreateBranchFromCard(result: ToolResultMessage): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!isRecord(parsed)) return null;
  const branchName = stringField(parsed, 'branchName');
  const url = stringField(parsed, 'url');
  if (branchName === null || url === null) return null;
  const alreadyExisted = parsed['alreadyExisted'] === true;

  return (
    <ResultPanel>
      <div className="flex items-center gap-1.5 text-ink">
        <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-success" />
        <span>
          {alreadyExisted ? 'Branch already existed: ' : 'Created branch '}
          <span className="font-mono text-[11px]">{branchName}</span>
        </span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto shrink-0 text-[11px] text-accent underline"
        >
          Open
        </a>
      </div>
    </ResultPanel>
  );
}

/* -------------------------------------------------------------------------- *
 * Dispatch
 * -------------------------------------------------------------------------- */

const RENDERERS: Readonly<
  Record<
    string,
    (
      result: ToolResultMessage,
      call: ToolCallWire,
      ctx: ToolResultRenderContext,
    ) => ReactNode | null
  >
> = {
  search: (result, _call, ctx) => renderSearch(result, ctx),
  my_cards: (result, _call, ctx) => renderMyCards(result, ctx),
  list_projects: (result) => renderListProjects(result),
  list_boards: (result) => renderListBoards(result),
  list_labels: (result) => renderListLabels(result),
  list_members: (result) => renderListMembers(result),
  list_sprints: (result, call) => renderListSprints(result, call),
  list_statuses: (result) => renderListStatuses(result),
  list_channels: (result) => renderListChannels(result),
  find_card: (result, _call, ctx) => renderFindCard(result, ctx),
  card_create: (result, _call, ctx) => renderCardCreate(result, ctx),
  card_update: (result, call, ctx) => renderCardUpdate(result, call, ctx),
  card_assign: (result, call, ctx) => renderCardAssign(result, call, ctx),
  card_unassign: (result, call, ctx) => renderCardUnassign(result, call, ctx),
  card_set_status: (result, call, ctx) => renderCardSetStatus(result, call, ctx),
  card_add_labels: (result, call, ctx) => renderCardAddLabels(result, call, ctx),
  card_remove_labels: (result, call, ctx) => renderCardRemoveLabels(result, call, ctx),
  card_move: (result, call, ctx) => renderCardMove(result, call, ctx),
  card_add_comment: (result, call, ctx) => renderCardAddComment(result, call, ctx),
  sprint_create: (result, call) => renderSprintCreate(result, call),
  sprint_add_cards: (result) => renderSprintAddCards(result),
  chat_post_message: (result) => renderChatPostMessage(result),
  docs_create_page: (result, call) => renderDocsCreatePage(result, call),
  list_repos: (result) => renderListRepos(result),
  list_prs: (result) => renderListPrs(result),
  get_pr_diff: (result, call, ctx) => renderGetPrDiff(result, call, ctx),
  get_pr_files: (result, call, ctx) => renderGetPrFiles(result, call, ctx),
  get_pr_file_content: (result) => renderGetPrFileContent(result),
  get_pr_file_diff: (result) => renderGetPrFileDiff(result),
  get_pr_comments: (result) => renderGetPrComments(result),
  pr_post_comment: (result, call) => renderPrPostComment(result, call),
  pr_comment_on_file: (result, call) => renderPrCommentOnFile(result, call),
  pr_request_changes: (result, call) => renderPrRequestChanges(result, call),
  pr_approve: (result, call) => renderPrApprove(result, call),
  pr_merge: (result, call) => renderPrMerge(result, call),
  pr_close: (result, call) => renderPrClose(result, call),
  list_card_prs: (result) => renderListCardPrs(result),
  card_link_pr: (result, call, ctx) => renderCardLinkPr(result, call, ctx),
  create_branch_from_card: (result) => renderCreateBranchFromCard(result),
};

/**
 * Every `tool_result`, keyed by the `toolCallId` it answers — how a
 * displayed assistant turn finds the REAL data behind one of its own
 * `toolCalls`, rather than trusting the model's own retelling of it.
 * A `switch` on `role`, not `===` — the identical `AiMessage.role`/guardrail
 * 7 name collision this file's own header already documents for
 * `MessageBubble`.
 */
export function toolResultsById(
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

/** `null` means "no renderer recognized this tool/shape" — the caller falls
    back to the plain "Used `<tool>`" chip. */
export function renderToolResult(
  call: ToolCallWire,
  resultsById: ReadonlyMap<string, ToolResultMessage>,
  ctx: ToolResultRenderContext,
): ReactNode | null {
  const result = resultsById.get(call.id);
  if (result === undefined) return null;
  const renderer = RENDERERS[call.name];
  if (renderer === undefined) return null;
  return renderer(result, call, ctx);
}
