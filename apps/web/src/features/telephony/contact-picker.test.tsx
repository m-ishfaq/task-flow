import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../lib/query.js';

/**
 * The "To" combobox on Place a call (`contact-picker.tsx`).
 *
 * Three things here are only observable through the component, which is why
 * this exists rather than a unit test of the query:
 *
 *   - a member with NO work phone must not appear, and must not appear as a
 *     blank row either — the failure mode is a picker entry that dials '';
 *   - the directory pages, so a picker that read one page would silently omit
 *     everyone past the first hundred people, with nothing failing to say so;
 *   - a caller without `member:read` gets FORBIDDEN, and the field must still
 *     accept a typed number. The picker is a convenience over a control the
 *     server authorizes on its own, so its absence may not disable dialling.
 */

interface DirectoryRow {
  userId: string;
  email: string;
  displayName: string | null;
  workPhone: string | null;
}

interface DirectoryPage {
  members: DirectoryRow[];
  nextCursor: string | null;
}

const listDirectory =
  vi.fn<(input: { cursor?: string; limit: number }) => Promise<DirectoryPage>>();

vi.mock('../../lib/trpc.js', () => ({
  api: {
    people: {
      directory: {
        list: { query: (input: { cursor?: string; limit: number }) => listDirectory(input) },
      },
    },
  },
  apiErrorOf: () => null,
  errorCodeOf: () => null,
  isUnauthenticated: () => false,
}));

const { ContactPicker } = await import('./contact-picker.js');

const ORG_ID = '019faee8-0000-7000-8000-0000000000f0';

/* Controlled by the caller in the real form, so the harness owns the state —
   asserting on the input's value is what proves a pick actually reaches it.
   The label is the caller's too (`Field` supplies it in `calls-panel.tsx`), so
   the harness renders one and the tests address the input the way a person
   does. */
function Harness({ initial = '' }: { readonly initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <QueryClientProvider client={createQueryClient()}>
      <label htmlFor="call-to">To</label>
      <ContactPicker id="call-to" orgId={ORG_ID} value={value} onChange={setValue} />
    </QueryClientProvider>
  );
}

function member(index: number, workPhone: string | null, displayName: string | null): DirectoryRow {
  return {
    userId: `019faee8-0000-7000-8000-00000000000${String(index)}`,
    email: `person${String(index)}@example.com`,
    displayName,
    workPhone,
  };
}

beforeEach(() => {
  listDirectory.mockReset();
});

describe('the people list', () => {
  it('offers only members who have a work phone', async () => {
    const user = userEvent.setup();
    listDirectory.mockResolvedValue({
      members: [
        member(1, '+14155550100', 'Ada Lovelace'),
        member(2, null, 'Grace Hopper'),
        member(3, '', 'Alan Turing'),
      ],
      nextCursor: null,
    });

    render(<Harness />);

    await user.click(await screen.findByRole('button', { name: 'Choose a person' }));

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
    expect(screen.queryByText('Alan Turing')).not.toBeInTheDocument();
  });

  it('walks the directory cursor rather than reading only the first page', async () => {
    const user = userEvent.setup();
    listDirectory.mockImplementation((input) =>
      Promise.resolve(
        input.cursor === undefined
          ? { members: [member(1, '+14155550100', 'Ada Lovelace')], nextCursor: 'cursor-1' }
          : { members: [member(2, '+14155550101', 'Grace Hopper')], nextCursor: null },
      ),
    );

    render(<Harness />);

    await user.click(await screen.findByRole('button', { name: 'Choose a person' }));

    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    });
    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(listDirectory).toHaveBeenLastCalledWith({ cursor: 'cursor-1', limit: 100 });
  });

  it('is hidden entirely when nobody in the org has a work phone', async () => {
    listDirectory.mockResolvedValue({
      members: [member(1, null, 'Ada Lovelace')],
      nextCursor: null,
    });

    render(<Harness />);

    await waitFor(() => {
      expect(listDirectory).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: 'Choose a person' })).not.toBeInTheDocument();
  });
});

describe('picking and typing', () => {
  it("fills the field with the chosen person's number", async () => {
    const user = userEvent.setup();
    listDirectory.mockResolvedValue({
      members: [member(1, '+14155550100', 'Ada Lovelace')],
      nextCursor: null,
    });

    render(<Harness />);

    await user.click(await screen.findByRole('button', { name: 'Choose a person' }));
    await user.click(screen.getByText('Ada Lovelace'));

    expect(screen.getByLabelText<HTMLInputElement>('To').value).toBe('+14155550100');
  });

  it('names the person a typed number belongs to, ignoring formatting', async () => {
    const user = userEvent.setup();
    listDirectory.mockResolvedValue({
      members: [member(1, '+14155550100', 'Ada Lovelace')],
      nextCursor: null,
    });

    render(<Harness />);
    await waitFor(() => {
      expect(listDirectory).toHaveBeenCalled();
    });

    await user.type(screen.getByLabelText('To'), '+1 (415) 555-0100');

    await waitFor(() => {
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    });
  });

  it('still takes a custom number when the directory refuses the caller', async () => {
    const user = userEvent.setup();
    /* What `member:read` denial looks like from here. `query.ts` classifies
       FORBIDDEN as terminal, and `phoneContactsQuery` sets `retry: false`, so
       this is one refused request and not a retry loop. */
    listDirectory.mockRejectedValue(Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' }));

    render(<Harness />);

    await waitFor(() => {
      expect(listDirectory).toHaveBeenCalled();
    });

    const input = screen.getByLabelText<HTMLInputElement>('To');
    await user.type(input, '+14155550199');

    expect(input.value).toBe('+14155550199');
    expect(screen.queryByRole('button', { name: 'Choose a person' })).not.toBeInTheDocument();
  });
});
