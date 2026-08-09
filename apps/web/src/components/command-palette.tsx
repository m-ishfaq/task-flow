import { useEffect, useMemo, useState } from 'react';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ProjectId } from '@taskflow/contracts';
import { useSession } from '../lib/session.js';
import { useUi } from '../lib/ui-store.js';
import { projectsQuery } from '../features/work/api.js';
import { cn } from '../lib/cn.js';

/**
 * The command palette and the `?` shortcuts overlay
 * (`ai/phase-3.5-work-ux.md` §6).
 *
 * One component, rendered once by `Shell`, because both are reached by a
 * single global key that must work from anywhere in the app — a board, a
 * settings page, an empty state — and a listener mounted per-page would miss
 * whichever page did not think to add it.
 *
 * ## Scope: navigation and actions, not search
 *
 * §6 draws the line explicitly: "must not grow into search — that is
 * Phase 8". So this palette does not reach into card titles or comments; it
 * only offers destinations the sidebar already exposes (this page's own
 * `projects.list` query, which the sidebar also runs, so it costs nothing
 * extra once either has been opened) and a handful of app-wide actions. A
 * cross-org "find anything" box is a different feature with a different
 * authorization story — every result would need `can()` checked per row
 * before being shown, which a real search index does and a client-side
 * filter over a partial list would not.
 */

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

export function CommandPalette() {
  const paletteOpen = useUi((state) => state.commandPaletteOpen);
  const setPaletteOpen = useUi((state) => state.setCommandPaletteOpen);
  const shortcutsOpen = useUi((state) => state.shortcutsOpen);
  const setShortcutsOpen = useUi((state) => state.setShortcutsOpen);

  /* The one listener for both dialogs. Cmd/Ctrl+K always wins over `?` — a
     macOS/Windows convention no other app in this category breaks — and `?`
     is ignored while a form field has focus, so a search box or a card title
     can contain a literal question mark without popping a dialog over it. */
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if (event.key === '?' && !meta && !isTypingTarget(event.target)) {
        event.preventDefault();
        setShortcutsOpen(true);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [setPaletteOpen, setShortcutsOpen]);

  return (
    <>
      <PaletteDialog open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}

interface Command {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly run: () => void;
}

function PaletteDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const orgId = useSession((state) => state.orgId) ?? '';
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  /* Only fetched while the palette is open — the sidebar tree already keeps
     this warm on every page that has one, so this is usually a cache hit. */
  const projects = useQuery({ ...projectsQuery(orgId), enabled: open && orgId !== '' });

  const commands = useMemo<readonly Command[]>(() => {
    const go =
      (to: '/home' | '/projects' | '/settings' | '/settings/audit' | '/admin/permissions') =>
      () => {
        void navigate({ to });
      };

    const navigation: Command[] = [
      { id: 'home', label: 'My tasks', hint: 'Go to', run: go('/home') },
      { id: 'projects', label: 'Projects', hint: 'Go to', run: go('/projects') },
      { id: 'settings', label: 'Settings', hint: 'Go to', run: go('/settings') },
      { id: 'audit', label: 'Audit log', hint: 'Go to', run: go('/settings/audit') },
      { id: 'permissions', label: 'Permissions', hint: 'Go to', run: go('/admin/permissions') },
      { id: 'toggle-sidebar', label: 'Toggle sidebar', hint: 'Action', run: toggleSidebar },
    ];

    const projectCommands: Command[] = (projects.data ?? [])
      .filter((project) => project.archivedAt === null)
      .map((project) => ({
        id: `project-${project.projectId}`,
        label: project.name,
        hint: 'Project',
        run: () => {
          void navigate({
            to: '/projects/$projectId',
            params: { projectId: project.projectId as ProjectId },
          });
        },
      }));

    return [...navigation, ...projectCommands];
  }, [navigate, projects.data, toggleSidebar]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === ''
      ? commands
      : commands.filter((command) => command.label.toLowerCase().includes(needle));
  }, [commands, query]);

  const runAt = (index: number) => {
    const command = filtered[index];
    if (command === undefined) return;
    command.run();
    onOpenChange(false);
  };

  return (
    <ModalRoot
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        /* Cleared on CLOSE, a direct event rather than an effect syncing off
           `open` — every path out (Escape, overlay click, selecting a
           command via `runAt`) goes through this one handler, so the next
           open always starts blank with no state to reconcile first. */
        if (!next) {
          setQuery('');
          setActive(0);
        }
      }}
    >
      <ModalContent size="lg" placement="top">
        <ModalTitle className="sr-only">Command palette</ModalTitle>
        <ModalDescription className="sr-only">
          Jump to a page or project, or run an action.
        </ModalDescription>

        {/* No `autoFocus` — Radix's `Dialog.Content` already moves focus to
            the first focusable descendant when it opens, which is this
            input, so a second, ESLint-flagged focus mechanism would be
            redundant rather than additive. */}
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            // A fresh search invalidates whatever was highlighted — a
            // direct consequence of the keystroke, not a derived effect.
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, filtered.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              runAt(active);
            }
          }}
          placeholder="Jump to a project, or run an action…"
          aria-label="Command palette"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink outline-none placeholder:text-ink-faint"
        />

        <ul role="listbox" className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-ink-faint">No matches</li>
          ) : (
            filtered.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => {
                    setActive(index);
                  }}
                  onClick={() => {
                    runAt(index);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-sm',
                    index === active ? 'bg-surface-hover text-ink' : 'text-ink-muted',
                  )}
                >
                  <span className="truncate">{command.label}</span>
                  <span className="shrink-0 text-[11px] text-ink-faint">{command.hint}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </ModalContent>
    </ModalRoot>
  );
}

interface ShortcutGroup {
  readonly title: string;
  readonly items: readonly { readonly keys: string; readonly description: string }[];
}

/**
 * What this app actually understands, grouped the way the overlay renders
 * them. Kept as data rather than scattered JSX so adding a shortcut is one
 * line here instead of a second dialog nobody remembers to update.
 */
const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Everywhere',
    items: [
      { keys: 'Ctrl/⌘ K', description: 'Open the command palette' },
      { keys: '?', description: 'Show this overlay' },
      { keys: 'Esc', description: 'Close a dialog' },
    ],
  },
  {
    title: 'Board',
    items: [
      { keys: 'Drag', description: 'Move a card between columns or groups' },
      { keys: 'Ctrl/⌘ + click', description: 'Select or deselect a card' },
      { keys: 'Shift + click', description: 'Select a range of cards' },
      { keys: 'Enter', description: 'Add a card and keep adding' },
      { keys: 'Esc', description: 'Cancel adding a card' },
    ],
  },
];

function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <ModalRoot open={open} onOpenChange={onOpenChange}>
      <ModalContent size="md" className="p-4">
        <ModalTitle>Keyboard shortcuts</ModalTitle>
        <ModalDescription className="sr-only">
          Every shortcut this app understands.
        </ModalDescription>

        <div className="mt-3 space-y-4">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="mb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">
                {group.title}
              </p>
              <ul className="space-y-1">
                {group.items.map((item) => (
                  <li key={item.keys} className="flex items-center justify-between text-sm">
                    <span className="text-ink-muted">{item.description}</span>
                    <kbd className="rounded border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink">
                      {item.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </ModalContent>
    </ModalRoot>
  );
}
