import { and, asc, eq, inArray, isNull, schema, withOrgScope } from '@taskflow/db';
import {
  errors,
  Priority,
  type BoardId,
  type CardId,
  type LabelId,
  type ListId,
  type ProjectId,
  type SprintId,
  type StatusId,
  type UserId,
} from '@taskflow/contracts';
import { plainParagraph, type RichTextNode } from './richtext.js';
import { loadList } from './list.service.js';
import { requireProject } from './project.service.js';
import { orgOf, type WorkActor } from './shared.js';
import * as cards from './card.service.js';
import * as labels from './label.service.js';
import * as sprints from './sprint.service.js';

/**
 * Import/export (ai/phase-10-automation.md §7.7 — Phase 10 Wave 4 slice 5).
 *
 * The two properties this file exists to guarantee:
 *
 * ## Export never invents a query
 *
 * `exportCards` reads through the same shape `listCards` uses — the card,
 * its project key, list and status names — so an export and the board agree
 * about what a card IS. The one column the board summary does not carry,
 * `description`, is read as the already-flattened `description_text` (the
 * column search indexes), never by parsing the TipTap JSON.
 *
 * ## Import is the UI's create path, not a second one
 *
 * Every row goes through the same services the UI's create calls —
 * `createCard`, then `setCardStatus`, `assignCard`, `setCardLabels` and
 * `updateCard` — so an import cannot create a card a user could not have
 * created, and every card emits its own event, audit entry and search
 * re-index for free. The route gate is `project:update` (§7.7: a bulk write
 * is a project-level operation), and each row is validated and written
 * independently — a bad row fails alone with its line number, never the
 * batch. The dry-run validates every row and writes nothing.
 *
 * The batch is bounded at 1,000 rows here AND at the route — this guard is
 * the one that cannot be forgotten, because it is the one a future caller
 * that is not a tRPC route would hit.
 */

export type ExportFormat = 'csv' | 'json';

/** One exported card, as a flat, human-readable row. */
export interface ExportCard {
  readonly reference: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly list: string;
  readonly sprint: string;
  readonly assignees: string;
  readonly labels: string;
  readonly priority: string;
  readonly dueDate: string;
}

export interface ExportResult {
  readonly format: ExportFormat;
  readonly content: string;
}

const EXPORT_COLUMNS = [
  'reference',
  'title',
  'description',
  'status',
  'list',
  'sprint',
  'assignees',
  'labels',
  'priority',
  'dueDate',
] as const;

