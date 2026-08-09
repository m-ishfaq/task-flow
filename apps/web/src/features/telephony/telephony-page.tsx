import { useNavigate, useSearch } from '@tanstack/react-router';
import { useSession } from '../../lib/session.js';
import { cn } from '../../lib/cn.js';
import { CallsPanel } from './calls-panel.js';
import { NumbersPanel } from './numbers-panel.js';
import { MessagesPanel } from './messages-panel.js';
import { SpendPanel } from './spend-panel.js';

/**
 * Voice & Messaging (Phase 7 Wave 5 — the browser half of the phase; the API
 * itself is `apps/api/src/telephony`, Waves 1-4).
 *
 * Four tabs over one org-scoped resource, the identical shape `settings-page.tsx`
 * uses for its own sections — a search param rather than nested routes, so the
 * open tab is a shareable, back-button-correct link (the same reasoning
 * `chatRoute`'s `channel` and `docsRoute`'s `page` already establish).
 *
 * Per CLAUDE.md §8.2, nothing here re-derives authorization: every tab and
 * every control renders unconditionally, and a caller without the permission
 * gets a real FORBIDDEN from the server the first time they try — not a
 * hidden button. `phoneNumber:read`/`call:read`/`sms:read` cover MEMBER for
 * three of the four tabs; Spend's `report` sub-view needs `recording:read`
 * (ADMIN), so a member sees "current spend" there and a FORBIDDEN on the
 * itemized report, exactly as the server's own tiering intends.
 */

const TABS = [
  { id: 'calls', label: 'Calls' },
  { id: 'numbers', label: 'Numbers' },
  { id: 'messages', label: 'Messages' },
  { id: 'spend', label: 'Spend' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function TelephonyPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();
  const tab = useSearch({ from: '/calls', select: (value) => value.tab }) ?? 'calls';

  const selectTab = (next: TabId) => {
    void navigate({ to: '/calls', search: { tab: next, thread: undefined } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line px-4 pt-3">
        <h1 className="mb-2 text-sm font-semibold text-ink">Voice &amp; Messaging</h1>
        <nav aria-label="Voice & Messaging sections" className="flex gap-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => {
                selectTab(item.id);
              }}
              className={cn(
                'rounded-t px-3 py-1.5 text-xs font-medium',
                tab === item.id
                  ? 'border-x border-t border-line bg-surface text-ink'
                  : 'text-ink-muted hover:text-ink',
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'calls' && <CallsPanel orgId={orgId} />}
        {tab === 'numbers' && <NumbersPanel orgId={orgId} />}
        {tab === 'messages' && <MessagesPanel orgId={orgId} />}
        {tab === 'spend' && <SpendPanel orgId={orgId} />}
      </div>
    </div>
  );
}
