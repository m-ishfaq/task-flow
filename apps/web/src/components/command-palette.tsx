import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Folder,
  Layers,
  ListChecks,
  Lock,
  PanelLeftOpen,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  type LucideProps,
} from 'lucide-react';
import type { ProjectId } from '@taskflow/contracts';
import { useSession } from '../lib/session.js';
import { useUi } from '../lib/ui-store.js';
import { activeSprintsQuery, projectsQuery } from '../features/work/api.js';
import { orgDetailQuery } from '../features/org/api.js';
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
  const navigate = useNavigate();

  /* The one listener for both dialogs. Cmd/Ctrl+K always wins over `?` — a
     macOS/Windows convention no other app in this category breaks — and both
     `?` and `/` are ignored while a form field has focus, so a search box or
     a card title can contain a literal question mark or slash without popping
     a dialog over it. `/` reaches search directly (§3.1 of the phase spec:
     "`/` or the existing palette key reaches it"); the palette key reaches
     it too, via the Search command below. */
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if (event.key === '/' && !meta && !isTypingTarget(event.target)) {
        event.preventDefault();
        void navigate({ to: '/search' });
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
  }, [navigate, setPaletteOpen, setShortcutsOpen]);

  return (
    <>
      <PaletteDialog open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}

/** A `lucide-react` icon component — matches sidebar.tsx's own alias. */
type CommandIcon = ComponentType<LucideProps>;

interface Command {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** The Design Bible's own `.palette .opt` rows are icon-leading, not
      bare text — every command gets one, in the color of the module it
      leads to (suite-work for a project or sprint, neutral for everything
      that isn't one of the five suite modules — the identical distinction
      the sidebar itself already draws between a colored tree row and a
      generic top-level link). */
  readonly icon: CommandIcon;
  readonly iconClassName?: string;
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
  /* The running sprints, same open-only rule (10.6 slice 2). The sidebar keeps
     this warm too, so it is normally a cache hit — and there is at most one row
     per project, so this never grows into a list worth paginating. */
  const activeSprints = useQuery({ ...activeSprintsQuery(orgId), enabled: open && orgId !== '' });
  /* Same open-only rule — gates the "Audit log" and "Permissions" commands
     below (Phase 15 §1's sweep: both used to be offered to every role
     unconditionally, pointing at routes that are now `CapabilityGate`d —
     `router.tsx` and `shell.tsx`'s nav are the other two places this same
     `viewAuditLog` boolean hides the identical destinations). */
  const capabilities = useQuery({ ...orgDetailQuery(orgId), enabled: open && orgId !== '' }).data
    ?.capabilities;

