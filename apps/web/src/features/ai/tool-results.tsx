import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
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
import { Avatar, Badge } from '../../components/primitives.js';
import { formatDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import type { Priority } from '../work/api.js';
import { PRIORITY_LABEL, PRIORITY_SWATCH } from '../work/priority-colors.js';
import type { ChatMessageWire, ToolCallWire } from './api.js';

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
 */

export interface ToolResultRenderContext {
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
    `standup-page.tsx`'s buckets and this file's own `EntityList` use. */
function ResultPanel({ children }: { readonly children: ReactNode }) {
  return (
    <div className="space-y-1 rounded-lg border border-line/60 bg-surface px-2.5 py-2 text-xs">
      {children}
    </div>
  );
}

function ErrorNote({ message }: { readonly message: string }) {
  return (
    <div className="flex items-start gap-1.5 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-xs text-danger">
      <XCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function EntityList({ children }: { readonly children: ReactNode }) {
  return <ul className="space-y-1">{children}</ul>;
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
          <span className="block truncate text-[11px] text-ink-faint">{secondary}</span>
        )}
      </span>
    </>
  );

  return (
    <li>
      {onClick === undefined ? (
        <div className="flex items-center gap-2 rounded-md px-1.5 py-1">{content}</div>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-surface-hover"
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
    <ResultPanel>
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
                className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-hover"
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
                <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                  {card.reference}
                </span>
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
const renderCardSetStatus = cardWriteRenderer('Status updated');
const renderCardAddLabels = cardWriteRenderer('Labels updated');

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

function renderChatPostMessage(result: ToolResultMessage, call: ToolCallWire): ReactNode | null {
  if (result.isError === true) return <ErrorNote message={result.content} />;
  const parsed = parseJson(result.content);
  if (!isRecord(parsed) || stringField(parsed, 'messageId') === null) return null;

  const channelId = typeof call.input['channelId'] === 'string' ? call.input['channelId'] : null;

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
  card_create: (result, _call, ctx) => renderCardCreate(result, ctx),
  card_update: (result, call, ctx) => renderCardUpdate(result, call, ctx),
  card_assign: (result, call, ctx) => renderCardAssign(result, call, ctx),
  card_set_status: (result, call, ctx) => renderCardSetStatus(result, call, ctx),
  card_add_labels: (result, call, ctx) => renderCardAddLabels(result, call, ctx),
  sprint_create: (result, call) => renderSprintCreate(result, call),
  sprint_add_cards: (result) => renderSprintAddCards(result),
  chat_post_message: (result, call) => renderChatPostMessage(result, call),
  docs_create_page: (result, call) => renderDocsCreatePage(result, call),
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
