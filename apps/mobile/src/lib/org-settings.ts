import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Organization settings — the org itself and its members, ported from
 * `apps/web/src/features/admin/settings-page.tsx`. Same routes
 * (`tenancy.orgs.get/update`, `tenancy.members.list/add/changeRole/
 * remove`), same capability-gated shape: the member LIST is `member:read`
 * (every role sees it), and each individual control on top of it —
 * inviting, changing a role, removing — is gated on its own `capabilities`
 * flag from `tenancy.orgs.get`, never a role comparison here (CLAUDE.md
 * rule 2).
 *
 * **Teams, billing, and ownership transfer are explicitly NOT ported.**
 * All three are real, separate surfaces on web (`TeamSection`,
 * `BillingSection`, and `transferOwnership`'s own dialog) with no equivalent
 * urgency behind them yet — the org roster and role changes are what "org
 * settings and perms" was actually asking for. See `org-settings.tsx`'s own
 * header for what that leaves out and why.
 */

export type OrgDetail = Wire<
  Awaited<ReturnType<MobileTRPCClient['tenancy']['orgs']['get']['query']>>
>;
export type SettingsCapabilities = OrgDetail['capabilities'];
export type Member = Wire<
  Awaited<ReturnType<MobileTRPCClient['tenancy']['members']['list']['query']>>
>[number];

export const ORG_DETAIL_QUERY_KEY = ['tenancy.orgs.get'] as const;
export const MEMBERS_QUERY_KEY = ['tenancy.members.list'] as const;