export async function exportCards(
  actor: WorkActor,
  input: {
    readonly projectId: ProjectId;
    readonly format: ExportFormat;
    /**
     * Narrow the export to one board, or one list of it.
     *
     * The PROJECT stays the authorization anchor either way — it is what
     * `requireProject` gates on, and what a restrictive tuple can take back.
     * A board or list is a FILTER within that answer, never a second way in:
     * both are checked to belong to `projectId`, so naming another project's
     * board cannot widen what this call returns.
     *
     * Whole-project remains the default, because that is what makes a file a
     * migration source. These exist for the narrower job — handing someone a
     * single column, or re-importing one board without dragging three others
     * along with it.
     */
    readonly boardId?: BoardId | null;
    readonly listId?: ListId | null;
  },
): Promise<ExportResult> {
  const rows = await withOrgScope(orgOf(actor), async (tx) => {
    /* The export is gated as a project read (the route's `project:read` is
       only layer 1) — this is where a restrictive tuple on the project takes
       the capability back. */
    await requireProject(tx, actor, input.projectId, 'project:read');

    /* The scope filters, each confirmed to live inside the project just
       authorized. A board or list from ANOTHER project answers notFound rather
       than quietly exporting nothing — an empty file and a refused request look
       identical to a caller, and only one of them is the truth. */
    const listId = input.listId ?? null;
    const boardId = input.boardId ?? null;

    if (listId !== null) {
      const list = await loadList(tx, listId);
      if (list.projectId !== input.projectId) throw errors.notFound();
    } else if (boardId !== null) {
      const board = await tx
        .select({ projectId: schema.boards.projectId })
        .from(schema.boards)
        .where(eq(schema.boards.id, boardId))
        .limit(1);
      if (board[0]?.projectId !== input.projectId) throw errors.notFound();
    }

    const cardsRows = await tx
      .select({
        cardId: schema.cards.id,
        number: schema.cards.number,
        projectKey: schema.projects.key,
        title: schema.cards.title,
        descriptionText: schema.cards.descriptionText,
        statusName: schema.statuses.name,
        listName: schema.lists.name,
        sprintName: schema.sprints.name,
        assigneeIds: schema.cards.assigneeIds,
        priority: schema.cards.priority,
        dueDate: schema.cards.dueDate,
      })
      .from(schema.cards)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.cards.projectId))
      /* LEFT joins: a card whose status was deleted is still a card, and a
         list that was archived must not silently drop its cards from the
         export. */
      .leftJoin(schema.lists, eq(schema.lists.id, schema.cards.listId))
      .leftJoin(schema.statuses, eq(schema.statuses.id, schema.cards.statusId))
      .leftJoin(schema.sprints, eq(schema.sprints.id, schema.cards.sprintId))
      .where(
        and(
          eq(schema.cards.projectId, input.projectId),
          isNull(schema.cards.deletedAt),
          /* Live cards only, matching the board: an export is a migration
             source, and migrating archived work is what the archived view is
             for. */
          isNull(schema.cards.archivedAt),
          /* The narrowing, most specific first. A list implies its board, so
             naming both is not a conflict to resolve — the list simply wins. */
          ...(listId !== null
            ? [eq(schema.cards.listId, listId)]
            : boardId !== null
              ? [eq(schema.cards.boardId, boardId)]
              : []),
        ),
      )
      .orderBy(asc(schema.cards.listId), asc(schema.cards.rank), asc(schema.cards.id));

    /* One query for every card's labels, not one per card. */
    const labelRows = await tx
      .select({ cardId: schema.cardLabels.cardId, name: schema.labels.name })
      .from(schema.cardLabels)
      .innerJoin(schema.labels, eq(schema.labels.id, schema.cardLabels.labelId))
      .where(eq(schema.cardLabels.projectId, input.projectId))
      .orderBy(schema.labels.name);

    const labelsOf = new Map<string, string[]>();
    for (const row of labelRows) {
      const list = labelsOf.get(row.cardId) ?? [];
      list.push(row.name);
      labelsOf.set(row.cardId, list);
    }

    /* Every assignee id the export will name, fetched once. `identity.users`
       carries no RLS (a user is not owned by an org — see member.service.ts),
       so this is a plain read inside the org-scoped transaction. */
    const assigneeIds = [...new Set(cardsRows.flatMap((row) => row.assigneeIds))];
    const users =
      assigneeIds.length === 0
        ? []
        : await tx
            .select({ userId: schema.users.id, email: schema.users.email })
            .from(schema.users)
            .where(inArray(schema.users.id, assigneeIds));

    const emailOf = new Map(users.map((user) => [user.userId, user.email]));

    return cardsRows.map((row) => ({
      reference: `${row.projectKey}-${String(row.number)}`,
      title: row.title,
      description: row.descriptionText ?? '',
      status: row.statusName ?? '',
      list: row.listName ?? '',
      /* Empty means the BACKLOG — `sprint_id IS NULL` is the backlog (0054),
         so there is no name to write and none to read back. */
      sprint: row.sprintName ?? '',
      assignees: row.assigneeIds.map((id) => emailOf.get(id) ?? '').join('; '),
      labels: labelsOf.get(row.cardId)?.join('; ') ?? '',
      priority: row.priority ?? '',
      dueDate: row.dueDate === null ? '' : row.dueDate.toISOString(),
    }));
  });

  return {
    format: input.format,
    content: input.format === 'csv' ? toCsv(rows) : `${JSON.stringify(rows, null, 2)}\n`,
  };
}

/**
 * A leading character that makes a spreadsheet interpret a cell as a
 * FORMULA rather than data (CWE-1236 — `=HYPERLINK(...)`, `+cmd|...`).
 * A card title or label is user-controlled input, and an exported file
 * that executes it the moment it is opened is an injection we shipped.
 */
const FORMULA_LEAD = /^[=+\-@]/u;

