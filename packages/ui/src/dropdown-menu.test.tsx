import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu.js';

function TestMenu({ onSelect }: { readonly onSelect: () => void }) {
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>
        <button type="button">Menu</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={onSelect}>Do the thing</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem tone="muted">Muted item</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

describe('DropdownMenuRoot/DropdownMenuContent', () => {
  it('opens on trigger click and fires onSelect for the clicked item', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<TestMenu onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Do the thing' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('closes after an item is selected', async () => {
    const user = userEvent.setup();
    render(<TestMenu onSelect={() => undefined} />);

    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Do the thing' }));

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });
});
