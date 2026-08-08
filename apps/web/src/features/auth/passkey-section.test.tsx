import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../lib/query.js';
import type * as PasskeyModule from './passkey.js';

/**
 * Enrollment, listing, rename, and removal.
 *
 * The list route (`list`), enrollment (`startRegistration`/`finishRegistration`),
 * `rename`, and `remove` are all `selfRoute` server-side — see passkey-section.tsx's
 * own header for why this needs no `orgId` and therefore renders standalone,
 * without the rest of `SettingsPage`'s org machinery.
 *
 * `useStepUp` is stubbed rather than driven through the real `StepUpDialog`:
 * that dialog re-authenticates with a password and is exercised on its own
 * elsewhere. What matters here is narrower and specific to this section — that
 * a STEP_UP_REQUIRED failure on `remove` reaches `guard()` at all, so removing
 * a passkey gets the same re-authentication prompt member removal already
 * has, rather than silently failing or showing a raw error.
 */

/* `vi.hoisted` rather than plain `const`s. `../../lib/query.js` (imported
   below, for `createQueryClient`) imports `./trpc.js` itself, so its mock
   factory runs the moment that REAL import is evaluated — before this file
   reaches any of its own top-level statements, `vi.mock` calls included.
   A plain `const list = vi.fn()` referenced from the factory would still be
   in its temporal dead zone at that point; `vi.hoisted` is what guarantees
   these exist first. */
const { list, renameMutate, removeMutate, enrollPasskey, browserSupportsWebAuthn, guard } =
  vi.hoisted(() => ({
    list: vi.fn<() => Promise<unknown[]>>(),
    renameMutate: vi.fn<(input: unknown) => Promise<unknown>>(),
    removeMutate: vi.fn<(input: unknown) => Promise<unknown>>(),
    enrollPasskey: vi.fn<() => Promise<{ credentialId: string }>>(),
    browserSupportsWebAuthn: vi.fn<() => boolean>(() => true),
    guard: vi.fn<(error: unknown, retry: () => void) => boolean>(() => false),
  }));

vi.mock('../../lib/trpc.js', () => ({
  api: {
    auth: {
      passkeys: {
        list: { query: list },
        rename: { mutate: renameMutate },
        remove: { mutate: removeMutate },
      },
    },
  },
  apiErrorOf: () => null,
  errorCodeOf: () => null,
  isUnauthenticated: () => false,
}));

vi.mock('./passkey.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PasskeyModule>();
  return { ...actual, enrollPasskey, browserSupportsWebAuthn };
});

vi.mock('./use-step-up.js', () => ({
  useStepUp: () => ({ guard, dialog: null }),
}));

const { PasskeySection } = await import('./passkey-section.js');
const { PasskeyCeremonyError } = await import('./passkey.js');

function renderSection() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <PasskeySection />
    </QueryClientProvider>,
  );
}

const PASSKEY_A = {
  id: 'pk-1',
  name: 'Work laptop',
  deviceType: 'multiDevice',
  backedUp: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-02-01T00:00:00.000Z',
};

beforeEach(() => {
  list.mockReset();
  renameMutate.mockReset();
  removeMutate.mockReset();
  enrollPasskey.mockReset();
  browserSupportsWebAuthn.mockReturnValue(true);
  guard.mockReset();
  guard.mockReturnValue(false);
});

describe('the passkey list', () => {
  it('renders what the server returns', async () => {
    list.mockResolvedValue([PASSKEY_A]);
    renderSection();

    expect(await screen.findByText('Work laptop')).toBeInTheDocument();
    expect(screen.getByText(/syncs across devices/i)).toBeInTheDocument();
    expect(screen.getByText(/backed up/i)).toBeInTheDocument();
  });

  it('shows an empty state rather than nothing', async () => {
    list.mockResolvedValue([]);
    renderSection();

    expect(await screen.findByText(/no passkeys yet/i)).toBeInTheDocument();
  });

  it('names an unnamed passkey rather than leaving a blank row', async () => {
    list.mockResolvedValue([{ ...PASSKEY_A, name: null }]);
    renderSection();

    expect(await screen.findByText(/unnamed passkey/i)).toBeInTheDocument();
  });
});

