import { describe, expect, it } from 'vitest';
import {
  EMPTY_BOARD_FILTER,
  boardFilterKey,
  buildBoardFilter,
  isBoardFilterEmpty,
  toggleAssignee,
  toggleLabel,
  type BoardFilterSelection,
} from './board-filter.js';

describe('isBoardFilterEmpty', () => {
  it('is true for the empty selection', () => {
    expect(isBoardFilterEmpty(EMPTY_BOARD_FILTER)).toBe(true);
  });

  it('is false once any field is set', () => {
    expect(isBoardFilterEmpty({ ...EMPTY_BOARD_FILTER, statusId: 'status_1' })).toBe(false);
    expect(isBoardFilterEmpty({ ...EMPTY_BOARD_FILTER, priority: 'urgent' })).toBe(false);
    expect(isBoardFilterEmpty({ ...EMPTY_BOARD_FILTER, assigneeIds: ['u1'] })).toBe(false);
    expect(isBoardFilterEmpty({ ...EMPTY_BOARD_FILTER, labelIds: ['l1'] })).toBe(false);
  });
});

describe('buildBoardFilter', () => {
  it('returns null for an empty selection — the server’s own default, not an empty group', () => {
    expect(buildBoardFilter(EMPTY_BOARD_FILTER)).toBeNull();
  });

  it('builds a single comparison wrapped in a one-child group', () => {
    const selection: BoardFilterSelection = { ...EMPTY_BOARD_FILTER, statusId: 'status_1' };
    expect(buildBoardFilter(selection)).toEqual({
      kind: 'group',
      combinator: 'and',
      children: [{ kind: 'comparison', field: 'status', operator: 'eq', value: 'status_1' }],
    });
  });

  it('ANDs every populated field', () => {
    const selection: BoardFilterSelection = {
      statusId: 'status_1',
      priority: 'urgent',
      assigneeIds: ['u1', 'u2'],
      labelIds: ['l1'],
    };
    expect(buildBoardFilter(selection)).toEqual({
      kind: 'group',
      combinator: 'and',
      children: [
        { kind: 'comparison', field: 'status', operator: 'eq', value: 'status_1' },
        { kind: 'comparison', field: 'priority', operator: 'eq', value: 'urgent' },
        { kind: 'comparison', field: 'assignee', operator: 'in', value: ['u1', 'u2'] },
        { kind: 'comparison', field: 'label', operator: 'in', value: ['l1'] },
      ],
    });
  });
});

describe('boardFilterKey', () => {
  it('is "all" for no filter', () => {
    expect(boardFilterKey(null)).toBe('all');
  });

  it('is a stable JSON string for a real filter, matching web’s own filterKey', () => {
    const filter = buildBoardFilter({ ...EMPTY_BOARD_FILTER, priority: 'high' });
    expect(boardFilterKey(filter)).toBe(JSON.stringify(filter));
  });
});

describe('toggleAssignee / toggleLabel', () => {
  it('adds an id not yet selected', () => {
    expect(toggleAssignee(EMPTY_BOARD_FILTER, 'u1').assigneeIds).toEqual(['u1']);
  });

  it('removes an id already selected', () => {
    const selection = toggleAssignee(EMPTY_BOARD_FILTER, 'u1');
    expect(toggleAssignee(selection, 'u1').assigneeIds).toEqual([]);
  });

  it('keeps other fields untouched', () => {
    const selection: BoardFilterSelection = { ...EMPTY_BOARD_FILTER, priority: 'low' };
    expect(toggleLabel(selection, 'l1')).toEqual({
      ...EMPTY_BOARD_FILTER,
      priority: 'low',
      labelIds: ['l1'],
    });
  });
});
