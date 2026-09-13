import { useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../lib/session.js';
import { NavTabs } from '../../components/primitives.js';
import { orgDetailQuery, type SettingsCapabilities } from '../org/api.js';
import { CallsPanel } from './calls-panel.js';
import { NumbersPanel } from './numbers-panel.js';
import { MessagesPanel } from './messages-panel.js';
import { RecordingsPanel } from './recordings-panel.js';
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
 * Per CLAUDE.md §8.2, nothing here re-derives authorization — every tab
 * still renders through the server, which is what actually refuses a
 * request. What changed (Phase 15 §1): `phoneNumber:read`/`call:read`/
 * `sms:read`/`call:place`/`sms:send` are no longer Member role defaults,
 * they are individually granted via `authz.member_grants`, so a Member can
 * hold any SUBSET of them. Rendering all four tabs unconditionally would put
 * three of them permanently one click from a "You do not have permission to
 * do that" error for anyone with a partial grant — the exact gap this
 * section closes, per the standing rule that a permission which used to be
 * freely available must have every one of its old display sites re-checked,
 * not just the one that was reported. Each tab is hidden unless its own
 * `SettingsCapabilities` boolean is true; Spend's `report` sub-view still
 * needs `recording:read` (ADMIN, not one of the five grantable permissions,
 * so it stays an inline FORBIDDEN exactly as before this change — that half
 * was never freely available to a Member to begin with).
 */

const TABS = [
  { id: 'calls', label: 'Calls', capability: 'readCalls' },
  { id: 'numbers', label: 'Numbers', capability: 'readPhoneNumbers' },
  { id: 'messages', label: 'Messages', capability: 'readSms' },
  { id: 'recordings', label: 'Recordings', capability: 'readRecordings' },
  { id: 'spend', label: 'Spend', capability: 'readPhoneNumbers' },
] as const satisfies readonly {
  id: string;
  label: string;
  capability: keyof SettingsCapabilities;
}[];

type TabId = (typeof TABS)[number]['id'];

export function TelephonyPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();
  const tab = useSearch({ from: '/calls', select: (value) => value.tab }) ?? 'calls';
  const org = useQuery(orgDetailQuery(orgId));
  const capabilities = org.data?.capabilities;

  const visibleTabs =
    capabilities === undefined ? [] : TABS.filter((item) => capabilities[item.capability]);

  const selectTab = (next: TabId) => {
    void navigate({ to: '/calls', search: { tab: next, thread: undefined } });
  };

  // If the current tab isn't one the caller can see (a stale link, or a
  // partial grant that never covered it), land on the first tab that is —
  // never on a tab this org member has never been able to open.
  useEffect(() => {
    if (capabilities === undefined) return;
    const allowed = TABS.filter((item) => capabilities[item.capability]);
    if (allowed.some((item) => item.id === tab)) return;
    const fallback = allowed[0];
    if (fallback !== undefined) selectTab(fallback.id);
    /* `selectTab` closes over `navigate`, a new reference each render;
       including it would re-run this on every render rather than only when
       the tab or the capability set actually changes. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities, tab]);

  if (capabilities !== undefined && visibleTabs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-sm text-center text-sm text-ink-muted">
          You don&apos;t have access to any part of Voice &amp; Messaging yet. An admin or owner can
          grant you access from Settings → Individual permissions.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line/50 px-4 pt-4 pb-2">
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
          Voice &amp; Messaging
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Phone numbers, calls, SMS, and spend — one carrier account per organization.
        </p>
        {/* `NavTabs` (`primitives.tsx`, consolidated during the warm-dark
            rebuild — `ai/design-rebuild-warm-dark.md` §3) is this exact
            markup, extracted after being found duplicated byte-for-byte
            in automations-page.tsx. */}
        <NavTabs
          ariaLabel="Voice & Messaging sections"
          value={tab}
          onChange={selectTab}
          className="mt-3"
          items={visibleTabs.map((item) => ({ value: item.id, label: item.label }))}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'calls' && capabilities?.readCalls === true && <CallsPanel orgId={orgId} />}
        {tab === 'numbers' && capabilities?.readPhoneNumbers === true && (
          <NumbersPanel orgId={orgId} />
        )}
        {tab === 'messages' && capabilities?.readSms === true && <MessagesPanel orgId={orgId} />}
        {tab === 'recordings' && capabilities?.readRecordings === true && (
          <RecordingsPanel orgId={orgId} />
        )}
        {tab === 'spend' && capabilities?.readPhoneNumbers === true && <SpendPanel orgId={orgId} />}
      </div>
    </div>
  );
}
