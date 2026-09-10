import { useMemo, useState, type ChangeEvent } from 'react';
import {
  ModalClose,
  ModalContent,
  ModalDescription,
  ModalRoot,
  ModalTitle,
  ModalTrigger,
} from '@taskflow/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, ListId, ProjectId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { Button, Empty, Spinner } from '../../components/primitives.js';
import { ErrorText } from '../../components/error-view.js';
import { listsQuery } from './api.js';
import {
  IMPORT_COLUMNS,
  detectMapping,
  parseCsv,
  rowsFromTable,
  type ImportColumn,
} from './csv.js';

/**
 * Import/export for a project (ai/phase-10-automation.md §7.7 — Wave 4
 * slice 5).
 *
 * Export downloads the SERVER's answer — the same query the board reads,
 * rendered to CSV/JSON on the API — so the file and the board can never
 * disagree about what a card is. The client's only job is turning the string
 * into a download.
 *
 * Import parses the file HERE (the server takes structured rows; parsing CSV
 * server-side would make the API understand file formats), runs the server's
 * dry-run to preview every row's errors with line numbers, and only then
 * performs the real import. The server is the strict half: every row goes
 * through the same services the UI's create uses, so an import cannot create
 * a card a user could not have created.
 *
 * The file's own line numbers are the row index plus the header offset, and
 * the server's 1-based `line` numbers index the DATA rows the client sends —
 * so the client adds one (line 1 of the rows array is line 2 of the file).
 */

const MAX_ROWS = 1_000;

interface ImportRow {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly status?: unknown;
  readonly assignees?: unknown;
  readonly labels?: unknown;
  readonly dueDate?: unknown;
  readonly priority?: unknown;
  readonly sprint?: unknown;
  /* `list` ROUTES the row to the list of that name on the target board; the
     chosen list is only the fallback. `reference` is accepted and ignored —
     it names an existing card, and import only creates.

     Both arrive on the CSV path (`IMPORT_COLUMNS` reads `list`) and on the
     JSON path, which passes an exported file through verbatim rather than
     mapping named columns. Typed here so this row shape stays assignable to
     what the route accepts. */
  readonly reference?: unknown;
  readonly list?: unknown;
}

interface PreviewResult {
  readonly created: number;
  readonly errors: readonly { line: number; error: string }[];
  /** Label names the project lacks — what the option would (or did) create. */
  readonly missingLabels: readonly string[];
  /** Where the cards landed, per list, largest first — empty on a dry run. */
  readonly createdByList: readonly { listId: string; name: string; count: number }[];
}

export interface ImportExportDialogProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly projectId: ProjectId;
  /**
   * `projects.list`'s per-project `capabilities.update` — importing is
   * `project:update` (creating labels, per the Import tab's own comment
   * above), Export is `project:read` and stays open to everyone. The Import
   * tab used to render for every viewer and let a Member's attempt come
   * back FORBIDDEN (Phase 15 §1's sweep).
   */
  readonly canManageProject: boolean;
}

export function ImportExportDialog({
  orgId,
  boardId,
  projectId,
  canManageProject,
}: ImportExportDialogProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'export' | 'import'>('export');

  return (
    <ModalRoot open={open} onOpenChange={setOpen}>
      <ModalTrigger asChild>
        <Button size="sm">Import/Export</Button>
      </ModalTrigger>
      <ModalContent size="lg" className="max-h-[85vh] overflow-y-auto p-4">
        <ModalTitle>Import / Export</ModalTitle>
        <ModalDescription>
          Move cards in and out of this project as CSV or JSON. An import creates cards through the
          same path the UI uses — nothing an import makes is a card you could not have made.
        </ModalDescription>

        <div
          className="mt-3 flex gap-1 rounded border border-line p-1"
          role="tablist"
          aria-label="Import or export"
        >
          {(['export', 'import'] as const)
            .filter((entry) => entry === 'export' || canManageProject)
            .map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={tab === entry}
                onClick={() => {
                  setTab(entry);
                }}
                className={`flex-1 rounded px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  tab === entry
                    ? 'bg-accent text-accent-ink'
                    : 'text-ink-muted hover:bg-surface-hover'
                }`}
              >
                {entry}
              </button>
            ))}
        </div>

        {tab === 'export' ? (
          <ExportTab orgId={orgId} boardId={boardId} projectId={projectId} />
        ) : (
          <ImportTab orgId={orgId} boardId={boardId} />
        )}

        <div className="mt-4 flex justify-end">
          <ModalClose asChild>
            <Button>Done</Button>
          </ModalClose>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/* -------------------------------------------------------------------------- *
 * Export
 * -------------------------------------------------------------------------- */

