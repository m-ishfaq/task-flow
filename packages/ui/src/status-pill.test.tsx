import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill } from './status-pill.js';

describe('StatusPill', () => {
  it('renders its label', () => {
    render(<StatusPill tone="success">active</StatusPill>);
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('always renders a dot, regardless of tone — never an icon', () => {
    for (const tone of ['success', 'danger', 'neutral'] as const) {
      const { container, unmount } = render(<StatusPill tone={tone}>x</StatusPill>);
      // The dot is the one aria-hidden child span; an icon (an svg) is never present.
      expect(container.querySelectorAll('svg')).toHaveLength(0);
      expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
      unmount();
    }
  });

  it('merges a caller-supplied className rather than replacing the base classes', () => {
    render(
      <StatusPill tone="neutral" className="min-w-[88px]">
        deleted
      </StatusPill>,
    );
    const pill = screen.getByText('deleted').closest('span');
    expect(pill?.className).toContain('min-w-[88px]');
    expect(pill?.className).toContain('rounded-full');
  });
});
