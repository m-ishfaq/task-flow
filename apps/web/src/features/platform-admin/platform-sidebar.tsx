import { useState } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Building2,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Flag,
  Globe,
  LayoutGrid,
  LogOut,
  Megaphone,
  Palette,
  Shield,
  Users,
  X,
  Zap,
  type LucideProps,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { cn } from '../../lib/cn.js';
import { TaskFlowLogo } from '../../components/taskflow-logo.js';
import { useBranding } from '../../lib/branding-context.js';
import { signOut } from '../../lib/session.js';

/* -------------------------------------------------------------------------- *
 * Platform Sidebar — Premium dark sidebar with glass morphism
 *
 * Distinct from the member sidebar: dark background, frosted glass panels,
 * accent-colored active states with glow, smooth collapse animation.
 * Mobile: fixed drawer overlay. Desktop: static, collapsible.
 * -------------------------------------------------------------------------- */

type NavIcon = ComponentType<LucideProps>;

interface SidebarItem {
  readonly id: string;
  readonly label: string;
  readonly icon: NavIcon;
  readonly badge?: string;
}

interface SidebarSection {
  readonly id: string;
  readonly label: string;
  readonly items: readonly SidebarItem[];
}

const SECTIONS: readonly SidebarSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [{ id: 'dashboard', label: 'Dashboard', icon: BarChart3 }],
  },
  {
    id: 'tenants',
    label: 'Tenants',
    items: [
      { id: 'orgs', label: 'Organizations', icon: Building2 },
      { id: 'users', label: 'Users', icon: Users },
    ],
  },
  {
    id: 'commerce',
    label: 'Commerce',
    items: [
      { id: 'billing', label: 'Billing', icon: CreditCard },
      { id: 'plans', label: 'Plans', icon: LayoutGrid },
    ],
  },
  {
    id: 'health',
    label: 'Health',
    items: [
      { id: 'errors', label: 'Errors', icon: Activity },
      { id: 'operations', label: 'Operations', icon: Zap },
      { id: 'flags', label: 'Feature Flags', icon: Flag },
    ],
  },
  {
    id: 'intel',
    label: 'Intelligence',
    items: [{ id: 'ai', label: 'AI Models', icon: Bot }],
  },
  {
    id: 'platform',
    label: 'Platform',
    items: [
      { id: 'broadcast', label: 'Broadcast', icon: Megaphone },
      { id: 'audit', label: 'Audit Log', icon: Shield },
      { id: 'branding', label: 'Branding', icon: Palette },
      { id: 'config', label: 'Configuration', icon: Globe },
    ],
  },
];