describe('adding a passkey', () => {
  it('refreshes the list after a successful enrollment', async () => {
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([PASSKEY_A]);
    enrollPasskey.mockResolvedValue({ credentialId: 'cred-1' });
    renderSection();

    await screen.findByText(/no passkeys yet/i);
    await userEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => {
      expect(screen.getByText('Work laptop')).toBeInTheDocument();
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('shows nothing for a cancelled ceremony', async () => {
    list.mockResolvedValue([]);
    enrollPasskey.mockRejectedValue(new PasskeyCeremonyError('cancelled'));
    renderSection();

    await screen.findByText(/no passkeys yet/i);
    await userEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    await waitFor(() => {
      expect(enrollPasskey).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains a device that already holds a passkey for this account', async () => {
    list.mockResolvedValue([]);
    enrollPasskey.mockRejectedValue(new PasskeyCeremonyError('already_registered'));
    renderSection();

    await screen.findByText(/no passkeys yet/i);
    await userEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    expect(await screen.findByText(/already has a passkey/i)).toBeInTheDocument();
  });

  it('hides the add control on a browser without WebAuthn support', async () => {
    browserSupportsWebAuthn.mockReturnValue(false);
    list.mockResolvedValue([]);
    renderSection();

    await screen.findByText(/no passkeys yet/i);
    expect(screen.queryByRole('button', { name: /add a passkey/i })).not.toBeInTheDocument();
    expect(screen.getByText(/does not support passkeys/i)).toBeInTheDocument();
  });
});

describe('renaming a passkey', () => {
  it('saves the trimmed name and refreshes', async () => {
    list
      .mockResolvedValueOnce([PASSKEY_A])
      .mockResolvedValueOnce([{ ...PASSKEY_A, name: 'Yubikey' }]);
    renameMutate.mockResolvedValue({ status: 'renamed' });
    renderSection();

    await screen.findByText('Work laptop');
    await userEvent.click(screen.getByRole('button', { name: /rename/i }));

    const input = screen.getByDisplayValue('Work laptop');
    await userEvent.clear(input);
    await userEvent.type(input, '  Yubikey  ');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(renameMutate).toHaveBeenCalledWith({ id: 'pk-1', name: 'Yubikey' });
    });
    expect(await screen.findByText('Yubikey')).toBeInTheDocument();
  });
});

describe('removing a passkey', () => {
  it('confirms before removing', async () => {
    list.mockResolvedValue([PASSKEY_A]);
    renderSection();

    const row = (await screen.findByText('Work laptop')).closest('li');
    if (row === null) throw new Error('row not found');

    await userEvent.click(within(row).getByRole('button', { name: /^remove$/i }));
    expect(removeMutate).not.toHaveBeenCalled();

    await userEvent.click(within(row).getByRole('button', { name: /remove work laptop/i }));
    await waitFor(() => {
      expect(removeMutate).toHaveBeenCalledWith({ id: 'pk-1' });
    });
  });

  it("routes a STEP_UP_REQUIRED failure to the step-up guard, and the guard's retry re-issues the same removal", async () => {
    /* Whether the inline `ErrorText` also renders underneath is not asserted
       here — it does, exactly as it does in `MemberSection`/`TeamSection`
       today, and the `StepUpDialog`'s own modal overlay is what keeps it out
       of view while the dialog is open. What this test guards is the thing
       that would actually break sign-in: the retry `guard` is handed must
       call the SAME removal again once confirmed, not a stale or wrong id. */
    list.mockResolvedValue([PASSKEY_A]);
    const stepUpError = new Error('STEP_UP_REQUIRED');
    removeMutate.mockRejectedValueOnce(stepUpError).mockResolvedValue({ status: 'deleted' });
    guard.mockReturnValue(true);
    renderSection();

    const row = (await screen.findByText('Work laptop')).closest('li');
    if (row === null) throw new Error('row not found');

    await userEvent.click(within(row).getByRole('button', { name: /^remove$/i }));
    await userEvent.click(within(row).getByRole('button', { name: /remove work laptop/i }));

    await waitFor(() => {
      expect(guard).toHaveBeenCalledWith(stepUpError, expect.any(Function));
    });
    expect(removeMutate).toHaveBeenCalledTimes(1);

    // Simulate the dialog confirming: run the retry thunk `guard` was given.
    const retry = guard.mock.calls[0]?.[1] as () => void;
    retry();

    await waitFor(() => {
      expect(removeMutate).toHaveBeenCalledTimes(2);
    });
    expect(removeMutate).toHaveBeenNthCalledWith(2, { id: 'pk-1' });
  });

  it('shows an inline error for a failure the step-up guard does not claim', async () => {
    list.mockResolvedValue([PASSKEY_A]);
    // The service refuses to delete a passkey-only account's last credential
    // (passkey.service.ts) — a plain VALIDATION failure, not a step-up one.
    removeMutate.mockRejectedValue(new Error('This is the only way to sign in to this account.'));
    guard.mockReturnValue(false);
    renderSection();

    const row = (await screen.findByText('Work laptop')).closest('li');
    if (row === null) throw new Error('row not found');

    await userEvent.click(within(row).getByRole('button', { name: /^remove$/i }));
    await userEvent.click(within(row).getByRole('button', { name: /remove work laptop/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
