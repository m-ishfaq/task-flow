import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parse, type TqlError } from '@taskflow/filter';
import { unsafeAsId, type SearchHit } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { cn } from '../../lib/cn.js';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useToast } from '../../lib/toast-context.js';
import { formatRelative } from '../../lib/format.js';
import { Search } from 'lucide-react';
import { Button, Empty, PageHeader, Skeleton } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { savedSearchesQuery, searchResultsQuery } from './api.js';
import { freeTextTermOf, splitOnTerm } from './term.js';

/**
 * Cross-product search (ai/phase-8-search.md §3.1, Phase 8 Wave 3).
 *
 * One TQL input, live per-token errors, type facets, and a result list whose
 * rows navigate to the source resource — the client never re-derives
 * authorization (§2.7: the server ran per-hit `can()` before any of these
 * rows were returned; the permalink just needs the parent ids the hit's
 * metadata carries).
 *
 * ## The server is the only parser — the client only previews
 *
 * `parse()` runs HERE too, but only to underline the bad token and to keep a
 * broken query from being sent. The API re-parses and re-validates every
 * request (§2.7); a client parser that drifted from the real one gets a
 * VALIDATION error, not a wrong result. Nothing user-typed reaches the
 * database except through the server's own whitelist + placeholders.
 *
 * ## The facet is honest
 *
 * A facet chip appends `type = card` (etc.) to the text the server parses —
 * it is not a separate client-side filter over a partial list. That keeps
 * one query source of truth: the text box shows exactly what ran, and the
 * facet is visible in it, which is how a user learns the language.
 */

type Facet = SearchHit['type'] | 'all';

const FACETS: readonly { id: Facet; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'card', label: 'Cards' },
  { id: 'message', label: 'Messages' },
  { id: 'page', label: 'Pages' },
  { id: 'comment', label: 'Comments' },
  /* Transcripts are indexed for everyone but returned only to a caller with
     `recording:read` — the route drops the rest per-hit (§2.7). The chip is
     shown to everybody anyway: hiding it would be the UI re-deriving an
     authorization decision, which §8.2 forbids precisely because the hidden
     version is the one that never gets tested. A member who picks it gets an
     honest empty result. */
  { id: 'transcript', label: 'Transcripts' },
];

/** Appends the facet's type constraint onto the typed query. */
function withFacet(query: string, facet: Facet): string {
  if (facet === 'all') return query;
  const type = `type = ${facet}`;
  const trimmed = query.trim();
  return trimmed === '' ? type : `${trimmed} AND ${type}`;
}

const TYPE_BADGE: Record<SearchHit['type'], { label: string; className: string }> = {
  card: { label: 'Card', className: 'bg-accent/10 text-accent' },
  message: { label: 'Message', className: 'bg-violet-500/10 text-violet-500' },
  page: { label: 'Page', className: 'bg-emerald-500/10 text-emerald-500' },
  comment: { label: 'Comment', className: 'bg-amber-500/10 text-amber-500' },
  transcript: { label: 'Transcript', className: 'bg-sky-500/10 text-sky-500' },
};

