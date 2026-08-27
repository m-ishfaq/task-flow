import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Organization settings — the org itself, its members, and its teams,
 * ported from `apps/web/src/features/admin/settings-page.tsx`. Same routes
 * (`tenancy.orgs.get/update`, `tenancy.members.list/add/changeRole/remove/
 * transferOwnership`, `tenancy.teams.list/create/addMember/removeMember`),
 * same capability-gated shape: the member and team LISTS are `member:read`/
 * `team:read` (every role sees them), and each individual control on top —
 * inviting, changing a role, removing, transferring, creating a team,
 * managing its roster — is gated on its own `capabilities` flag from
 * `tenancy.orgs.get`, never a role comparison here (CLAUDE.md rule 2).
 *
 * **Billing is explicitly NOT here** — it is its own screen
 * (`billing.tsx`), not a section on this one. `org:billing` answers a
 * different question ("what does this org pay") from everything else on
 * this page ("who is in it and what can they do"), and web's own single
 * settings page bundling both is a web-density convenience this app does
 * not need to copy; see that file's own header for the rest of the reasoning.
 */

export type OrgDetail = Wire<
  Awaited<ReturnType<MobileTRPCClient['tenancy']['orgs']['get']['query']>>
>;
export type SettingsCapabilities = OrgDetail['capabilities'];
export type Member = Wire<
  Awaited<ReturnType<MobileTRPCClient['tenancy']['members']['list']['query']>>
>[number];
export type Team = Wire<
  Awaited<ReturnType<MobileTRPCClient['tenancy']['teams']['list']['query']>>
>[number];

export const ORG_DETAIL_QUERY_KEY = ['tenancy.orgs.get'] as const;
export const MEMBERS_QUERY_KEY = ['tenancy.members.list'] as const;
export const TEAMS_QUERY_KEY = ['tenancy.teams.list'] as const;
