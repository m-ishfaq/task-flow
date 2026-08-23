import { queryOptions } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire, type Wire } from '@taskflow/client';

/** Tenancy reads: the org switcher, the member list, the permission explainer. */

interface Outputs {
  orgs: Awaited<ReturnType<typeof api.tenancy.orgs.list.query>>;
  org: Awaited<ReturnType<typeof api.tenancy.orgs.get.query>>;
  members: Awaited<ReturnType<typeof api.tenancy.members.list.query>>;
  explain: Awaited<ReturnType<typeof api.tenancy.authz.explain.query>>;
}

export type OrgMembership = Wire<Outputs['orgs']>[number];
export type OrgDetail = Wire<Outputs['org']>;
export type SettingsCapabilities = OrgDetail['capabilities'];
export type Member = Wire<Outputs['members']>[number];
export type Explanation = Wire<Outputs['explain']>;

/**
 * The organizations the caller belongs to.
 *
 * Deliberately NOT keyed by org: it is the one query that spans them, answered
 * by `withUserScope` on the server rather than `withOrgScope`. Keying it under
 * an org would make it disappear whenever no org is selected — which is exactly
 * the moment the switcher needs it.
 */
export function orgsQuery() {
  return queryOptions({
    queryKey: keys.orgs(),
    // Explicit `undefined`: the route takes no input, and tRPC types the
    // argument as required-but-void.
    queryFn: async () => wire(await api.tenancy.orgs.list.query(undefined)),
  });
}

/**
 * The current org, including the caller's own `capabilities` — what the
 * Settings page's admin controls are for. Keyed with a `'detail'` suffix so
 * it does not collide with `keys.org(orgId)`'s own prefix, which other
 * queries (member/team mutations' invalidation) address as a group.
 */
export function orgDetailQuery(orgId: string) {
  return queryOptions({
    queryKey: [...keys.org(orgId), 'detail'],
    queryFn: async () => wire(await api.tenancy.orgs.get.query(undefined)),
  });
}

export function membersQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.members(orgId),
    queryFn: async () => wire(await api.tenancy.members.list.query(undefined)),
  });
}

export interface ExplainInput {
  readonly userId: string;
  readonly permission: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
}
