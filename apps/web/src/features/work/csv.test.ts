import { describe, expect, it } from 'vitest';
import { detectMapping, parseCsv, rowsFromTable, splitCell } from './csv.js';

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('does not add a trailing empty row for a final newline', () => {
    expect(parseCsv('a\n')).toEqual([['a']]);
    expect(parseCsv('a')).toEqual([['a']]);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('"Comma, in title",other\n')).toEqual([['Comma, in title', 'other']]);
  });

  it('un-doubles quotes inside quoted fields', () => {
    expect(parseCsv('"say ""hi""",x\n')).toEqual([['say "hi"', 'x']]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('"line one\nline two",x\n')).toEqual([['line one\nline two', 'x']]);
  });

  it('handles CRLF row endings', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps a lone CR inside a quoted field as data', () => {
    expect(parseCsv('"a\rb",x\n')).toEqual([['a\rb', 'x']]);
  });

  it("round-trips the server export writer's output", () => {
    const exported =
      'reference,title,description,status,list,assignees,labels,priority,dueDate\r\n' +
      'WEB-1,"Comma, in title","line one\nline two",Backlog,Todo,member@import.test,Bug,high,2026-09-01T00:00:00.000Z\r\n';
    const rows = parseCsv(exported);
    expect(rows[0]).toEqual([
      'reference',
      'title',
      'description',
      'status',
      'list',
      'assignees',
      'labels',
      'priority',
      'dueDate',
    ]);
    expect(rows[1]).toEqual([
      'WEB-1',
      'Comma, in title',
      'line one\nline two',
      'Backlog',
      'Todo',
      'member@import.test',
      'Bug',
      'high',
      '2026-09-01T00:00:00.000Z',
    ]);
  });

  it('keeps a bare quote inside an unquoted field as data', () => {
    expect(parseCsv('12" ruler,x\n')).toEqual([['12" ruler', 'x']]);
  });
});

describe('detectMapping', () => {
  it('matches this app’s own export exactly — the round trip', () => {
    const map = detectMapping([
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
    ]);
    expect(map.title).toBe('title');
    expect(map.status).toBe('status');
    expect(map.list).toBe('list');
    expect(map.sprint).toBe('sprint');
    expect(map.dueDate).toBe('dueDate');
  });

  it('matches a foreign export by alias, ignoring case and separators', () => {
    /* The reason the mapping step exists: a Jira/Trello-shaped file names the
       same fields differently, and nobody should have to rename columns in a
       spreadsheet before importing. */
    const map = detectMapping(['Summary', 'State', 'Assignee', 'Components', 'Due Date', 'Epic']);
    expect(map.title).toBe('Summary');
    expect(map.status).toBe('State');
    expect(map.assignees).toBe('Assignee');
    expect(map.labels).toBe('Components');
    expect(map.dueDate).toBe('Due Date');
    /* Nothing claims `Epic` — an unmatched header is simply not imported,
       rather than being guessed into a field it does not mean. */
    expect(map.priority).toBeNull();
  });

  it('gives a header to at most one column', () => {
    /* `Labels` and `Tags` are both aliases for `labels`. Claiming one and
       leaving the other alone is honest; merging them silently would import a
       card with tags nobody asked to combine. */
    const map = detectMapping(['Title', 'Labels', 'Tags']);
    expect(map.labels).toBe('Labels');
    expect(Object.values(map).filter((value) => value === 'Tags')).toEqual([]);
  });

  it('reports title as unmapped when nothing resembles one', () => {
    const map = detectMapping(['Foo', 'Bar']);
    expect(map.title).toBeNull();
  });
});

describe('rowsFromTable', () => {
  const table = {
    headers: ['Summary', 'State', 'Components', 'Nothing'],
    rows: [
      ['Fix the thing', 'In Progress', 'bug; ui', 'ignored'],
      ['  ', '', '', ''],
      ['Second', '', 'docs', 'ignored'],
    ],
  };

  it('builds rows through the mapping, not the header names', () => {
    const rows = rowsFromTable(table, detectMapping(table.headers));

    /* The blank line contributes nothing — a trailing empty row is not a card. */
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      title: 'Fix the thing',
      status: 'In Progress',
      labels: ['bug', 'ui'],
    });
    /* An empty cell is OMITTED, not sent as '' — the server reads a missing
       key as "not supplied", which is what a blank cell means. */
    expect(rows[1]).toEqual({ title: 'Second', labels: ['docs'] });
  });

  it('honours a hand-corrected mapping over the guess', () => {
    /* The whole point of letting someone override: `Nothing` is a column the
       detector never claims, and pointing `description` at it must work. */
    const guessed = detectMapping(table.headers);
    const rows = rowsFromTable(table, { ...guessed, description: 'Nothing' });
    expect(rows[0]?.['description']).toBe('ignored');
  });

  it('drops a column mapped to nothing', () => {
    const guessed = detectMapping(table.headers);
    const rows = rowsFromTable(table, { ...guessed, status: null });
    expect(rows[0]).not.toHaveProperty('status');
  });
});

describe('splitCell', () => {
  it('splits on semicolons and commas, trimming and dropping empties', () => {
    expect(splitCell('a@x.com; b@y.com,')).toEqual(['a@x.com', 'b@y.com']);
    expect(splitCell('')).toEqual([]);
  });
});
