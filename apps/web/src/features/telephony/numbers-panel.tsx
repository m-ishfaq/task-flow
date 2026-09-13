import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { formatDate } from '../../lib/format.js';
import { useToast } from '../../lib/toast-context.js';
import { useStepUp } from '../auth/use-step-up.js';
import {
  Button,
  ConfirmButton,
  Empty,
  Field,
  Input,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { orgDetailQuery } from '../org/api.js';
import { invalidatePhoneNumbers, phoneNumbersQuery, type AvailableNumber } from './api.js';

/**
 * Phone number provisioning (ai/phase-7-voice.md §3.1, Wave 2).
 *
 * Buying and releasing are both `phoneNumber:purchase`/`release` — Owner-only
 * AND step-up server-side (`router.ts`), and NEITHER is in
 * `GRANTABLE_PERMISSIONS` (unlike `phoneNumber:read`, which gates this whole
 * tab and IS individually grantable). The buttons used to render for every
 * viewer holding `readPhoneNumbers` and let a non-owner's click come back
 * FORBIDDEN — fixed (Phase 15 §1's sweep) by gating "Buy a number" (search
 * is itself `phoneNumber:purchase`, since it exists only to feed a purchase)
 * on `capabilities.purchaseNumbers`, and "Release" on
 * `capabilities.releaseNumbers`.
 */

export function NumbersPanel({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { guard, dialog } = useStepUp();
  const numbers = useQuery(phoneNumbersQuery(orgId));
  const capabilities = useQuery(orgDetailQuery(orgId)).data?.capabilities;

  const [isoCountry, setIsoCountry] = useState('US');
  const [areaCode, setAreaCode] = useState('');
  const [results, setResults] = useState<readonly AvailableNumber[] | null>(null);

  const search = useMutation({
    mutationFn: () =>
      api.telephony.numbers.search.query({
        isoCountry,
        ...(areaCode.trim() === '' ? {} : { areaCode: areaCode.trim() }),
        limit: 10,
      }),
    onSuccess: setResults,
    onError: (error) => {
      toast.failure('The search did not complete', error);
    },
  });

  const refresh = () => invalidatePhoneNumbers(queryClient, orgId);

  const purchase = useMutation({
    mutationFn: (phoneNumber: string) => api.telephony.numbers.purchase.mutate({ phoneNumber }),
    onSuccess: async (_, phoneNumber) => {
      setResults(
        (current) => current?.filter((n) => String(n.phoneNumber) !== phoneNumber) ?? null,
      );
      await refresh();
    },
    onError: (error, phoneNumber) => {
      if (
        guard(error, () => {
          purchase.mutate(phoneNumber);
        })
      ) {
        return;
      }
      toast.failure('The number was not purchased', error);
    },
  });

  const release = useMutation({
    mutationFn: (phoneNumberId: string) => api.telephony.numbers.release.mutate({ phoneNumberId }),
    onSuccess: refresh,
    onError: (error, phoneNumberId) => {
      if (
        guard(error, () => {
          release.mutate(phoneNumberId);
        })
      ) {
        return;
      }
      toast.failure('The number was not released', error);
    },
  });

  return (
    <div className="mx-auto max-w-[85%] space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-ink">This org's numbers</h2>
          {numbers.data !== undefined && (
            <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
              {numbers.data.length}
            </span>
          )}
        </div>

        {numbers.isPending ? (
          <SkeletonRows rows={2} />
        ) : numbers.isError ? (
          <ErrorView error={numbers.error} title="Could not load phone numbers" />
        ) : numbers.data.length === 0 ? (
          <Empty
            title="No numbers yet"
            description="Search below to buy the organization's first one. A number is what calls and texts are made from."
          />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface-raised">
            {numbers.data.map((number) => (
              <li
                key={number.phoneNumberId}
                className="group flex items-center gap-3 px-3 py-2 transition-colors duration-(--motion-fast) hover:bg-surface-hover"
              >
                <span className="font-mono text-sm text-ink">{String(number.e164)}</span>
                <span className="rounded-md bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                  {number.isoCountry}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                  bought {formatDate(number.purchasedAt)}
                </span>
                {capabilities?.releaseNumbers === true && (
                  <ConfirmButton
                    label="Release"
                    confirmLabel={`Release ${String(number.e164)}`}
                    disabled={release.isPending}
                    onConfirm={() => {
                      release.mutate(number.phoneNumberId);
                    }}
                    className="focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {release.isError && <ErrorText error={release.error} />}
      </section>

      {capabilities?.purchaseNumbers === true && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-ink">Buy a number</h2>
          </div>
          <form
            className="rounded-lg border border-line bg-surface-raised p-3"
            onSubmit={(event) => {
              event.preventDefault();
              search.mutate();
            }}
          >
            {/* `items-start`, not `items-end` — "Area code" has a hint and
              "Country" does not, so bottom-aligning would sit the country input
              a line below the area-code one. See `Field`'s own note. */}
            <div className="flex flex-wrap items-start gap-2">
              <Field label="Country" htmlFor="tel-country">
                <Input
                  id="tel-country"
                  value={isoCountry}
                  maxLength={2}
                  className="w-16 uppercase"
                  onChange={(event) => {
                    setIsoCountry(event.target.value.toUpperCase());
                  }}
                />
              </Field>
              <Field label="Area code" htmlFor="tel-area" hint="Optional, e.g. 415">
                <Input
                  id="tel-area"
                  value={areaCode}
                  maxLength={3}
                  className="w-24"
                  onChange={(event) => {
                    setAreaCode(event.target.value.replace(/\D/g, ''));
                  }}
                />
              </Field>
              <Button type="submit" variant="primary" className="mt-5" disabled={search.isPending}>
                {search.isPending ? 'Searching…' : 'Search'}
              </Button>
            </div>
            {search.isError && <ErrorText error={search.error} />}

            {results !== null && (
              <div className="mt-3 border-t border-line pt-3">
                {results.length === 0 ? (
                  <p className="text-xs text-ink-muted">No numbers matched that search.</p>
                ) : (
                  <ul className="space-y-1">
                    {results.map((available) => {
                      const phoneNumber = String(available.phoneNumber);
                      return (
                        <li
                          key={phoneNumber}
                          className="group flex items-center gap-3 rounded-md border border-line px-2.5 py-1.5 transition-colors duration-(--motion-fast) hover:border-accent/40 hover:bg-surface-hover"
                        >
                          <span className="font-mono text-xs text-ink">{phoneNumber}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                            {[available.locality, available.region].filter(Boolean).join(', ') ||
                              available.isoCountry}
                          </span>
                          <span className="text-xs text-ink-muted">
                            ${(available.monthlyCostCents / 100).toFixed(2)}/mo
                          </span>
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={purchase.isPending}
                            onClick={() => {
                              purchase.mutate(phoneNumber);
                            }}
                          >
                            Buy
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
            {purchase.isError && <ErrorText error={purchase.error} />}
          </form>
        </section>
      )}

      {dialog}
    </div>
  );
}
