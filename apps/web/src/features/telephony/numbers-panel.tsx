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
  Section,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { invalidatePhoneNumbers, phoneNumbersQuery, type AvailableNumber } from './api.js';

/**
 * Phone number provisioning (ai/phase-7-voice.md §3.1, Wave 2).
 *
 * Buying and releasing are both `phoneNumber:purchase`/`release` — Owner-only
 * AND step-up server-side (`router.ts`) — but the buttons render for every
 * viewer regardless of role. A Member's click comes back FORBIDDEN through
 * the ordinary toast path; nothing here re-checks the role first (§8.2).
 */

export function NumbersPanel({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { guard, dialog } = useStepUp();
  const numbers = useQuery(phoneNumbersQuery(orgId));

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
    <div className="space-y-6">
      <Section title="This org's numbers" count={numbers.data?.length}>
        {numbers.isPending ? (
          <SkeletonRows rows={2} />
        ) : numbers.isError ? (
          <ErrorView error={numbers.error} title="Could not load phone numbers" />
        ) : numbers.data.length === 0 ? (
          <Empty title="No numbers yet" description="Search below to buy the org's first one." />
        ) : (
          <ul className="space-y-1">
            {numbers.data.map((number) => (
              <li
                key={number.phoneNumberId}
                className="flex items-center gap-2 rounded border border-line px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-ink">{String(number.e164)}</p>
                  <p className="text-[11px] text-ink-faint">
                    {number.isoCountry} · bought {formatDate(number.purchasedAt)}
                  </p>
                </div>
                <ConfirmButton
                  label="Release"
                  confirmLabel="Release this number"
                  disabled={release.isPending}
                  onConfirm={() => {
                    release.mutate(number.phoneNumberId);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        {release.isError && <ErrorText error={release.error} />}
      </Section>

      <Section title="Buy a number" description="Twilio test credentials — no real charge.">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            search.mutate();
          }}
        >
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
          <Button type="submit" disabled={search.isPending}>
            Search
          </Button>
        </form>

        {search.isError && <ErrorText error={search.error} />}

        {results !== null && (
          <ul className="mt-3 space-y-1">
            {results.length === 0 && (
              <p className="text-xs text-ink-muted">No numbers matched that search.</p>
            )}
            {results.map((available) => {
              const phoneNumber = String(available.phoneNumber);
              return (
                <li
                  key={phoneNumber}
                  className="flex items-center gap-2 rounded border border-line px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-ink">{phoneNumber}</p>
                    <p className="text-[11px] text-ink-faint">
                      {[available.locality, available.region].filter(Boolean).join(', ') ||
                        available.isoCountry}{' '}
                      · ${(available.monthlyCostCents / 100).toFixed(2)}/mo
                    </p>
                  </div>
                  <Button
                    size="sm"
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
        {purchase.isError && <ErrorText error={purchase.error} />}
      </Section>

      {dialog}
    </div>
  );
}
