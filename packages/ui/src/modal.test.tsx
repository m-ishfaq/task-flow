import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ModalClose, ModalContent, ModalRoot, ModalTitle, ModalTrigger } from './modal.js';

/**
 * The behaviour worth asserting is focus RETURN — the property Wave 1's
 * duplication census flagged as the one place the seven hand-rolled dialogs
 * could plausibly have disagreed (`ai/phase-6.5-ui-polish.md` §4). Radix
 * provides it by default; this proves the wrapper here doesn't accidentally
 * defeat it (e.g. by rendering the trigger inside the portal, or by taking
 * over `onOpenChange` in a way that skips Radix's own unmount timing).
 */
function TestModal() {
  const [open, setOpen] = useState(false);
  return (
    <ModalRoot open={open} onOpenChange={setOpen}>
      <ModalTrigger asChild>
        <button type="button">Open</button>
      </ModalTrigger>
      <ModalContent size="sm">
        <ModalTitle>Test dialog</ModalTitle>
        <ModalClose asChild>
          <button type="button">Close</button>
        </ModalClose>
      </ModalContent>
    </ModalRoot>
  );
}

describe('ModalRoot/ModalContent', () => {
  it('opens on trigger click and renders the title', async () => {
    const user = userEvent.setup();
    render(<TestModal />);

    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByRole('dialog', { name: 'Test dialog' })).toBeInTheDocument();
  });

  it('returns focus to the trigger after closing', async () => {
    const user = userEvent.setup();
    render(<TestModal />);

    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<TestModal />);

    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
