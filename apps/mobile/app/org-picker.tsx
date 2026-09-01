import { useState } from 'react';
import { Redirect, router } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgId } from '@taskflow/contracts';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, session } from '../src/lib/app-session.js';
import { apiErrorOf } from '../src/lib/trpc-client.js';
import { useSession } from '../src/lib/use-session.js';
import { useTopInset } from '../src/lib/use-top-inset.js';
import { slugify } from '../src/lib/org-picker.js';

/**
 * Shown when `(app)/_layout.tsx`'s org gate found no valid remembered
 * selection (ai/phase-14-mobile.md §7). `tenancy.orgs.list` is the same
 * `selfRoute` the gate itself calls — TanStack Query serves it from cache
 * under the identical query key, so picking an org costs nothing extra here.
 *
 * Deliberately a TOP-LEVEL route, not nested under `(app)/` alongside
 * `home.tsx` — mirroring `apps/web/src/router.tsx`'s `/orgs` route, which
 * takes `requireSession` (auth only) rather than `requireOrg`. It was
 * originally nested under `(app)/`, and a real run found the bug that
 * placement causes: `(app)/_layout.tsx`'s gate unconditionally redirects to
 * `/org-picker` whenever `orgId` is null, and a route inside `(app)/` is
 * still wrapped by that same layout — so landing on `/org-picker` re-ran the
 * gate, found `orgId` still null, and redirected to `/org-picker` again,
 * forever ("Maximum update depth exceeded"). Living outside `(app)/` is what
 * lets the redirect actually be an ESCAPE from the gate rather than a route
 * the gate still governs. Auth (not org membership) is still required here,
 * so it carries its own minimal guard below rather than inheriting one.
 *
 * ## A real redesign, not a cosmetic pass — this screen had no way to
 * CREATE an organization at all
 *
 * Ported from `apps/web/src/features/org/org-picker-page.tsx`, which is a
 * genuinely different screen depending on whether the caller belongs to any
 * organization yet — someone with none needs a form, someone with several
 * would rather not scroll past one. `CreateOrgPanel` below makes the same
 * call web does: collapsed behind a dashed "+ New organization" button when
 * orgs exist, expanded with no cancel option when the list is empty — a
 * first organization is not optional, so there is nothing to cancel back to.
 * `tenancy.orgs.create` is a `selfRoute` for the reason its own header
 * states: a caller in no organization has no role, so no org permission can
 * describe what a first org's creation would need.
 *
 * The org rows themselves gained the visual hierarchy the old version never
 * had — a plain `<Text>` name and role with no separation, no slug, no
 * affordance suggesting the row was tappable at all. `OrgMark` (a square
 * initial, deliberately NOT `Avatar` — that component hues from a USER id,
 * and an organization is not a person) plus the slug and a trailing chevron
 * now match the rest of this app's list-row convention (`people.tsx`'s
 * `PersonRow`, `(tabs)/calls.tsx`'s number rows).
 *
 * **Sign out was a full-width, danger-red bordered button sitting directly
 * under the org list — the same visual weight as a warning, for an action
 * nobody reaches for by mistake and everybody reaches for rarely.** It
 * existed at all because this screen has no shell to fall back on (it lives
 * outside `(app)/`, so `top-bar.tsx`'s Account icon is not mounted here) —
 * someone belonging to zero organizations used to land with nothing else to
 * press. Kept for the identical reason, restyled to match its actual
 * priority: a small, quiet text link below everything else, not a box that
 * competes with "Choose an organization" for attention.
 */
export default function OrgPicker() {
  const status = useSession((state) => state.status);
  if (status !== 'authenticated') return <Redirect href="/sign-in" />;

  return <OrgPickerContent />;
}

function OrgPickerContent() {
  const paddingTop = useTopInset();
  const orgs = useQuery({
    queryKey: ['tenancy.orgs.list'],
    queryFn: () => apiClient.tenancy.orgs.list.query(),
    retry: false,
  });

  const choose = async (orgId: OrgId): Promise<void> => {
    // `selectOrg` only updates the store; nothing here is wrapped by a gate
    // that reacts to that change by itself, since this screen lives OUTSIDE
    // (app)/ (see this file's own header) — and even nested, a re-render
    // swapping `<Redirect>` for `<Slot />` would still show whatever route is
    // ALREADY active, not navigate anywhere. A real run found exactly that:
    // picking an org visibly did nothing. `router.replace` is the actual
    // navigation, mirroring how `(auth)/_layout.tsx`'s own `<Redirect>` is
    // what moves a signed-in caller off `/sign-in` rather than assuming it
    // happens implicitly.
    await session.selectOrg(orgId);
    router.replace('/home');
  };

  if (orgs.isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent.hex} />
      </View>
    );
  }

  if (orgs.isError) {
    return (
      <View style={[styles.container, { paddingTop }]}>
        <Text style={styles.title}>Choose an organization</Text>
        <Text style={styles.errorText}>
          {apiErrorOf(orgs.error)?.error.message ?? 'Could not load your organizations.'}
        </Text>
        <SignOutLink />
      </View>
    );
  }

  const isEmpty = orgs.data.length === 0;

  return (
    <View style={[styles.container, { paddingTop }]}>
      <FlatList
        data={orgs.data}
        keyExtractor={(org) => org.orgId}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>
              {isEmpty ? 'Create your first organization' : 'Choose an organization'}
            </Text>
            <Text style={styles.subtitle}>
              {isEmpty
                ? 'An organization owns its own projects, members and audit trail. You become its owner.'
                : 'Everything you see afterwards belongs to the one you pick.'}
            </Text>
            <CreateOrgPanel
              startOpen={isEmpty}
              onCreated={(orgId) => {
                void choose(orgId);
              }}
            />
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => {
              void choose(item.orgId as OrgId);
            }}
          >
            <OrgMark name={item.name} />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.rowSlug} numberOfLines={1}>
                {item.slug}
              </Text>
            </View>
            <View style={styles.roleBadge}>
              <Text style={styles.roleBadgeText}>{item.role}</Text>
            </View>
            <Text style={styles.rowChevron}>›</Text>
          </Pressable>
        )}
        ListFooterComponent={<SignOutLink />}
      />
    </View>
  );
}

