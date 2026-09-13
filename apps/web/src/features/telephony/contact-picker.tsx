import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, User } from 'lucide-react';
import { PopoverClose, PopoverContent, PopoverRoot, PopoverTrigger } from '@taskflow/ui';
import { Avatar, Input } from '../../components/primitives.js';
import { cn } from '../../lib/cn.js';
import { phoneContactsQuery, type PhoneContact } from './api.js';

/**
 * Choosing WHO to call or text.
 *
 * A destination is an E.164 string and always has been — `calls.place` and
 * `messages.send` both take `to`, never a user id — so this is a combobox over
 * a free-text field, not a select. Picking a colleague FILLS the field; typing a
 * number nobody in the org owns is equally valid and always available. That
 * ordering matters: making the person the primary input and the raw number the
 * escape hatch would break the case this feature exists for, which is dialling
 * customers.
 *
 * ## Why not the toggle-list picker from `assignee-section.tsx`
 *
 * Same Popover shell, deliberately different control. That one multi-selects
 * user ids and shows a ✓ per row; this one single-selects and writes a STRING
 * that the user may then edit by hand, so there is no persistent "selected" row
 * to mark — the field's own contents are the selection. Extracting a shared
 * component from two things that agree only on the popover would be extracting
 * the popover, which `@taskflow/ui` already is.
 *
 * ## The list is the org directory, not a contacts table
 *
 * `people.directory.list` filtered to members with a work phone (migration
 * 0039). There is no address book in this system, and inventing one here would
 * be a schema decision made inside a form control. A caller without
 * `member:read` gets FORBIDDEN, the trigger hides, and the field still works —
 * the picker is a convenience over a control the server authorizes on its own.
 */

export interface ContactPickerProps {
  readonly orgId: string;
  /** The E.164 destination — this component owns none of it. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly id: string;
  readonly placeholder?: string;
  readonly className?: string;
  readonly disabled?: boolean;
}

/** Digits only, so `+1 415 555 0100` and `+14155550100` are one number. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

export function ContactPicker({
  orgId,
  value,
  onChange,
  id,
  placeholder = '+14155550100',
  className,
  disabled = false,
}: ContactPickerProps) {
  const contacts = useQuery(phoneContactsQuery(orgId));
  const [query, setQuery] = useState('');

  const people = contacts.data ?? [];

  /* Which colleague, if any, the field currently names. Derived from the VALUE
     rather than remembered from the last click: the field is editable, so a
     remembered selection would keep showing a name after the number under it had
     been typed over. */
  const typed = digitsOf(value);
  const matched =
    typed === '' ? undefined : people.find((person) => digitsOf(person.phone) === typed);

  const needle = query.trim().toLowerCase();
  const filtered =
    needle === ''
      ? people
      : people.filter(
          (person) =>
            person.label.toLowerCase().includes(needle) ||
            person.email.toLowerCase().includes(needle) ||
            digitsOf(person.phone).includes(digitsOf(needle)),
        );

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          value={value}
          className="w-44"
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />

        {/* Hidden rather than disabled when there is nobody to pick: a control
            that can never do anything is noise, and the reasons the list is
            empty (no `member:read`, no work phones recorded) are not ones the
            person dialling can act on from here. */}
        {people.length > 0 && (
          <PopoverRoot
            onOpenChange={(open) => {
              // Cleared on close, so reopening does not resume the last search.
              if (!open) setQuery('');
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label="Choose a person"
                title="Choose a person"
                className={cn(
                  'flex h-9 shrink-0 items-center gap-1 rounded-lg border border-line px-2',
                  'text-xs text-ink-muted hover:bg-surface-hover hover:text-ink',
                  /* No `focus:outline-none` here, unlike the text-input fields
                     elsewhere in this file — this is a BUTTON, and suppressing
                     the outline on `focus:` (which fires on a mouse click too,
                     unlike `:focus-visible`) removed the app's own global
                     keyboard focus ring (styles.css's `:focus-visible` rule)
                     with nothing put back in its place. `focus:border-accent`
                     alone is harmless extra feedback on any focus and does not
                     need the outline gone to work. */
                  'focus:border-accent disabled:opacity-50',
                )}
              >
                {/* Real glyphs, not an emoji — a 👤 renders at the OS's own
                    size and weight, never matches the 1.75px-stroke icon
                    language every other control in this app uses. */}
                <User aria-hidden="true" className="size-3.5" strokeWidth={2} />
                <ChevronDown aria-hidden="true" className="size-3" strokeWidth={2.25} />
              </button>
            </PopoverTrigger>

            <PopoverContent align="start" className="w-64 space-y-1.5 p-2">
              {/* Same threshold as the assignee picker — below a handful of
                  rows the search box is more work than reading the list. */}
              {people.length > 8 && (
                <Input
                  aria-label="Search people"
                  placeholder="Search people…"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  className="h-7 text-xs"
                />
              )}

              {filtered.length === 0 ? (
                <p className="p-1 text-xs text-ink-faint">No matches.</p>
              ) : (
                <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                  {filtered.map((person) => (
                    <li key={person.userId}>
                      {/* `PopoverClose asChild` rather than controlling `open`
                          here: picking a person is the end of the interaction,
                          and Radix returns focus to the trigger on close. */}
                      <PopoverClose asChild>
                        <button
                          type="button"
                          onClick={() => {
                            onChange(person.phone);
                          }}
                          className={cn(
                            'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs',
                            person.userId === matched?.userId
                              ? 'bg-accent text-accent-ink'
                              : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                          )}
                        >
                          <Avatar userId={person.userId} label={person.label} size="xs" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{person.label}</span>
                            <span
                              className={cn(
                                'block truncate font-mono text-[10px]',
                                person.userId === matched?.userId
                                  ? 'text-accent-ink/70'
                                  : 'text-ink-faint',
                              )}
                            >
                              {person.phone}
                            </span>
                          </span>
                        </button>
                      </PopoverClose>
                    </li>
                  ))}
                </ul>
              )}
            </PopoverContent>
          </PopoverRoot>
        )}
      </div>

      {matched !== undefined && (
        <p className="flex items-center gap-1 text-xs text-ink-muted">
          <Avatar userId={matched.userId} label={matched.label} size="xs" />
          <span className="truncate">{matched.label}</span>
        </p>
      )}
    </div>
  );
}

export type { PhoneContact };
