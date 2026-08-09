import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { useToast } from '../../lib/toast-context.js';
import { Button } from '../../components/primitives.js';
import { invalidateAfterSpend, phoneNumbersQuery } from './api.js';

/**
 * Click-to-call, wherever a phone number is already on screen.
 *
 * PLAN.md §3.4 specifies click-to-call "from any card/contact/chat thread", and
 * Wave 5 shipped only the dialler on `/calls`. This is the one component every
 * other surface reuses, so the four call sites cannot drift into four slightly
 * different ideas of what placing a call means — the same argument
 * `checkOutboundAllowed` makes on the server, applied to the button.
 *
 * ## It re-derives no authorization
 *
 * The button renders for everyone and the server answers. §8.2 is explicit that
 * a UI reimplementing `can()` produces two models that drift, and the one users
 * see is the one nothing tests — so a member without `call:place` gets an
 * honest FORBIDDEN in a toast rather than a control that silently is not there.
 *
 * The ONE thing it does check locally is whether the org owns a number at all,
 * because that is not a permission — it is a precondition with a specific
 * remedy ("buy one"), and a FORBIDDEN-shaped error would describe it wrongly.
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
  const numbers = useQuery(phoneNumbersQuery(orgId));

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