export function PlatformSidebar({
  activeTab,
  onNavigate,
  collapsed: controlledCollapsed,
  onToggleCollapse,
  isMobileDrawer = false,
  onCloseMobile,
}: {
  readonly activeTab: string;
  readonly onNavigate: (tab: string) => void;
  readonly collapsed?: boolean;
  readonly onToggleCollapse?: () => void;
  readonly isMobileDrawer?: boolean;
  readonly onCloseMobile?: () => void;
}) {
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const toggleCollapse =
    onToggleCollapse ??
    (() => {
      setInternalCollapsed((c) => !c);
    });
  const { productName, logoUrl } = useBranding();

  return (
    <aside
      aria-label="Platform administration"
      className={cn(
        'flex h-full flex-col overflow-hidden',
        'bg-surface-sunken',
        'border-r border-line',
        /* Mobile drawer: fixed overlay with slide transition */
        isMobileDrawer && 'fixed inset-y-0 left-0 z-40 w-64 shadow-2xl shadow-black/40',
        /* Desktop: static, collapsible width */
        !isMobileDrawer && 'relative shrink-0 transition-[width] duration-200 ease-in-out',
        !isMobileDrawer && (collapsed ? 'w-15' : 'w-60'),
      )}
    >
      {/* ── Header ── */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center border-b border-line',
          collapsed && !isMobileDrawer ? 'justify-center px-2' : 'gap-2.5 px-4',
        )}
      >
        {logoUrl !== null ? (
          <img src={logoUrl} alt="" className="size-5 shrink-0 rounded object-contain" />
        ) : (
          <TaskFlowLogo size={18} className="shrink-0 text-accent" />
        )}
        {(!collapsed || isMobileDrawer) && (
          <>
            <span className="flex-1 truncate text-[13px] font-semibold text-white/90">
              {productName}
            </span>
            <span className="shrink-0 rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">
              Admin
            </span>
          </>
        )}
        {isMobileDrawer ? (
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation"
            className="ml-auto rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <X aria-hidden="true" className="size-4" strokeWidth={2} />
          </button>
        ) : (
          <button
            type="button"
            onClick={toggleCollapse}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn(
              'rounded-md p-1 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink',
              collapsed ? '' : 'ml-auto',
            )}
          >
            {collapsed ? (
              <ChevronRight aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
            ) : (
              <ChevronLeft aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
            )}
          </button>
        )}
      </div>

      {/* ── Navigation ── */}
      <nav
        aria-label="Platform navigation"
        className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
      >
        {SECTIONS.map((section) => (
          <div key={section.id} className="mb-3">
            {(!collapsed || isMobileDrawer) && (
              <div className="mb-1 px-2.5 pt-4 pb-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-ink-faint">
                {section.label}
              </div>
            )}
            {collapsed && !isMobileDrawer && <div className="mx-auto my-2 h-px w-5 bg-line" />}
            {section.items.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onNavigate(item.id);
                    onCloseMobile?.();
                  }}
                  title={collapsed && !isMobileDrawer ? item.label : undefined}
                  className={cn(
                    'group relative mb-0.5 flex w-full items-center rounded-lg transition-all duration-150',
                    collapsed && !isMobileDrawer
                      ? 'justify-center px-0 py-2.5'
                      : 'gap-2.5 px-2.5 py-2',
                    isActive
                      ? 'bg-accent/12 text-accent'
                      : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                  )}
                >
                  {/* Active indicator glow */}
                  {isActive && (
                    <span className="absolute inset-y-1.5 left-0 w-[2.5px] rounded-full bg-accent shadow-[0_0_8px_color-mix(in_oklab,var(--color-accent)_50%,transparent)]" />
                  )}

                  <Icon
                    aria-hidden="true"
                    className={cn(
                      'shrink-0 transition-colors',
                      collapsed && !isMobileDrawer ? 'size-4.5' : 'size-4',
                      isActive ? 'text-accent' : 'text-ink-faint group-hover:text-ink',
                    )}
                    strokeWidth={isActive ? 2 : 1.5}
                  />

                  {(!collapsed || isMobileDrawer) && (
                    <span className="truncate text-[13px] font-medium">{item.label}</span>
                  )}

                  {/* Badge (e.g., error count) */}
                  {item.badge !== undefined && (!collapsed || isMobileDrawer) && (
                    <span className="ml-auto shrink-0 rounded-full bg-danger/15 px-1.5 py-0.5 text-[10px] font-bold text-danger">
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* ── Footer — Sign out ── */}
      <div className="shrink-0 border-t border-line px-2 py-2">
        <button
          type="button"
          onClick={() => {
            void signOut().then(() => {
              window.location.assign('/login');
            });
          }}
          className={cn(
            'group flex w-full items-center rounded-lg transition-all duration-150',
            collapsed && !isMobileDrawer ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-2.5 py-2',
            'text-ink-muted hover:bg-surface-hover hover:text-ink',
          )}
          title={collapsed && !isMobileDrawer ? 'Sign out' : undefined}
        >
          <div
            className={cn(
              'flex shrink-0 items-center justify-center rounded-md transition-colors',
              collapsed && !isMobileDrawer ? 'size-7' : 'size-7',
              'bg-ink-faint/10 group-hover:bg-danger/15',
            )}
          >
            <LogOut
              className={cn(
                'transition-colors group-hover:text-danger',
                collapsed && !isMobileDrawer ? 'size-3.5' : 'size-3.5',
                'text-ink-faint',
              )}
              strokeWidth={2}
            />
          </div>
          {(!collapsed || isMobileDrawer) && (
            <span className="truncate text-[13px] font-medium">Sign out</span>
          )}
        </button>
      </div>
    </aside>
  );
}
