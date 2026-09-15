import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { useSession } from '../../lib/session.js';
import { keys, resetCache } from '../../lib/query.js';
import { Badge, Button, Field, Input, SkeletonRows } from '../../components/primitives.js';
import { BrandMark } from '../../components/brand-mark.js';
import { ErrorView } from '../../components/error-view.js';
import { orgsQuery } from './api.js';

/**
 * Choosing — or creating — an organization.
 *
 * This is the one page that works with no org selected, which is why
 * `tenancy.orgs.list` is a `selfRoute` rather than a permissioned one: asking
 * "which orgs am I in?" cannot require having already answered it. On the server
 * that query runs under `withUserScope`, whose two policies are `FOR SELECT`
 * with no `WITH CHECK` — see the Phase 2 notes in CLAUDE.md.
 *
 * ## Two states, and they need opposite layouts
 *
 * Someone with no organizations needs a form; someone with four needs a list and
 * would rather not scroll past a form to reach it. The create panel is therefore
 * COLLAPSED behind a button when orgs exist and expanded when none do — same
 * component, and the decision is made from the data rather than by the person
 * arriving on a page that is mostly empty either way.
 */

interface CreateValues {
  name: string;
  slug: string;
}

export function OrgPickerPage() {
  const orgs = useQuery(orgsQuery());

  /* The same probe the account menu runs, for the one person this page is a
     DEAD END for: a platform operator who belongs to no org.
     `/` redirects them here (orgId is null), and everything on this page is
     about joining or creating a tenant — while the console they actually came
     for sits behind `requireSession` and is perfectly reachable, just
     unlinked. Wave 1's own design makes org membership and operator power
     unrelated, so an operator with zero orgs is a state the product intends,
     not an accident to route around.

     Server-answered, never inferred: `self.check` is the same selfRoute the
     shell uses, and the page behind the link still refuses non-operators. */
  const isOperator = useQuery({
    queryKey: keys.platformSelf(),
    queryFn: async () => (await api.platformAdmin.self.check.query(undefined)).isOperator,
  });
  const selectOrg = useSession((state) => state.selectOrg);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const choose = (orgId: OrgId) => {
    selectOrg(orgId);
    resetCache(queryClient);
    void navigate({ to: '/projects' });
  };

  if (orgs.isPending) {
    return (
      <div className="mx-auto w-full max-w-xl p-6">
        <SkeletonRows rows={3} className="*:h-16" />
      </div>
    );
  }

  if (orgs.isError) {
    return (
      <div className="mx-auto max-w-xl p-6">
        <ErrorView error={orgs.error} title="Could not load your organizations" />
      </div>
    );
  }

  const isEmpty = orgs.data.length === 0;

  return (
    <div className="h-full min-h-0 overflow-y-auto mx-auto flex w-full max-w-lg flex-col gap-6 p-8">
      <div className="flex items-center gap-3">
        <BrandMark size={36} className="text-accent" />
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
            {isEmpty ? 'Create your first organization' : 'Choose an organization'}
          </h1>
          <p className="mt-0.5 text-xs text-ink-muted">
            {isEmpty
              ? 'An organization owns its own projects, members and audit trail. You become its owner.'
              : 'Everything you see afterwards belongs to the one you pick.'}
          </p>
        </div>
      </div>

      {isOperator.data === true && (
        <Link
          to="/platform-admin"
          className="flex items-center gap-3 rounded-lg border border-line bg-surface-raised p-3 transition-colors hover:border-accent/40 hover:bg-surface-hover"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink">Platform console</span>
            <span className="block text-[11px] text-ink-faint">
              Operator tools — organizations, users, plans and the operator audit log.
            </span>
          </span>
          <span aria-hidden="true" className="text-ink-faint">
            &rarr;
          </span>
        </Link>
      )}

      <CreateOrgPanel startOpen={isEmpty} onCreated={choose} />

      {!isEmpty && (
        <ul className="space-y-2">
          {orgs.data.map((org) =>
            org.orgStatus === 'active' && org.membershipStatus === 'active' ? (
              <li key={org.orgId}>
                <button
                  type="button"
                  onClick={() => {
                    choose(org.orgId as OrgId);
                  }}
                  className="group flex w-full items-center gap-3 rounded-lg border border-line bg-surface-raised p-3 text-left shadow-sm transition-colors hover:border-accent/40 hover:bg-surface-hover"
                >
                  <OrgMark name={org.name} />

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{org.name}</span>
                    <span className="block truncate font-mono text-[11px] text-ink-faint">
                      {org.slug}
                    </span>
                  </span>

                  <Badge>{org.role}</Badge>
                  <span
                    aria-hidden="true"
                    className="text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink-muted"
                  >
                    &rarr;
                  </span>
                </button>
              </li>
            ) : (
              // Shown, not omitted — the identical fix `OrgGate`'s own header
              // documents for the currently-selected case, applied here so a
              // suspended membership never simply vanishes from this list the
              // way it used to (indistinguishable from an org this account was
              // never part of at all). Not a `<button>`: there is nothing to
              // do here besides know why it's not clickable.
              //
              // Org status is checked FIRST — the same "the bigger fact wins"
              // rule OrgGate applies — since a suspended ORG (Phase 12 Wave
              // 1's platform console) used to show here as an ordinary,
              // clickable row: `membershipStatus` alone said nothing about
              // it, and clicking through only failed on the NEXT screen.
              <li
                key={org.orgId}
                className="flex w-full items-center gap-3 rounded-lg border border-dashed border-line/60 bg-surface-sunken/40 p-3 opacity-70"
              >
                <OrgMark name={org.name} />

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink-muted">
                    {org.name}
                  </span>
                  <span className="block truncate text-[11px] text-ink-faint">
                    {org.orgStatus !== 'active'
                      ? 'This organization has been suspended'
                      : 'Your membership is suspended'}
                  </span>
                </span>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * The square with an initial in it.
 *
 * Deliberately not `Avatar`: that one hues from a USER id and is documented as
 * keeping one person one colour everywhere. An org is not a person, and feeding
 * an org id into it would mint a second meaning for the same visual language.
 */
function OrgMark({ name }: { readonly name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-sm font-semibold text-ink-muted"
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

function CreateOrgPanel({
  startOpen,
  onCreated,
}: {
  readonly startOpen: boolean;
  readonly onCreated: (orgId: OrgId) => void;
}) {
  const [open, setOpen] = useState(startOpen);

  if (!open) {
    return (
      <Button
        variant="ghost"
        className="justify-start border border-dashed border-line text-ink-muted hover:text-ink"
        onClick={() => {
          setOpen(true);
        }}
      >
        + New organization
      </Button>
    );
  }

  return (
    <CreateOrgForm
      onCreated={onCreated}
      onCancel={
        startOpen
          ? null
          : () => {
              setOpen(false);
            }
      }
    />
  );
}

function CreateOrgForm({
  onCreated,
  onCancel,
}: {
  readonly onCreated: (orgId: OrgId) => void;
  /** Null when there is nothing to go back to — a first org is not optional. */
  readonly onCancel: (() => void) | null;
}) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, setValue } = useForm<CreateValues>({
    defaultValues: { name: '', slug: '' },
  });

  const create = useMutation({
    mutationFn: (values: CreateValues) => api.tenancy.orgs.create.mutate(values),
    onSuccess: async (result) => {
      /* The §6 bootstrap offer (ai/phase-15-ai-copilot-and-permissions.md §6)
         needs no trigger set here any more — `setup-dialog.tsx`'s own header
         explains why: it now gates on whether `docs.spaces.list` is empty,
         which a freshly created org obviously satisfies with no flag at all. */
      await queryClient.invalidateQueries({ queryKey: keys.orgs() });
      onCreated(result.orgId as OrgId);
    },
  });

  return (
    <form
      className="space-y-3 rounded-lg border border-dashed border-line bg-surface-sunken/60 p-3"
      onSubmit={(event) => {
        void handleSubmit((values) => {
          create.mutate(values);
        })(event);
      }}
    >
      <Field label="Name" htmlFor="org-name">
        <Input
          id="org-name"
          placeholder="Acme Corp"
          {...register('name', {
            required: true,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              /* The slug follows the name until someone edits it. Derived on
                 the client purely as a convenience — the server has its own
                 `Slug` schema and a unique index, and both still decide. */
              setValue('slug', slugify(event.target.value), { shouldDirty: false });
            },
          })}
        />
      </Field>

      <Field
        label="Slug"
        htmlFor="org-slug"
        hint="Used in URLs. Derived from the name; edit it if you want something else."
      >
        <Input id="org-slug" className="font-mono" {...register('slug', { required: true })} />
      </Field>

      {create.isError && <ErrorView error={create.error} />}

      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
        {onCancel !== null && (
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