/** The square with an initial in it — deliberately not `Avatar`, which hues
 *  from a USER id; an organization is not a person, and feeding an org id
 *  into it would mint a second meaning for the same visual language.
 *
 *  Color is derived from the initial character's code-point mod the palette
 *  length — stable across renders, never stored, never random. */
const ORG_MARK_COLORS = [
  '#4F7FFA', '#7B61FF', '#0AB5A1', '#E86339', '#D4437C',
  '#2DA44E', '#C8742F', '#6B7280',
];

function OrgMark({ name }: { readonly name: string }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const color = ORG_MARK_COLORS[(initial.codePointAt(0) ?? 0) % ORG_MARK_COLORS.length] ?? '#6B7280';
  return (
    <View style={[styles.orgMark, { backgroundColor: color + '22', borderColor: color + '55' }]}>
      <Text style={[styles.orgMarkText, { color }]}>{initial}</Text>
    </View>
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
      <Pressable
        style={styles.newOrgButton}
        onPress={() => {
          setOpen(true);
        }}
      >
        <Text style={styles.newOrgButtonText}>+ New organization</Text>
      </Pressable>
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
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  const create = useMutation({
    mutationFn: (values: { name: string; slug: string }) =>
      apiClient.tenancy.orgs.create.mutate(values),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['tenancy.orgs.list'] });
      onCreated(result.orgId as OrgId);
    },
  });

  return (
    <View style={styles.createForm}>
      <Text style={styles.fieldLabel}>Name</Text>
      <TextInput
        style={styles.formInput}
        value={name}
        onChangeText={(value) => {
          setName(value);
          // The slug follows the name until someone edits it by hand.
          if (!slugTouched) setSlug(slugify(value));
        }}
        placeholder="Acme Corp"
        placeholderTextColor={colors.inkFaint.hex}
        autoCapitalize="words"
      />

      <Text style={styles.fieldLabel}>Slug</Text>
      <TextInput
        style={[styles.formInput, styles.formInputMono]}
        value={slug}
        onChangeText={(value) => {
          setSlugTouched(true);
          setSlug(value);
        }}
        placeholder="acme-corp"
        placeholderTextColor={colors.inkFaint.hex}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.fieldHint}>
        Used in URLs. Derived from the name; edit it if you want something else.
      </Text>

      {create.isError && (
        <Text style={styles.errorText}>
          {apiErrorOf(create.error)?.error.message ?? 'This organization could not be created.'}
        </Text>
      )}

      <View style={styles.createFormActions}>
        <Pressable
          style={[
            styles.primaryButton,
            (create.isPending || name.trim() === '' || slug.trim() === '') && styles.buttonDisabled,
          ]}
          disabled={create.isPending || name.trim() === '' || slug.trim() === ''}
          onPress={() => {
            create.mutate({ name: name.trim(), slug: slug.trim() });
          }}
        >
          {create.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.primaryButtonText}>Create</Text>
          )}
        </Pressable>
        {onCancel !== null && (
          <Pressable style={styles.secondaryButton} onPress={onCancel}>
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** queryClient.clear() after signOut() — see account.tsx's own comment on this same pattern for why. */
function SignOutLink() {
  const queryClient = useQueryClient();
  return (
    <Pressable
      style={styles.signOutLink}
      onPress={() => {
        void session.signOut().then(() => {
          queryClient.clear();
        });
      }}
    >
      <Text style={styles.signOutLinkText}>Sign out</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface.hex,
  },
  list: {
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  header: {
    gap: 4,
    marginBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 13,
    color: colors.inkMuted.hex,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
    marginBottom: 10,
  },
  orgMark: {
    height: 44,
    width: 44,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orgMarkText: {
    fontSize: 16,
    fontWeight: '700',
  },
  rowText: {
    flex: 1,
    gap: 1,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  rowSlug: {
    fontSize: 11,
    color: colors.inkFaint.hex,
    fontFamily: 'monospace',
  },
  roleBadge: {
    backgroundColor: colors.surfaceSunken.hex,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  roleBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.inkMuted.hex,
    textTransform: 'capitalize',
  },
  rowChevron: {
    fontSize: 18,
    color: colors.inkFaint.hex,
  },
  newOrgButton: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 4,
  },
  newOrgButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  createForm: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceSunken.hex + '80',
    padding: 14,
    gap: 6,
    marginBottom: 4,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
    marginTop: 4,
  },
  formInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceRaised.hex,
  },
  formInputMono: {
    fontFamily: 'monospace',
  },
  fieldHint: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  errorText: {
    fontSize: 13,
    color: colors.danger.hex,
    marginTop: 4,
  },
  createFormActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  primaryButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  secondaryButton: {
    borderRadius: radiusCard,
    paddingVertical: 10,
    paddingHorizontal: 18,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  secondaryButtonText: {
    color: colors.ink.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  signOutLink: {
    alignSelf: 'center',
    marginTop: 20,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  signOutLinkText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.inkFaint.hex,
  },
});