/**
 * The reverse of `csvCell`'s neutralization, applied to imported TEXT fields.
 *
 * Only strips the guard when the remainder would itself trigger the formula
 * rule, so a title that genuinely begins with an apostrophe (`'quoted`) is
 * left alone while the export's own output (`'=SUM(A1)`) round-trips back to
 * `=SUM(A1)`. This is the same convention spreadsheet-aware tools use.
 */
function unneutralize(value: string): string {
  return value.startsWith("'") && FORMULA_LEAD.test(value.slice(1)) ? value.slice(1) : value;
}

/**
 * RFC 4180 quoting plus formula neutralization, hand-rolled because the repo
 * carries no CSV dependency. A cell containing a comma, quote, newline or CR
 * is quoted; quotes inside are doubled; a cell that would open as a formula
 * is prefixed with an apostrophe so a spreadsheet reads it as text. The
 * import's `unneutralize` is the exact inverse, so the format round-trips.
 */
function csvCell(value: string): string {
  const neutralized = FORMULA_LEAD.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(neutralized)) return `"${neutralized.replace(/"/g, '""')}"`;
  return neutralized;
}

function toCsv(rows: readonly ExportCard[]): string {
  const lines = [EXPORT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/* -------------------------------------------------------------------------- *
 * Import
 * -------------------------------------------------------------------------- */

/**
 * One row as it arrives over the wire.
 *
 * Every field is `unknown` ON PURPOSE: the dry-run's job is to report per-row
 * errors with line numbers, and a route schema that rejected `title: 42`
 * would turn one bad row into a whole-request 400 with no line number at all.
 * The fields the schema DOES pin are the row's KEYS (`.strict()`, so a typo'd
 * column is refused loudly) and the row's shape (an array or a scalar in the
 * array is a file error, not a row error). Everything inside is validated in
 * `validateRow` against the project's live vocabulary.
 */
/**
 * Every key an import row may carry — THE source of truth.
 *
 * The route builds its `.strict()` Zod object from this list and `ImportRowInput`
 * below is derived from it, so the two cannot disagree. They used to be two
 * hand-written lists, and they drifted three separate times: first `reference`,
 * `list` and `priority`, then `sprint`. Each time the symptom was the same and
 * pointed nowhere near the cause — `.strict()` runs at the ROUTE, so the request
 * was rejected before a single row reached `validateRow`, and an unmodified
 * export produced one `Unrecognized key(s)` error per row naming a column this
 * app had just written itself.
 *
 * What each key does once accepted:
 *
 * - `title` `description` `status` `assignees` `labels` `dueDate` `priority`
 *   `sprint` — applied, resolved against the project's live vocabulary.
 * - `list` — ROUTES the row to the list of that name on the target board.
 * - `reference` — accepted and deliberately IGNORED. `WEB-142` names an
 *   EXISTING card and import only ever creates: the number comes from the
 *   project's own gapless counter, so honouring it would either collide or
 *   silently renumber.
 *
 * Accepting-and-ignoring `reference` is the narrow exception to `.strict()`'s
 * "a typo'd column is refused loudly" rule, and it is safe precisely because
 * that name is not a typo of anything — it is this exporter's own output. A
 * misspelled `titel` is still refused.
 */
export const IMPORT_ROW_KEYS = [
  'title',
  'description',
  'status',
  'assignees',
  'labels',
  'dueDate',
  'priority',
  'sprint',
  'list',
  'reference',
] as const;

/**
 * One row as it arrives over the wire.
 *
 * Every field is `unknown` ON PURPOSE: the dry-run's job is to report per-row
 * errors with line numbers, and a route schema that rejected `title: 42`
 * would turn one bad row into a whole-request 400 with no line number at all.
 * The fields the schema DOES pin are the row's KEYS (`.strict()`, so a typo'd
 * column is refused loudly) and the row's shape (an array or a scalar in the
 * array is a file error, not a row error). Everything inside is validated in
 * `validateRow` against the project's live vocabulary.
 */
export type ImportRowInput = Readonly<Partial<Record<(typeof IMPORT_ROW_KEYS)[number], unknown>>>;

export interface ImportRow {
  readonly title: string;
  readonly description: string | null;
  readonly statusId: StatusId | null;
  readonly assigneeIds: readonly UserId[];
  readonly labelIds: readonly LabelId[];
  readonly dueDate: Date | null;
  readonly priority: Priority | null;
  /** Resolved from the row's own `list` column, or the import's fallback list. */
  readonly listId: ListId;
  /** Resolved from the row's `sprint` column; null is the backlog. */
  readonly sprintId: SprintId | null;
}

export interface ImportError {
  readonly line: number;
  readonly error: string;
}

export interface ImportResult {
  readonly created: number;
  readonly errors: readonly ImportError[];
  /**
   * Label names the file uses that the project does not have.
   *
   * On a dry run this is what WOULD be created; on a real run with
   * `createMissingLabels` it is what WAS created. Reported either way so the
   * preview can say "will create 4 new labels" rather than leaving a person to
   * infer it from 80 identical row errors.
   */
  readonly missingLabels: readonly string[];
  /**
   * Where the cards landed, per list, largest first.
   *
   * Rows route by their own `list` column, so "imported 150 cards" no longer
   * says where any of them are — and the board behind the dialog may not even
   * be showing the list most of them went to. This is the answer to the first
   * question anyone asks after an import.
   *
   * Empty on a dry run: nothing was placed anywhere.
   */
  readonly createdByList: readonly {
    readonly listId: string;
    readonly name: string;
    readonly count: number;
  }[];
}

/**
 * The colours new labels cycle through.
 *
 * A label needs one and a CSV does not carry it. Cycling a fixed palette by
 * position keeps a bulk import from producing eighty identical grey chips,
 * and keeps the choice deterministic — the same file imported twice produces
 * the same colours, which matters when someone re-runs an import after fixing
 * a different column.
 */
const IMPORT_LABEL_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#64748b',
] as const;

const MAX_IMPORT_ROWS = 1_000;
/** A title's bound is the route's own `Title`; the description is plain text
    becoming ONE paragraph, so the node budget is irrelevant — this text bound
    is the whole limit. */
const MAX_IMPORT_DESCRIPTION = 10_000;
const MAX_IMPORT_LIST = 50;

export async function importCards(
  actor: WorkActor,
  input: {
    readonly listId: ListId;
    readonly rows: readonly ImportRowInput[];
    readonly dryRun: boolean;
    /**
     * Create labels the file names that the project does not have.
     *
     * Off by default, and that default is the point: a typo'd column would
     * otherwise mint junk labels on a shared project, and a label is
     * vocabulary every card in the project can then be tagged with. Opting in
     * grants nothing extra — managing the label set IS `project:update`, which
     * this route already requires — it just makes the side effect a choice.
     *
     * Statuses are deliberately NOT creatable the same way. A status carries a
     * CATEGORY (`not_started` / `active` / `done`) that decides whether a card
     * counts as finished — for the board, for sprint closure, for Phase 11's
     * burndown — and that cannot be inferred from a name. Guessing it would
     * quietly mis-classify work.
     */
    readonly createMissingLabels?: boolean;
  },
): Promise<ImportResult> {
  /* The bound lives here as well as on the route: it is the property that
     "an import cannot be a 50 MB batch" is, and it must survive a caller
     that is not a tRPC route. */
  if (input.rows.length < 1 || input.rows.length > MAX_IMPORT_ROWS) {
    throw errors.validation(
      { rows: `An import holds between 1 and ${String(MAX_IMPORT_ROWS)} cards.` },
      'That batch is the wrong size.',
    );
  }

  const vocab = await withOrgScope(orgOf(actor), async (tx) => {
    const list = await loadList(tx, input.listId);

    /* The bulk-write gate from §7.7 — project:update, not card:create, and
       the same for a dry-run as for the real thing: the capability to import
       is the capability to reshape the project, whether or not this call
       writes. `list.projectId` comes off the row un-branded. */
    await requireProject(tx, actor, list.projectId as ProjectId, 'project:update');

    const statusRows = await tx
      .select({ id: schema.statuses.id, name: schema.statuses.name })
      .from(schema.statuses)
      .where(eq(schema.statuses.projectId, list.projectId));

    const labelRows = await tx
      .select({ id: schema.labels.id, name: schema.labels.name })
      .from(schema.labels)
      .where(eq(schema.labels.projectId, list.projectId));

    const memberRows = await tx
      .select({ userId: schema.memberships.userId, email: schema.users.emailNormalized })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.status, 'active'));

    /* The lists a row's own `list` column can name, scoped to the BOARD the
       chosen list belongs to — not the project, which may have several boards
       with a "Todo" each. An import targets one board; the fallback list picks
       it, and the file's list names resolve within it. */
    const listRows = await tx
      .select({ id: schema.lists.id, name: schema.lists.name })
      .from(schema.lists)
      .where(and(eq(schema.lists.boardId, list.boardId), isNull(schema.lists.deletedAt)));

    /* Sprints are PROJECT-scoped, unlike lists (0054: a sprint is vocabulary
       beside statuses and labels), so this is a project-wide read rather than
       a board-wide one. The status comes along because a CLOSED sprint cannot
       take new cards — `assignSprint` refuses it, and finding that out one
       row at a time would half-import the batch. */
    const sprintRows = await tx
      .select({
        id: schema.sprints.id,
        name: schema.sprints.name,
        status: schema.sprints.status,
      })
      .from(schema.sprints)
      .where(eq(schema.sprints.projectId, list.projectId));

    return {
      listId: input.listId,
      projectId: list.projectId as ProjectId,
      statuses: new NameLookup(statusRows),
      labels: new NameLookup(labelRows),
      lists: new NameLookup(listRows),
      /* id -> name, for reporting WHERE the cards went. `lists` above is the
         other direction and cannot answer it. */
      listNames: new Map(listRows.map((row) => [row.id, row.name])),
      /* Only OPEN sprints are resolvable. A name matching a completed one is
         reported as a row error rather than silently dropped: the card was in
         that sprint in the source, and quietly landing it in the backlog would
         lose the association with no line number to notice it by. */
      sprints: new NameLookup(
        sprintRows.filter((row) => row.status === 'planned' || row.status === 'active'),
      ),
      closedSprintNames: new Set(
        sprintRows
          .filter((row) => row.status !== 'planned' && row.status !== 'active')
          .map((row) => row.name.toLowerCase()),
      ),
      members: new Map(memberRows.map((row) => [row.email.toLowerCase(), row.userId as UserId])),
    };
  });

  /* Which label names the file uses that the project does not have.
     Scanned BEFORE any row is validated, so the answer is about the whole file
     — a per-row discovery would report the same missing label once per row,
     which is exactly the 80-identical-errors wall this replaces. Order is
     first-appearance, so the list reads like the file. */
  const missingLabels: string[] = [];
  const seenMissing = new Set<string>();
  for (const raw of input.rows) {
    const names = splitList(raw.labels);
    if (names === null) continue;
    for (const name of names) {
      const clean = unneutralize(name);
      if (vocab.labels.resolve(clean) !== undefined) continue;
      const key = clean.toLowerCase();
      if (seenMissing.has(key)) continue;
      seenMissing.add(key);
      missingLabels.push(clean);
    }
  }

  const creating = input.createMissingLabels === true;

  /* Created for real only on a real run. A dry run reports what it WOULD
     create and writes nothing — the same promise the rest of the preview
     makes, and it would be a strange exception for the one side effect that
     outlives the import. */
  if (creating && !input.dryRun && missingLabels.length > 0) {
    for (const [index, name] of missingLabels.entries()) {
      const color = IMPORT_LABEL_COLORS[index % IMPORT_LABEL_COLORS.length] ?? '#64748b';
      /* Through the real service, like every other write here: same
         `project:update` check, same event, same audit entry. */
      const label = await labels.createLabel(actor, { projectId: vocab.projectId, name, color });
      vocab.labels.add(name, label.labelId);
    }
  }

  /* On a DRY RUN with the option on, the labels do not exist yet — so
     validation is told to accept them, or the preview would show the very
     errors the option exists to remove and no way to tell it worked. */
  const tolerateMissingLabels = creating && input.dryRun;

  const rowErrors: ImportError[] = [];
  /** listId -> how many cards this import put there. */
  const placed = new Map<string, number>();
  let created = 0;

  for (let index = 0; index < input.rows.length; index += 1) {
    const raw = input.rows[index];
    if (raw === undefined) continue;
    const line = index + 1;

    const validated = validateRow(raw, vocab, tolerateMissingLabels);
    if (!validated.ok) {
      rowErrors.push({ line, error: validated.error });
      continue;
    }

    if (input.dryRun) continue;

    let cardId: CardId | null = null;
    try {
      cardId = await writeRow(actor, validated.row);
      created += 1;
      placed.set(validated.row.listId, (placed.get(validated.row.listId) ?? 0) + 1);
    } catch (error) {
      /* The one failure that survives validation is a constraint race (the
         list archived mid-import, a status deleted between the vocabulary
         read and this row's write). Because each write goes through the
         real services — each owning its own transaction — the card can
         already EXIST when a later setter fails, and "atomic per row"
         (§7.7) means that partial card must not stay live. Best-effort
         archive it: archiving needs `card:delete`, and a restrictive board
         tuple could have taken even that, but the row error is reported
         either way. */
      if (cardId !== null) {
        await cards.archiveCard(actor, { cardId, archived: true }).catch(() => undefined);
      }
      rowErrors.push({
        line,
        error: error instanceof Error ? error.message : 'Failed to create this card.',
      });
    }
  }

  /* Largest first: the useful reading of "where did they go" is the biggest
     destination, not whichever list happens to sort first by name or id. */
  const createdByList = [...placed.entries()]
    .map(([listId, count]) => ({
      listId,
      name: vocab.listNames.get(listId) ?? 'Unknown list',
      count,
    }))
    .sort((a, b) => b.count - a.count);

  return { created, errors: rowErrors, missingLabels, createdByList };
}

