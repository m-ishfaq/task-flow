/**
 * Client-side CSV parsing for imports (ai/phase-10-automation.md §7.7).
 *
 * Hand-rolled because the repo carries no CSV dependency — the export side is
 * the server's RFC 4180 writer (`import-export.service.ts`), and this is the
 * matching reader, so a file this app exports round-trips through it. It
 * handles the standard the writer emits: quoted fields, doubled quotes, commas
 * and newlines inside quotes, CRLF or LF row endings.
 *
 * It is deliberately lenient in one place: a bare `"` inside an UNQUOTED field
 * is kept as data (Excel sometimes emits `12" ruler`), and a row ending in a
 * newline does not produce a trailing empty row. Everything else follows the
 * letter of the format — this parser's output feeds the server's validator,
 * which is the strict half of the pair.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  while (index < text.length) {
    const ch = text[index] ?? '';

    if (inQuotes) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          /* A doubled quote inside a quoted field is one literal quote. */
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += ch;
      index += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
      continue;
    }
    if (ch === '\r') {
      /* CRLF row ending — the CR is dropped, the LF above ends the row. A
         lone CR inside a QUOTED field is preserved, because there it is
         data, not an ending. */
      index += 1;
      continue;
    }
    field += ch;
    index += 1;
  }

  /* The last row, unless the text ended with a newline (in which case the
     loop already pushed it and nothing is left). */
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** The columns an import row may name, and how a cell maps to each. */
export const IMPORT_COLUMNS = [
  'title',
  'description',
  'status',
  'assignees',
  'labels',
  'dueDate',
  /* `priority` is a real card field the export writes and the server applies,
     so it must be READ here or a CSV round trip silently drops it — the export
     says `high`, the re-imported card says nothing, and no error is reported
     anywhere because the column was simply never sent.

     `reference` stays out — it names an EXISTING card and import only ever
     creates, so shipping it would send a value nothing reads. */
  'priority',
  /* `list` ROUTES the row. The export writes one per card, and the server
     places each card in the named list of the target board, falling back to
     the chosen list when the name matches nothing. Without this column an
     exported board's whole shape collapses into a single column on import,
     which is what made the round trip useless for its most obvious purpose. */
  'list',
  /* `sprint` names the sprint by NAME, like `status` and `list` do. Blank is
     the backlog, which is what `sprint_id IS NULL` means (0054). */
  'sprint',
] as const;

export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

/**
 * Header spellings that map onto each import column.
 *
 * A file exported from THIS app matches on the column's own name, and that is
 * the case the round trip cares about. These aliases are for the other reason
 * anyone imports a CSV: a file from Jira, Trello, Asana or a spreadsheet
 * somebody maintains by hand, where the same field is called `Summary`,
 * `State`, or `Components`.
 *
 * Detection is a STARTING POINT, never the answer — every guess is shown in
 * the mapping step and can be overridden. That is why a wrong alias here is a
 * mild annoyance rather than silent data loss: the person sees `Summary →
 * title` before anything is sent.
 *
 * Compared in normalised form (see `normaliseHeader`), so `Due Date`,
 * `due_date` and `DUEDATE` are one entry.
 */
const COLUMN_ALIASES: Readonly<Record<ImportColumn, readonly string[]>> = {
  title: ['title', 'summary', 'name', 'card', 'task', 'issue'],
  description: ['description', 'details', 'body', 'notes'],
  status: ['status', 'state'],
  list: ['list', 'column', 'stage', 'bucket'],
  sprint: ['sprint', 'iteration', 'cycle', 'milestone'],
  assignees: ['assignees', 'assignee', 'owner', 'assignedto', 'responsible'],
  labels: ['labels', 'label', 'tags', 'tag', 'components'],
  priority: ['priority', 'importance'],
  dueDate: ['duedate', 'due', 'dueon', 'deadline', 'targetdate'],
};

/**
 * Lower-cases and strips everything that is not a letter or digit.
 *
 * `Due Date`, `due_date`, `Due-Date` and `DUEDATE` are the same header as far
 * as a person is concerned, and a mapping step that made someone fix that by
 * hand would be doing the opposite of its job.
 */
function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '');
}

/**
 * Guesses which of the file's headers feeds each import column.
 *
 * Returns the header's ORIGINAL spelling (or null), because that is what the
 * mapping UI shows and what indexes back into the parsed table. A header is
 * claimed by at most one column — first match in `IMPORT_COLUMNS` order wins,
 * so a file with both `Labels` and `Tags` maps `Labels` and leaves `Tags`
 * unmapped rather than silently merging them.
 */
export function detectMapping(
  headers: readonly string[],
): Readonly<Record<ImportColumn, string | null>> {
  const normalised = headers.map((header) => normaliseHeader(header));
  const claimed = new Set<number>();
  const mapping = {} as Record<ImportColumn, string | null>;

  for (const column of IMPORT_COLUMNS) {
    const aliases = COLUMN_ALIASES[column];
    let found: string | null = null;

    for (const alias of aliases) {
      const index = normalised.findIndex(
        (header, position) => header === alias && !claimed.has(position),
      );
      if (index >= 0) {
        claimed.add(index);
        found = headers[index] ?? null;
        break;
      }
    }

    mapping[column] = found;
  }

  return mapping;
}

/**
 * Turns a parsed table plus a mapping into the rows the API accepts.
 *
 * The mapping is the ONLY thing that decides which cell feeds which field, so
 * a file whose headers match nothing still imports once a person points the
 * columns at each other. Empty cells are omitted rather than sent as empty
 * strings — the server treats a missing key as "not supplied", which is what
 * a blank cell means.
 */
export function rowsFromTable(
  table: { readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] },
  mapping: Readonly<Record<ImportColumn, string | null>>,
): Record<string, unknown>[] {
  const indexOf = new Map(table.headers.map((header, index) => [header, index]));

  const built: Record<string, unknown>[] = [];
  for (const cells of table.rows) {
    const row: Record<string, unknown> = {};

    for (const column of IMPORT_COLUMNS) {
      const header = mapping[column];
      if (header === null) continue;
      const index = indexOf.get(header);
      if (index === undefined) continue;

      const value = (cells[index] ?? '').trim();
      if (value === '') continue;

      if (column === 'assignees' || column === 'labels') {
        const split = splitCell(value);
        if (split.length > 0) row[column] = split;
      } else {
        row[column] = value;
      }
    }

    /* A fully empty line (a trailing blank row) contributes nothing. */
    if (Object.keys(row).length > 0) built.push(row);
  }

  return built;
}

/** Splits an assignee/label cell on `;` or `,` — the two separators the
    server's own splitter accepts. */
export function splitCell(value: string): string[] {
  return value
    .split(/[;,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
