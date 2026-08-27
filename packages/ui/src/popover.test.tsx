import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { PopoverRoot, PopoverTrigger } from './primitives.js';
import { PopoverContent } from './popover.js';

function TestPopover() {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button type="button">Open</button>
      </PopoverTrigger>
      <PopoverContent>
        <p>Popover body</p>
      </PopoverContent>
    </PopoverRoot>
  );
}

describe('PopoverRoot/PopoverContent', () => {
  it('is closed until the trigger is clicked', () => {
    render(<TestPopover />);
    expect(screen.queryByText('Popover body')).not.toBeInTheDocument();
  });

  it('opens on trigger click and closes on outside click', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <TestPopover />
        <button type="button">Elsewhere</button>
      </div>,
    );

    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByText('Popover body')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));

    await waitFor(() => {
      expect(screen.queryByText('Popover body')).not.toBeInTheDocument();
    });
  });
});