/**
 * A name→id lookup with exact-first matching and a case-insensitive fallback
 * that refuses to guess when the fold would be ambiguous (a project with both
 * "Todo" and "TODO" resolves only the exact spellings — inventing an answer
 * would import a card against a label nobody meant).
 */
class NameLookup {
  private readonly byExact: Map<string, string>;
  private readonly byLower: Map<string, string>;

  constructor(entries: readonly { readonly id: string; readonly name: string }[]) {
    this.byExact = new Map();
    this.byLower = new Map();
    const ambiguous = new Set<string>();
    const seen = new Map<string, string>();

    for (const entry of entries) {
      this.byExact.set(entry.name, entry.id);
      const lower = entry.name.toLowerCase();
      const prior = seen.get(lower);
      if (prior !== undefined && prior !== entry.id) {
        ambiguous.add(lower);
      } else {
        seen.set(lower, entry.id);
      }
    }

    for (const [lower, id] of seen) {
      if (!ambiguous.has(lower)) this.byLower.set(lower, id);
    }
  }

  resolve(name: string): string | undefined {
    return this.byExact.get(name) ?? this.byLower.get(name.toLowerCase());
  }

  /**
   * Records a name created during this import, so rows later in the same file
   * resolve it without a second database read.
   *
   * Only the labels pass uses this, and only for names it just created — the
   * lookup is otherwise a snapshot of the project taken once, which is what
   * makes every row in a batch see the same vocabulary.
   */
  add(name: string, id: string): void {
    this.byExact.set(name, id);
    this.byLower.set(name.toLowerCase(), id);
  }
}