  const commands = useMemo<readonly Command[]>(() => {
    const go =
      (to: '/home' | '/projects' | '/settings' | '/settings/audit' | '/admin/permissions') =>
      () => {
        void navigate({ to });
      };

    const navigation: Command[] = [
      { id: 'home', label: 'My tasks', hint: 'Go to', icon: ListChecks, run: go('/home') },
      { id: 'projects', label: 'Projects', hint: 'Go to', icon: Folder, run: go('/projects') },
      {
        id: 'settings',
        label: 'Settings',
        hint: 'Go to',
        icon: SlidersHorizontal,
        run: go('/settings'),
      },
      ...(capabilities?.viewAuditLog === true
        ? [
            {
              id: 'audit',
              label: 'Audit log',
              hint: 'Go to',
              icon: Lock,
              run: go('/settings/audit'),
            },
            {
              id: 'permissions',
              label: 'Permissions',
              hint: 'Go to',
              icon: ShieldCheck,
              run: go('/admin/permissions'),
            },
          ]
        : []),
      {
        id: 'toggle-sidebar',
        label: 'Toggle sidebar',
        hint: 'Action',
        icon: PanelLeftOpen,
        run: toggleSidebar,
      },
    ];

    const projectCommands: Command[] = (projects.data ?? [])
      .filter((project) => project.archivedAt === null)
      .map((project) => ({
        icon: Folder,
        iconClassName: 'text-suite-work',
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

    /* The palette stays "navigation and actions, not search" (§6) — it does
       NOT become a search box. What it gains is a single entry that ROUTES to
       the search page with the typed text prefilled, which is exactly §3.3:
       "the palette gains a search entry that routes to /search with the typed
       query prefilled". Per-hit can() stays the search page's job. */
    const trimmed = query.trim();
    const searchCommand: Command[] =
      trimmed === ''
        ? []
        : [
            {
              id: 'search',
              label: `Search for “${trimmed}”`,
              hint: 'Search',
              icon: Search,
              run: () => {
                void navigate({ to: '/search', search: { q: trimmed } });
              },
            },
          ];

    /* The running sprints, by NAME (10.6 slice 2).
       Listed before projects because a sprint is the thing a person is in the
       middle of — "Sprint 14" is a more likely thing to be reaching for during
       a sprint than the project that contains it, and the palette's order is
       its only ranking. The label carries the project so two teams' "Sprint 14"
       are told apart, which is the whole reason a bare sprint name is not
       enough on an org-wide list. */
    const sprintCommands: Command[] = (activeSprints.data ?? []).map((sprint) => {
      const project = (projects.data ?? []).find((entry) => entry.projectId === sprint.projectId);
      return {
        id: `sprint-${sprint.sprintId}`,
        label: project === undefined ? sprint.name : `${sprint.name} — ${project.name}`,
        hint: 'Sprint',
        icon: Layers,
        iconClassName: 'text-suite-work',
        run: () => {
          void navigate({
            to: '/projects/$projectId/sprints',
            params: { projectId: sprint.projectId as ProjectId },
          });
        },
      };
    });

    return [...searchCommand, ...navigation, ...sprintCommands, ...projectCommands];
  }, [
    activeSprints.data,
    capabilities?.viewAuditLog,
    navigate,
    projects.data,
    query,
    toggleSidebar,
  ]);

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

        {/* The Design Bible's own `.palette .search` row — a leading glyph
            beside the input, not a bare text box. Decorative only
            (`aria-hidden`): the input already carries its own `aria-label`. */}
        <div className="flex items-center gap-2.5 border-b border-line/50 px-4 py-3">
          <Search
            aria-hidden="true"
            className="size-[18px] shrink-0 text-ink-faint"
            strokeWidth={2}
          />
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
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
        </div>

        <ul role="listbox" className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-ink-faint">No matches</li>
          ) : (
            filtered.map((command, index) => {
              const Icon = command.icon;
              return (
                <li
                  key={command.id}
                  data-state="open"
                  className="ui-fade"
                  /* A per-row entrance, not a per-keystroke one — React keeps
                     the same DOM node for a command that stays in `filtered`
                     across a keystroke (same key), so this only actually
                     plays for a row that is genuinely new on screen: the
                     palette's first open, or a fresh match appearing as the
                     query narrows. Capped at the 8th row so a long default
                     list still reads as "appeared," not "is still arriving"
                     — `--motion-fast` is what `.ui-fade` itself no-ops to
                     under reduced motion, so multiplying it keeps this delay
                     honoring that preference for free, the same reasoning
                     `.ui-fade`'s own comment gives for reusing `--motion-base`
                     rather than a second, unguarded duration. */
                  style={{
                    transitionDelay: `calc(var(--motion-fast) * ${String(Math.min(index, 8))})`,
                  }}
                >
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
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors duration-(--motion-fast)',
                      index === active
                        ? 'bg-accent/10 text-ink'
                        : 'text-ink-muted hover:bg-surface-hover',
                    )}
                  >
                    <Icon
                      aria-hidden="true"
                      className={cn('size-4 shrink-0', command.iconClassName ?? 'text-ink-faint')}
                      strokeWidth={2}
                    />
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    <span className="shrink-0 rounded bg-surface-hover/80 px-1.5 py-0.5 text-xs font-medium text-ink-faint">
                      {command.hint}
                    </span>
                  </button>
                </li>
              );
            })
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
      { keys: '/', description: 'Search the workspace' },
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
              <p className="mb-1.5 text-xs font-semibold tracking-wide text-ink-faint uppercase">
                {group.title}
              </p>
              <ul className="space-y-1">
                {group.items.map((item) => (
                  <li key={item.keys} className="flex items-center justify-between text-sm">
                    <span className="text-ink-muted">{item.description}</span>
                    <kbd className="rounded-md border border-line/60 bg-surface-sunken px-1.5 py-0.5 font-mono text-xs font-medium text-ink">
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