export function SearchPage({ initialQuery }: { readonly initialQuery: string }) {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();

  /* Seeded ONCE from the URL so a shared `?q=` link opens with its query
     typed in. The URL is written back on debounce with `replace`, so it stays
     a faithful shareable copy of what is on screen without spamming history —
     but the input never re-reads it, or every navigation would fight the
     cursor (the same reason `boardRoute`'s filter is one-directional). */
  const [text, setText] = useState(initialQuery);
  const [facet, setFacet] = useState<Facet>('all');
  const [debounced, setDebounced] = useState(initialQuery);
  const [active, setActive] = useState(0);

  const errors = useMemo(() => {
    const parsed = parse(text);
    return parsed.ok ? [] : parsed.errors;
  }, [text]);

  /* Live per-token errors are the point of §3.1's "underline the bad token":
     a query with a syntax problem is not sent at all. `debounced` may still
     hold a valid earlier text for 250 ms; `errors.length > 0` gates the
     query so the stale string cannot fire while the new one is broken. */
  const effectiveQuery = withFacet(debounced, facet);
  const sendable = effectiveQuery.trim() !== '' && errors.length === 0;

  const results = useQuery({
    ...searchResultsQuery(orgId, effectiveQuery),
    enabled: sendable && orgId !== '',
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(text);
      setActive(0);
      void navigate({ to: '/search', search: { q: text }, replace: true });
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [navigate, text]);

  /* The highlight term is the FIRST free-text term of what is currently typed
     (not the debounced copy — the underline should follow the keystroke). */
  const term = useMemo(() => {
    const parsed = parse(text);
    return parsed.ok ? freeTextTermOf(parsed.filter) : null;
  }, [text]);

  /* The hit's ids are plain strings off the wire. Search params accept them
     as-is — `validateSearch` runs the shared branded schemas on whatever the
     URL carries, which is where the trust boundary lives. The PATH params of
     `/boards/$boardId` are typed branded, so those two values go through
     `unsafeAsId` — the sanctioned constructor for exactly this moment, a
     wire value about to become a branded id at a boundary. */
  const open = (hit: SearchHit) => {
    const meta = hit.metadata;
    switch (hit.type) {
      case 'card': {
        /* `project_id` only exists on card metadata — it is the discriminant
           that tells the card variant apart from a card comment's. */
        if ('project_id' in meta) {
          void navigate({
            to: '/boards/$boardId',
            params: { boardId: unsafeAsId<'BoardId'>(meta.board_id) },
            search: {
              view: 'board',
              card: hit.entityId,
              project: meta.project_id,
            },
          });
        }
        return;
      }
      case 'message': {
        if ('channel_id' in meta) {
          void navigate({ to: '/chat', search: { channel: meta.channel_id } });
        }
        return;
      }
      case 'page': {
        if ('space_id' in meta) {
          void navigate({
            to: '/docs',
            search: { space: meta.space_id, page: hit.entityId },
          });
        }
        return;
      }
      case 'comment': {
        if ('card_id' in meta) {
          void navigate({
            to: '/boards/$boardId',
            params: { boardId: unsafeAsId<'BoardId'>(meta.board_id) },
            search: { view: 'board', card: meta.card_id },
          });
        } else if ('page_id' in meta) {
          /* The space id is what lets docs render the tree AND open the page
             (indexer.relay.ts stores it for exactly this permalink). */
          void navigate({
            to: '/docs',
            search: { space: meta.space_id, page: meta.page_id },
          });
        }
        return;
      }
      case 'transcript': {
        /* The CALL is what opens, not the transcript — there is no transcript
           route, because a transcript is a property of a call and the call log
           is where it is read. `?call=` expands that row (router.tsx). */
        if ('call_id' in meta) {
          void navigate({ to: '/calls', search: { tab: 'calls', call: meta.call_id } });
        }
        return;
      }
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-5 overflow-y-auto p-4 md:p-8">
      <PageHeader
        title="Search"
        description="One query across cards, messages, pages, comments and call transcripts — TQL, the same language the board filter speaks."
      />

      <div className="shrink-0 space-y-2">
        <QueryInput
          value={text}
          onChange={setText}
          errors={errors}
          onKeyDown={(event) => {
            /* Captured once so the closures below see a narrowed, stable
               array rather than re-reading `results.data` (which TypeScript
               cannot narrow across the guard into a closure). */
            const hits = results.data;
            if (hits === undefined || hits.length === 0) return;
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, hits.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const hit = hits[active];
              if (hit !== undefined) open(hit);
            }
          }}
        />

        <SavedSearches
          orgId={orgId}
          current={text}
          onPick={(query) => {
            setText(query);
            setFacet('all');
            setActive(0);
          }}
        />

        <div className="flex flex-wrap items-center gap-1.5">
          {FACETS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setFacet(entry.id);
                setActive(0);
              }}
              aria-pressed={facet === entry.id}
              className={cn(
                'rounded-full border px-3 py-1 text-[11px] font-medium transition-colors duration-[var(--motion-fast)]',
                facet === entry.id
                  ? 'border-accent bg-accent text-white'
                  : 'border-line/50 text-ink-muted hover:border-ink-faint hover:text-ink',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {errors.length > 0 && (
        <ul className="shrink-0 space-y-1 rounded border border-danger/30 bg-danger/5 p-3">
          {errors.map((error, index) => (
            <li key={index} className="text-xs text-danger">
              {error.message}
            </li>
          ))}
        </ul>
      )}

      <main className="min-h-0 flex-1">
        {text.trim() === '' ? (
          <Empty
            icon={<Search aria-hidden="true" className="size-5" strokeWidth={1.75} />}
            title="Search your workspace"
            description="Try “deploy outage”, or type `assignee = me AND due < -7d` to combine filters with free text."
          />
        ) : errors.length > 0 ? (
          <Empty
            title="Fix the query to search"
            description="The underlined tokens above need attention."
          />
        ) : results.isPending ? (
          <div aria-busy="true" className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : results.isError ? (
          <ErrorView error={results.error} title="Could not search" />
        ) : results.data.length === 0 ? (
          <Empty title="No results" description={`Nothing matched “${effectiveQuery.trim()}”.`} />
        ) : (
          <ul className="space-y-1.5" role="listbox" aria-label="Search results">
            {results.data.map((hit, index) => (
              <li key={`${hit.type}-${hit.entityId}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => {
                    setActive(index);
                  }}
                  onClick={() => {
                    open(hit);
                  }}
                  className={cn(
                    'flex w-full flex-col gap-1 rounded-xl border px-4 py-3 text-left transition-all duration-[var(--motion-fast)]',
                    index === active
                      ? 'border-accent/40 bg-accent/5 shadow-sm'
                      : 'border-line/50 bg-surface-raised hover:border-line-strong hover:bg-surface-hover',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase',
                        TYPE_BADGE[hit.type].className,
                      )}
                    >
                      {TYPE_BADGE[hit.type].label}
                    </span>
                    {hit.archived && (
                      <span className="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-ink-faint">
                        Archived
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                      {hit.title ?? `${TYPE_BADGE[hit.type].label} · ${hit.entityId}`}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-faint">
                      {formatRelative(hit.updatedAt)}
                    </span>
                  </div>
                  {hit.snippet !== null && (
                    <p className="line-clamp-2 text-xs text-ink-muted">
                      <HighlightedSnippet snippet={hit.snippet} term={term} />
                    </p>
                  )}
                </button>
              </li>
            ))}
            <li className="pt-1 text-center text-[11px] text-ink-faint">
              {results.data.length} of at most {results.data.length} results
            </li>
          </ul>
        )}
      </main>
    </div>
  );
}

/**
 * Saved searches (§3.2) — the list, plus saving what is currently typed.
 *
 * ## Sharing is offered to everyone and refused by the server
 *
 * The "Share with the organization" checkbox is shown to every caller, not
 * hidden from members. §8.2 is explicit that a UI reimplementing `can()`
 * produces two models that drift, and the one users see is the one that is
 * never tested — so a member who ticks it gets an honest FORBIDDEN from the
 * server, rendered here, rather than a control that silently was not there.
 *
 * ## A broken entry stays visible
 *
 * The server re-parses each stored query and marks the unusable ones; they are
 * listed, disabled, and labelled. Dropping them from the list would leave
 * someone with a saved search that had simply vanished, and no way to find out
 * why or to delete it.
 */
function SavedSearches({
  orgId,
  current,
  onPick,
}: {
  readonly orgId: string;
  readonly current: string;
  readonly onPick: (query: string) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);

  const saved = useQuery({ ...savedSearchesQuery(orgId), enabled: orgId !== '' });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.savedSearches(orgId) });

  const create = useMutation({
    mutationFn: (input: { name: string; query: string; isShared: boolean }) =>
      api.search.saved.create.mutate(input),
    onSuccess: async () => {
      setNaming(false);
      setName('');
      setShare(false);
      await invalidate();
    },
    onError: (error: unknown) => {
      toast.failure('The search could not be saved', error);
    },
  });

  const remove = useMutation({
    mutationFn: (searchId: string) => api.search.saved.delete.mutate({ searchId }),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: unknown) => {
      toast.failure('The saved search could not be deleted', error);
    },
  });

  const entries = saved.data ?? [];
  const trimmed = current.trim();

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {entries.map((entry) => (
          <span
            key={entry.searchId}
            className="group inline-flex items-center rounded-full border border-line bg-surface-raised text-xs"
          >
            <button
              type="button"
              disabled={entry.broken}
              title={entry.broken ? 'This saved search no longer parses' : entry.query}
              onClick={() => {
                onPick(entry.query);
              }}
              className="rounded-l-full py-0.5 pr-1 pl-2.5 text-ink-muted hover:text-ink disabled:text-ink-faint disabled:line-through"
            >
              {entry.name}
              {entry.isShared && (
                <span className="ml-1 text-[10px] text-ink-faint" title="Shared with everyone">
                  ◇
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Delete saved search ${entry.name}`}
              disabled={remove.isPending}
              onClick={() => {
                remove.mutate(entry.searchId);
              }}
              className="rounded-r-full py-0.5 pr-2 pl-1 text-ink-faint hover:text-danger"
            >
              ×
            </button>
          </span>
        ))}

        {/* Saving is offered only for a query there is something to save. */}
        {trimmed !== '' && !naming && (
          <button
            type="button"
            onClick={() => {
              setNaming(true);
            }}
            className="rounded-full border border-dashed border-line px-2.5 py-0.5 text-xs text-ink-faint hover:border-accent hover:text-accent"
          >
            + Save this search
          </button>
        )}
      </div>

      {naming && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({ name: name.trim(), query: trimmed, isShared: share });
          }}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-raised px-2.5 py-2"
        >
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            maxLength={60}
            aria-label="Name for this saved search"
            placeholder="Name it"
            className="min-w-32 flex-1 rounded-lg border border-line/50 bg-surface-sunken px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
          />
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={share}
              onChange={(event) => {
                setShare(event.target.checked);
              }}
            />
            Share with the organization
          </label>
          <Button type="submit" size="sm" disabled={name.trim() === '' || create.isPending}>
            {create.isPending ? 'Saving…' : 'Save'}
          </Button>
          <button
            type="button"
            onClick={() => {
              setNaming(false);
              create.reset();
            }}
            className="text-xs text-ink-faint hover:text-ink"
          >
            Cancel
          </button>
          {create.isError && <ErrorText error={create.error} />}
        </form>
      )}
    </div>
  );
}

function HighlightedSnippet({
  snippet,
  term,
}: {
  readonly snippet: string;
  readonly term: string | null;
}) {
  if (term === null) return <>{snippet}</>;
  return (
    <>
      {splitOnTerm(snippet, term).map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-sm bg-warning/25 px-0.5 text-ink">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * The TQL input with the parse errors underlined in a mirrored layer.
 *
 * The textarea's text is opaque and sits on top; a transparent `<pre>` behind
 * it renders the SAME text with the error spans bordered in red, so the bad
 * token gets a red underline without any double-drawn characters. Both layers
 * share font, size, leading and padding — metrics mismatch is the one way
 * this technique silently misaligns, which is why the classes are duplicated
 * here rather than derived.
 */
function QueryInput({
  value,
  onChange,
  errors,
  onKeyDown,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly errors: readonly TqlError[];
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* Auto-grow: the input is one line until the query outgrows it, then the
     textarea — and the mirrored pre behind it — grow together. */
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    /* `String()` because the repo's lint refuses numbers in template
       literals (`restrict-template-expressions`) — the number is a measured
       pixel count, and stringifying it explicitly is the honest conversion. */
    el.style.height = `${String(el.scrollHeight)}px`;
  }, [value]);

  return (
    <div className="relative">
      <pre
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden font-mono text-sm leading-6 whitespace-pre-wrap break-words px-3 py-2 text-transparent"
      >
        {renderUnderlines(value, errors)}
      </pre>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoComplete="off"
        aria-label="Search query (TQL)"
        placeholder='Try "deploy outage", or `assignee = me AND due < -7d`'
        className="relative block w-full resize-none overflow-hidden rounded-xl border border-line/50 bg-surface-raised px-3.5 py-2.5 font-mono text-sm leading-6 text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent/25 placeholder:font-sans placeholder:text-ink-faint"
      />
    </div>
  );
}

/** The mirrored text with each error's span underlined in red. */
function renderUnderlines(text: string, errors: readonly TqlError[]): ReactNode {
  if (errors.length === 0) return text;

  /* Errors are sorted by offset; chunks between them are plain text. A
     misbehaving error (offset beyond the current text — the user deleted
     past it) is dropped rather than rendered out of range. */
  const sorted = [...errors].sort((a, b) => a.offset - b.offset);
  const parts: ReactNode[] = [];
  let cursor = 0;
  let partKey = 0;

  for (const error of sorted) {
    if (error.offset < cursor || error.offset >= text.length) continue;
    if (error.offset > cursor) {
      parts.push(<span key={partKey}>{text.slice(cursor, error.offset)}</span>);
      partKey += 1;
    }
    const end = Math.min(text.length, error.offset + Math.max(1, error.length));
    parts.push(
      <span key={partKey} className="border-b-2 border-danger">
        {text.slice(error.offset, end)}
      </span>,
    );
    partKey += 1;
    cursor = end;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