interface ResolvedVocabulary {
  /** The import's fallback list — where a row with no resolvable `list` lands. */
  readonly listId: ListId;
  /** The project the fallback list belongs to — where new labels are created. */
  readonly projectId: ProjectId;
  readonly statuses: NameLookup;
  readonly labels: NameLookup;
  /** The lists of the fallback list's BOARD, by name. */
  readonly lists: NameLookup;
  /** The same lists, id -> name, for the post-import breakdown. */
  readonly listNames: Map<string, string>;
  /** The project's PLANNED and ACTIVE sprints, by name. */
  readonly sprints: NameLookup;
  /** Lower-cased names of closed sprints, so naming one is a clear error. */
  readonly closedSprintNames: Set<string>;
  readonly members: Map<string, UserId>;
}

function validateRow(
  input: ImportRowInput,
  vocab: ResolvedVocabulary,
  tolerateMissingLabels = false,
): { readonly ok: true; readonly row: ImportRow } | { readonly ok: false; readonly error: string } {
  const fail = (error: string): { readonly ok: false; readonly error: string } => ({
    ok: false,
    error,
  });

  if (input.title === undefined) return fail('"title" is required.');
  if (typeof input.title !== 'string') return fail('"title" must be text.');
  const title = unneutralize(input.title.trim());
  if (title.length === 0) return fail('"title" is required.');
  if (title.length > 500) return fail('"title" must be 500 characters or fewer.');

  let description: string | null = null;
  if (input.description !== undefined) {
    if (typeof input.description !== 'string') return fail('"description" must be text.');
    const trimmed = unneutralize(input.description.trim());
    if (trimmed.length > MAX_IMPORT_DESCRIPTION) {
      return fail(`"description" must be ${String(MAX_IMPORT_DESCRIPTION)} characters or fewer.`);
    }
    description = trimmed.length === 0 ? null : trimmed;
  }

  let statusId: StatusId | null = null;
  if (input.status !== undefined && input.status !== '') {
    if (typeof input.status !== 'string') return fail('"status" must be text.');
    const resolved = vocab.statuses.resolve(unneutralize(input.status));
    if (resolved === undefined) return fail(`Unknown status "${input.status}".`);
    statusId = resolved as StatusId;
  }

  let assigneeIds: readonly UserId[] = [];
  const assigneeEmails = splitList(input.assignees);
  if (assigneeEmails === null) return fail('"assignees" must be text or a list of emails.');
  const unknownAssignee = assigneeEmails.find((email) => !vocab.members.has(email.toLowerCase()));
  if (unknownAssignee !== undefined) return fail(`Unknown assignee "${unknownAssignee}".`);
  /* Every email is present (the find above proved it); the narrowing filter
     is how that is written without a non-null assertion, which this codebase
     bans — the branch is dead either way. */
  assigneeIds = assigneeEmails
    .map((email) => vocab.members.get(email.toLowerCase()))
    .filter((userId): userId is UserId => userId !== undefined);

  let labelIds: readonly LabelId[] = [];
  const labelNames = splitList(input.labels);
  if (labelNames === null) return fail('"labels" must be text or a list of names.');
  /* The same bound the UI's own `labels.setOnCard` route enforces — an
     import must not create a card a user could not have created. */
  if (labelNames.length > MAX_IMPORT_LIST) {
    return fail(`A card can carry at most ${String(MAX_IMPORT_LIST)} labels.`);
  }
  const resolvedLabels: LabelId[] = [];
  for (const name of labelNames) {
    const resolved = vocab.labels.resolve(unneutralize(name));
    if (resolved === undefined) {
      /* On a dry run with "create missing labels" on, the label genuinely
         does not exist yet — the creation happens on the real run. Reporting
         it as an error here would show the preview the exact wall the option
         exists to remove, with no way to tell that turning it on worked. The
         name is already in `missingLabels`, which is what the preview shows
         instead. */
      if (tolerateMissingLabels) continue;
      return fail(`Unknown label "${name}".`);
    }
    resolvedLabels.push(resolved as LabelId);
  }
  labelIds = resolvedLabels;

  let dueDate: Date | null = null;
  if (input.dueDate !== undefined && input.dueDate !== '') {
    if (typeof input.dueDate !== 'string') return fail('"dueDate" must be a date.');
    /* `new Date('5')` is year 5 — a shape check first, then the parse. */
    if (!/^\d{4}-\d{2}-\d{2}/.test(input.dueDate))
      return fail(`Invalid dueDate "${input.dueDate}".`);
    const parsed = new Date(input.dueDate);
    if (Number.isNaN(parsed.getTime())) return fail(`Invalid dueDate "${input.dueDate}".`);
    dueDate = parsed;
  }

  /* Validated against the contract's own enum rather than a local copy, so a
     new priority cannot be addable to cards and silently unimportable. Blank
     means "not set" — an exported card with no priority round-trips to a card
     with no priority, rather than failing the row. */
  let priority: Priority | null = null;
  if (input.priority !== undefined && input.priority !== '') {
    if (typeof input.priority !== 'string') return fail('"priority" must be text.');
    const parsed = Priority.safeParse(unneutralize(input.priority).toLowerCase());
    if (!parsed.success) {
      return fail(`Unknown priority "${input.priority}". Use urgent, high, normal or low.`);
    }
    priority = parsed.data;
  }

  /* WHERE the card lands (10.6-era fix to §7.7).
     The export writes a `list` column for every card, and the import used to
     discard it — so exporting a whole board and importing it piled all 150
     cards into whichever single list was chosen, losing the board's shape and
     making the round trip useless for its most obvious purpose.

     An unresolvable name FALLS BACK to the chosen list rather than failing the
     row. The list is a placement, not a fact about the card: a card in the
     wrong column is visible and draggable, while a refused row is work that
     silently did not arrive. That trade goes the other way for labels and
     statuses, which are vocabulary — inventing one would put a card in a state
     the project does not have. */
  let listId = vocab.listId;
  if (typeof input.list === 'string' && input.list.trim() !== '') {
    const resolved = vocab.lists.resolve(unneutralize(input.list));
    if (resolved !== undefined) listId = resolved as ListId;
  }

  /* The sprint, resolved by name among the project's OPEN sprints.
     Three outcomes, and the middle one is the reason this is not modelled on
     `list`:
       - blank or unmatched → the backlog. Sprints are project-scoped, so a
         file exported from another project names sprints that cannot exist
         here; erroring would refuse every row of a cross-project import.
       - a CLOSED sprint → a row error. The card was in that sprint at the
         source and `assignSprint` would refuse it anyway; landing it in the
         backlog instead would lose the association with nothing to notice it
         by.
       - an open sprint → assigned. */
  let sprintId: SprintId | null = null;
  if (typeof input.sprint === 'string' && input.sprint.trim() !== '') {
    const name = unneutralize(input.sprint.trim());
    const resolved = vocab.sprints.resolve(name);
    if (resolved !== undefined) {
      sprintId = resolved as SprintId;
    } else if (vocab.closedSprintNames.has(name.toLowerCase())) {
      return fail(`Sprint "${name}" is closed and cannot take new cards.`);
    }
  }

  return {
    ok: true,
    row: {
      title,
      description,
      statusId,
      assigneeIds,
      labelIds,
      dueDate,
      priority,
      listId,
      sprintId,
    },
  };
}

