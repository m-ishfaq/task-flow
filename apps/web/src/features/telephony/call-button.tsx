import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { useToast } from '../../lib/toast-context.js';
import { Button } from '../../components/primitives.js';
import { orgDetailQuery } from '../org/api.js';
import { invalidateAfterSpend, phoneNumbersQuery } from './api.js';

/**
 * Click-to-call, wherever a phone number is already on screen.
 *
 * PLAN.md §3.4 specifies click-to-call "from any card/contact/chat thread", and
 * Wave 5 shipped only the dialler on `/calls`. This is the one component every
 * other surface reuses (`person-page.tsx`, `channel-details.tsx`, and both
 * telephony panels), so the call sites cannot drift into slightly different
 * ideas of what placing a call means — the same argument `checkOutboundAllowed`
 * makes on the server, applied to the button.
 *
 * ## It hides itself, and that is new (Phase 15 §1)
 *
 * `call:place` used to be a Member role default, so "render for everyone and
 * let the server answer" was the right call — nobody would ever actually be
 * refused. It is now an individually granted permission
 * (`authz.member_grants`), so a Member who does not hold it would otherwise
 * click a live, unlabelled "Call" button on FOUR different pages and get a
 * FORBIDDEN toast every time — the same "gate somebody can never open" the
 * capability gates elsewhere already avoid, just reached from reusable
 * components those gates don't wrap. `capabilities.placeCalls` is the same
 * server-computed boolean `telephony-page.tsx` reads (`tenancy.orgs.get`),
 * so this is still not re-deriving `can()` — it renders one decision the
 * server already made, not a second copy of the decision itself. Renders
 * nothing while that capability is loading, same as `CapabilityGate`.
 *
 * The number-ownership check below is unrelated and unchanged: it is not a
 * permission, it is a precondition with a specific remedy ("buy one"), and a
 * FORBIDDEN-shaped error would describe it wrongly.
 */
export function CallButton({
  orgId,
  to,
  label = 'Call',
  size = 'sm',
  variant = 'ghost',
  className,
}: {
  readonly orgId: string;
  /** Destination in E.164. A blank value disables the button. */
  readonly to: string;
  readonly label?: string;
  readonly size?: 'sm' | 'md';
  readonly variant?: 'primary' | 'ghost';
  readonly className?: string;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const org = useQuery(orgDetailQuery(orgId));
  const numbers = useQuery({
    ...phoneNumbersQuery(orgId),
    enabled: org.data?.capabilities.placeCalls === true,
  });

  const from = numbers.data?.[0]?.phoneNumberId ?? '';

  const place = useMutation({
    mutationFn: () =>
      api.telephony.calls.place.mutate({
        to,
        fromPhoneNumberId: from,
        /* Never record from a one-click affordance. Recording is a decision
           with legal weight in several jurisdictions (packages/telephony's
           consent table), and a button whose caption is "Call" must not be
           the thing that starts it. The dialler on /calls has the explicit
           checkbox for that. */
        record: false,
      }),
    onSuccess: async () => {
      toast.show('Call placed', { description: `Dialling ${to}` });
      await invalidateAfterSpend(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('The call was not placed', error);
    },
  });

  const noNumber = !numbers.isPending && from === '';

  // Renders nothing until the capability is known, and nothing at all for a
  // caller who does not hold `call:place` — see the doc comment above.
  if (org.data?.capabilities.placeCalls !== true) return null;

  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={place.isPending || to === '' || noNumber}
      title={noNumber ? 'Buy a phone number before placing calls.' : `Call ${to}`}
      onClick={() => {
        place.mutate();
      }}
    >
      {place.isPending ? 'Calling…' : label}
    </Button>
  );
}
