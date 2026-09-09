import { queryOptions } from '@tanstack/react-query';
import { wire, type Wire } from '@taskflow/client';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';

/**
 * What an invitation link says before anyone is signed in — org name,
 * invited email, role. `tenancy.invitations.preview` is a `publicRoute`
 * (`apps/api/src/tenancy/invitation.service.ts`'s own `previewInvitation`),
 * so this needs no org context and can run from `/login` or `/register`.
 *
 * `retry: false`: the common failure is a bad, revoked, or expired token,
 * which a retry cannot fix — and `/login`/`/register` must render their
 * ordinary form immediately in that case, not sit on a spinner for an
 * invite banner nobody asked to see.
 */

type Outputs = Awaited<ReturnType<typeof api.tenancy.invitations.preview.query>>;
export type InvitationPreview = Wire<Outputs>;

export function invitationPreviewQuery(token: string) {
  return queryOptions({
    queryKey: keys.invitationPreview(token),
    queryFn: async () => wire(await api.tenancy.invitations.preview.query({ token })),
    retry: false,
    staleTime: Infinity,
  });
}