/** Accepts "a; b" or ["a", "b"], never a non-string member. */
function splitList(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (typeof value === 'string') {
    return value
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (Array.isArray(value)) {
    if (value.some((entry) => typeof entry !== 'string')) return null;
    return (value as readonly string[])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return null;
}

/**
 * One row's writes, through the exact services the UI's create uses.
 *
 * Returns the created card's id so the caller can compensate (archive) the
 * card when a LATER setter in the same row fails — see the loop in
 * `importCards`. The row is validated first, so reaching a setter means the
 * status, labels and assignees all resolved moments ago; the failures here
 * are races, not mistakes.
 */
async function writeRow(actor: WorkActor, row: ImportRow): Promise<CardId> {
  const description: RichTextNode | null =
    row.description === null ? null : plainParagraph(row.description);

  const { cardId } = await cards.createCard(actor, {
    listId: row.listId,
    title: row.title,
    description,
  });

  if (row.statusId !== null) {
    await cards.setCardStatus(actor, { cardId, statusId: row.statusId });
  }
  if (row.assigneeIds.length > 0) {
    await cards.assignCard(actor, { cardId, assigneeIds: row.assigneeIds });
  }
  if (row.labelIds.length > 0) {
    await labels.setCardLabels(actor, { cardId, labelIds: row.labelIds });
  }
  if (row.sprintId !== null) {
    /* Through the real membership service, like every other field here — so
       an import cannot put a card in a sprint a user could not have put it
       in, and `card.sprint_changed` fires for each one. */
    await sprints.assignSprint(actor, { cardId, sprintId: row.sprintId });
  }
  if (row.dueDate !== null || row.priority !== null) {
    /* `updateCard` carries the only write path for a due date AND a priority,
       and it needs the card's version — read through the real service, not a
       raw row. Both are passed together because this route is a full replace
       (the `useUpdateCard` trap, server-side): sending one and defaulting the
       other to null would clear whichever the row did not mention. */
    const detail = await cards.getCard(actor, { cardId });
    await cards.updateCard(actor, {
      cardId,
      version: detail.version,
      title: row.title,
      description,
      dueDate: row.dueDate,
      startDate: null,
      priority: row.priority,
    });
  }

  return cardId;
}

/* Re-exported so the route and tests share the exact bound the batch enforces. */
export { MAX_IMPORT_ROWS };