function ExportTab({
  orgId,
  boardId,
  projectId,
}: {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly projectId: ProjectId;
}) {
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  /* '' = the whole project; 'board' = this board; anything else is a list id.
     One control rather than two, because the three are alternatives and a pair
     of selects would let someone express "this board, that list" — a
     combination that has no meaning here. */
  const [scope, setScope] = useState<string>('');

  const lists = useQuery(listsQuery(orgId, boardId));

  const exportCards = useMutation({
    mutationFn: (chosen: 'csv' | 'json') =>
      api.work.cards.export.query({
        projectId,
        format: chosen,
        boardId: scope === 'board' ? boardId : null,
        listId: scope === '' || scope === 'board' ? null : (scope as ListId),
      }),
    onSuccess: (result) => {
      const blob = new Blob([result.content], {
        type: result.format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `cards-${boardId}.${result.format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
  });

  return (
    <div className="mt-4 space-y-3">
      <label className="block">
        <span className="text-xs font-medium text-ink-muted">What to export</span>
        <select
          value={scope}
          onChange={(event) => {
            setScope(event.target.value);
          }}
          className="mt-1 h-8 w-full rounded-md border border-line bg-surface-sunken px-2 text-xs text-ink"
        >
          <option value="">Whole project</option>
          <option value="board">This board</option>
          {(lists.data ?? []).map((list) => (
            <option key={list.listId} value={list.listId}>
              List: {list.name}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Export format"
          value={format}
          onChange={(event) => {
            setFormat(event.target.value as 'csv' | 'json');
          }}
          className="h-8 rounded-md border border-line bg-surface-sunken px-2 text-xs text-ink"
        >
          <option value="csv">CSV (spreadsheet)</option>
          <option value="json">JSON</option>
        </select>
        <Button
          variant="primary"
          size="sm"
          disabled={exportCards.isPending}
          onClick={() => {
            exportCards.mutate(format);
          }}
        >
          {exportCards.isPending ? <Spinner className="size-3" /> : 'Download'}
        </Button>
      </div>
      <p className="text-xs text-ink-faint">
        Every live card in the chosen scope, in board order — reference, title, description, status,
        list, assignees (emails), labels, priority and due date. Archived cards are not exported.
      </p>
      {exportCards.isError && <ErrorText error={exportCards.error} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Import
 * -------------------------------------------------------------------------- */

function ImportTab({ orgId, boardId }: { readonly orgId: string; readonly boardId: BoardId }) {
  const queryClient = useQueryClient();
  const lists = useQuery(listsQuery(orgId, boardId));

  const [listId, setListId] = useState('');
  /* The file as parsed — headers and raw cells. The MAPPING turns it into
     rows, so changing a mapping re-derives them without re-reading the file. */
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [mapping, setMapping] = useState<Readonly<Record<ImportColumn, string | null>> | null>(
    null,
  );
  const [fileName, setFileName] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  /* The server's last dry-run answer — the preview. */
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  /* The real import's result, shown once and cleared by the next file. */
  const [done, setDone] = useState<PreviewResult | null>(null);
  const [createLabels, setCreateLabels] = useState(false);

  const importCards = useMutation({
    mutationFn: (input: {
      listId: string;
      rows: ImportRow[];
      dryRun: boolean;
      createMissingLabels: boolean;
    }) => api.work.cards.import.mutate(input),
    onSuccess: (result, input) => {
      if (input.dryRun) {
        setPreview(result);
        return;
      }
      setPreview(null);
      setDone(result);

      /* The file is SPENT. Leaving it loaded left the mapping step, the row
         count and an Import button all still on screen after a successful
         import — so the obvious next action was to import the same file a
         second time, and the result panel read as a preview of what was about
         to happen rather than a report of what just did. Cleared so the tab
         returns to "choose a file", ready for the next one. The result panel
         survives because `done` is separate. */
      setTable(null);
      setMapping(null);
      setFileName(null);
      setTruncated(false);

      if (result.created > 0) {
        /* The board's card lists and each column's count both changed. */
        void queryClient.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) });
        void queryClient.invalidateQueries({ queryKey: keys.lists(orgId, boardId) });
      }
    },
  });

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;

    setParseError(null);
    setPreview(null);
    setDone(null);
    setFileName(file.name);

    void file.text().then((text) => {
      try {
        const parsed = file.name.toLowerCase().endsWith('.json')
          ? tableFromJson(text)
          : tableFromCsv(text);
        setTable(parsed);
        /* Guessed once, on load. Every guess is visible and overridable in the
           mapping step below — detection is a starting point, not an answer. */
        setMapping(detectMapping(parsed.headers));
        setTruncated(parsed.truncated);
      } catch (error) {
        setTable(null);
        setMapping(null);
        setParseError(error instanceof Error ? error.message : 'Could not read that file.');
      }
    });
  };

  /* The rows the server will receive, derived from the file plus the mapping.
     Recomputed whenever either changes, so the count on the button and the
     preview always describe the mapping currently on screen. */
  const rows = useMemo(
    () => (table === null || mapping === null ? null : rowsFromTable(table, mapping)),
    [table, mapping],
  );

  /* Title is the one field with no default and no server-side fallback — a row
     without one is refused. Blocking the preview here says so once, instead of
     letting someone read the same error 150 times. */
  const titleMapped = mapping !== null && mapping.title !== null;
  const ready = rows !== null && rows.length > 0 && listId !== '' && titleMapped;
  const hasErrors = (preview?.errors.length ?? 0) > 0;

  /* How many rows the server would actually create. The import is atomic PER
     ROW (§7.7) — a bad row fails alone and the rest are written — so this is
     the honest count, and it is what the button promises.

     `hasErrors` deliberately does NOT disable the import. It used to, which
     silently converted a per-row contract into an all-or-nothing one: a
     150-row file with 80 unresolvable labels blocked the 70 valid cards the
     server was perfectly willing to create, and the only way forward was to
     edit the file by hand. The errors are shown either way; the choice of
     whether "most of it" is good enough belongs to the person importing. */
  const importableCount = (rows?.length ?? 0) - (preview?.errors.length ?? 0);

  return (
    <div className="mt-4 space-y-3">
      <label className="block">
        <span className="text-xs font-medium text-ink-muted">Target list</span>
        <select
          value={listId}
          onChange={(event) => {
            setListId(event.target.value);
          }}
          className="mt-1 h-8 w-full rounded-md border border-line bg-surface-sunken px-2 text-xs text-ink"
        >
          <option value="">Choose a list…</option>
          {(lists.data ?? []).map((list) => (
            <option key={list.listId} value={list.listId}>
              {list.name}
            </option>
          ))}
        </select>
        {/* Said here rather than left to be discovered: the chosen list stopped
            being where everything lands the moment rows started routing by
            their own `list` column, and a person importing a whole board needs
            to know their columns survive BEFORE they click. */}
        <span className="mt-1 block text-[11px] text-ink-faint">
          Rows carrying a <code className="font-mono">list</code> column go to the list of that name
          on this board. This is where the rest land.
        </span>
      </label>

      {/* Off by default deliberately — a typo'd column would otherwise mint
          junk labels on a project every card can then be tagged with. It
          grants nothing extra: managing the label set is already
          `project:update`, which importing requires. */}
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={createLabels}
          onChange={(event) => {
            setCreateLabels(event.target.checked);
            /* The preview was computed under the OTHER answer, so it no longer
               describes what would happen. Cleared rather than left on screen
               to be misread as current. */
            setPreview(null);
          }}
          className="mt-0.5"
        />
        <span className="text-[11px] text-ink-muted">
          Create labels this project does not have
          <span className="block text-ink-faint">
            Statuses are never created — a status carries a category that decides whether a card
            counts as done, and that cannot be guessed from a name.
          </span>
        </span>
      </label>

      <label className="block cursor-pointer rounded border border-dashed border-line bg-surface-sunken/60 p-4 text-center text-xs text-ink-muted transition-colors hover:bg-surface-hover">
        <input
          type="file"
          accept=".csv,.json,text/csv,application/json"
          className="hidden"
          onChange={onFile}
        />
        {fileName === null ? (
          'Choose a CSV or JSON file'
        ) : (
          <>
            <span className="font-medium text-ink">{fileName}</span> — choose another
          </>
        )}
      </label>

      {rows !== null && (
        <p className="text-xs text-ink-faint">
          {rows.length} {rows.length === 1 ? 'row' : 'rows'}
          {truncated && ' (first 1,000 only — the server refuses larger batches)'}
          {fileName !== null && ` from ${fileName}`}
        </p>
      )}
      {parseError !== null && <ErrorText error={new Error(parseError)} />}

      {/* The mapping step. Purely client-side: the API takes structured rows
          and has never known what a file header is, so pointing `Summary` at
          `title` needs no server change at all — which is also why a file from
          Jira or a hand-kept spreadsheet works without anyone renaming
          columns in Excel first. */}
      {table !== null && mapping !== null && (
        <div className="rounded border border-line/50">
          <p className="border-b border-line px-3 py-2 text-xs font-medium text-ink">
            Match the file&rsquo;s columns
            <span className="mt-0.5 block font-normal text-[11px] text-ink-faint">
              Guessed from the header names. Change anything that is wrong — only{' '}
              <code className="font-mono">title</code> is required.
            </span>
          </p>
          <ul className="divide-y divide-line/40">
            {IMPORT_COLUMNS.map((column) => (
              <li key={column} className="flex items-center gap-2 px-3 py-1.5">
                <span className="w-24 shrink-0 font-mono text-[11px] text-ink">
                  {column}
                  {column === 'title' && <span className="text-danger"> *</span>}
                </span>
                <select
                  aria-label={`Source column for ${column}`}
                  value={mapping[column] ?? ''}
                  onChange={(event) => {
                    const next = event.target.value;
                    setMapping({ ...mapping, [column]: next === '' ? null : next });
                    /* The preview described the OLD mapping. */
                    setPreview(null);
                  }}
                  className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface-sunken px-1.5 text-xs text-ink"
                >
                  <option value="">— not imported —</option>
                  {table.headers.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
          {!titleMapped && (
            <p className="border-t border-line px-3 py-2 text-[11px] text-danger">
              Point <code className="font-mono">title</code> at a column — a card cannot be created
              without one.
            </p>
          )}
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!ready || importCards.isPending}
            onClick={() => {
              importCards.mutate({ listId, rows, dryRun: true, createMissingLabels: createLabels });
            }}
          >
            Preview
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!ready || importCards.isPending || preview === null || importableCount <= 0}
            onClick={() => {
              importCards.mutate({
                listId,
                rows,
                dryRun: false,
                createMissingLabels: createLabels,
              });
            }}
          >
            {hasErrors
              ? `Import ${String(importableCount)} of ${String(rows.length)} cards`
              : `Import ${String(rows.length)} ${rows.length === 1 ? 'card' : 'cards'}`}
          </Button>
          {importCards.isPending && <Spinner />}
        </div>
      )}

      {preview !== null && rows !== null && (
        <div className="rounded border border-line/50">
          {/* What the file needs that the project does not have, named. This
              is the difference between "80 rows failed" and "these four labels
              are missing" — the same fact, but one of them can be acted on. */}
          {preview.missingLabels.length > 0 && (
            <p className="border-b border-line px-3 py-2 text-xs text-ink">
              <span className="font-medium">
                {String(preview.missingLabels.length)}{' '}
                {preview.missingLabels.length === 1 ? 'label is' : 'labels are'} not in this
                project:
              </span>{' '}
              <span className="text-ink-muted">{preview.missingLabels.join(', ')}</span>
              <span className="mt-0.5 block text-[11px] text-ink-faint">
                {createLabels
                  ? 'These will be created when you import.'
                  : 'Tick “Create labels this project does not have” above, or add them in project settings first.'}
              </span>
            </p>
          )}

          {hasErrors ? (
            <>
              {/* Stated BEFORE the list, because the list is long and the
                  actionable fact — that most of the file still imports — is
                  otherwise below the fold of a scrolling error panel. */}
              <p className="border-b border-line px-3 py-2 text-xs text-ink">
                {importableCount > 0 ? (
                  <>
                    <span className="font-medium">
                      {String(importableCount)} of {String(rows.length)} rows will import.
                    </span>{' '}
                    The {String(preview.errors.length)} below will be skipped — fix them and import
                    again, or continue without them.
                  </>
                ) : (
                  <span className="font-medium">
                    No row can be imported. Fix the problems below and preview again.
                  </span>
                )}
              </p>
              <ul className="max-h-48 divide-y divide-line/40 overflow-y-auto">
                {preview.errors.map((entry) => (
                  <li key={entry.line} className="px-3 py-1.5 text-xs text-danger">
                    <span className="font-medium">Row {String(entry.line + 1)}:</span> {entry.error}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="px-3 py-2 text-xs text-ink">
              Preview passed — {rows.length} {rows.length === 1 ? 'card' : 'cards'} ready to import.
            </p>
          )}
        </div>
      )}

      {done !== null && (
        <div className="rounded-md border border-line bg-surface-sunken/60 p-3 text-xs">
          <p className="font-medium text-ink">
            Imported {done.created} {done.created === 1 ? 'card' : 'cards'}
            {done.errors.length > 0 &&
              `, ${String(done.errors.length)} ${done.errors.length === 1 ? 'row' : 'rows'} failed`}
            .
          </p>

          {/* WHERE they went. Rows route by their own `list` column, so the
              count alone does not say — and the board behind this dialog may
              not be showing the list most of them landed in. */}
          {done.createdByList.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {done.createdByList.map((entry) => (
                <li key={entry.listId} className="flex items-baseline gap-2 text-ink-muted">
                  <span className="tabular-nums text-ink">{entry.count}</span>
                  <span className="truncate">{entry.name}</span>
                </li>
              ))}
            </ul>
          )}

          {done.missingLabels.length > 0 && (
            <p className="mt-1.5 text-ink-faint">
              Created {done.missingLabels.length}{' '}
              {done.missingLabels.length === 1 ? 'label' : 'labels'}:{' '}
              {done.missingLabels.join(', ')}
            </p>
          )}
          {done.errors.length > 0 && (
            <ul className="mt-2 space-y-1">
              {done.errors.map((entry) => (
                <li key={entry.line} className="text-danger">
                  Row {String(entry.line + 1)}: {entry.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {rows !== null && rows.length === 0 && (
        <Empty
          title="No data rows in that file"
          description="The CSV needs a header row and at least one card."
        />
      )}

      {importCards.isError && <ErrorText error={importCards.error} />}
    </div>
  );
}

/** CSV → rows, mapping the header row to the import columns. */
/** A parsed file: its header names, and every data row as raw cells. */
interface ParsedTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly truncated: boolean;
}

/**
 * CSV to a raw table — no mapping applied.
 *
 * Splitting parse from MAPPING is what lets a file whose headers match nothing
 * still be imported: the table is the file as it is, and the mapping step is
 * where a person says which column means what.
 */
function tableFromCsv(text: string): ParsedTable {
  const parsed = parseCsv(text);
  if (parsed.length < 2) {
    throw new Error('The file needs a header row and at least one data row.');
  }

  const headers = parsed[0] ?? [];
  const rows = parsed.slice(1);
  return { headers, rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

/**
 * JSON to the same raw table.
 *
 * An array of objects has no header row, so the KEYS are the headers — the
 * union across every object, in first-seen order, so a file whose later rows
 * carry a field the first one omits still offers it in the mapping step.
 * Values are stringified because the mapping and the server both take text;
 * a number in a JSON cell is as valid as the same number in a CSV cell.
 */
function tableFromJson(text: string): ParsedTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== 'object' || entry === null || Array.isArray(entry))
  ) {
    throw new Error('JSON imports must be an array of card objects.');
  }

  const objects = parsed as Record<string, unknown>[];
  const headers: string[] = [];
  for (const entry of objects) {
    for (const key of Object.keys(entry)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }

  const rows = objects.map((entry) => headers.map((header) => jsonCell(entry[header])));

  return { headers, rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

/**
 * `JSON.stringify` with the return type it actually has.
 *
 * The lib signature says `string`, and that is not true: a function, a symbol,
 * or `undefined` serialises to `undefined`. Restating it here is the same move
 * `lib/wire.ts` makes for the tRPC boundary — the compiler is agreeing with a
 * lie, and the fix is to stop it agreeing rather than to delete the runtime
 * guard it thinks is dead. An annotated `const` does NOT work: TypeScript
 * narrows a const back to its initializer's type, so the `??` reads as
 * unreachable again. A call's return type is not narrowed that way.
 */
const stringifyOrUndefined: (value: unknown) => string | undefined = JSON.stringify;

/**
 * One JSON value as the text a mapping and the server both work in.
 *
 * The cases are enumerated rather than left to `String()`, which renders an
 * object as `[object Object]` — a cell that looks like data, maps like data,
 * and imports as a card titled `[object Object]`. A nested object cannot mean
 * anything as a card field, so it is serialised instead: still not importable,
 * but visibly wrong in the mapping preview rather than invisibly wrong.
 *
 * Arrays are joined with `; `, matching what the CSV writer emits for
 * assignees and labels, so both paths reach `splitCell` in the same shape.
 */
function jsonCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => jsonCell(item)).join('; ');
  try {
    /* A function or a symbol reaches here past the checks above and serialises
       to `undefined` — see `stringifyOrUndefined`. */
    return stringifyOrUndefined(value) ?? '';
  } catch {
    /* Circular, or a BigInt — neither is a card field. */
    return '';
  }
}
