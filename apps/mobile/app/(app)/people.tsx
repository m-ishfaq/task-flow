import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from '../../src/lib/app-session.js';
import { apiErrorOf } from '../../src/lib/trpc-client.js';
import { useTopInset } from '../../src/lib/use-top-inset.js';
import { Avatar } from '../../src/lib/avatar.js';
import {
  DIRECTORY_QUERY_KEY,
  directoryLabel,
  oooStatus,
  type DirectoryMember,
} from '../../src/lib/people.js';

/**
 * The org directory — `apps/web/src/features/people/people-page.tsx`'s
 * counterpart. A sibling of `automations.tsx`/`account.tsx` under `(app)/`,
 * pushed from `account.tsx`'s "People" link rather than a `(tabs)/
 * _layout.tsx` tab — it lived there originally, moved out the same pass
 * that gave its tab slot to Docs. `(tabs)/_layout.tsx`'s own header has
 * the full reasoning: Docs is something people browse and drill into the
 * way My Tasks/Boards/Chat/Calls already are, while the org directory is
 * closer to a lookup — you go there to find one person, not to browse it
 * between other work — so it is the one existing tab that loses the least
 * by becoming a link instead of staying a swipeable destination. Nothing
 * about the screen's own content changed in the move; it gained only the
 * back button every other pushed screen under `(app)/` already draws.
 *
 * `useInfiniteQuery`, this app's first when it shipped — everywhere else
 * on this app either fetches the whole list in one shot (`work.cards
 * .list`, `tenancy.members.list`) or walks every page eagerly client-side
 * (`telephony-contact-picker.tsx`, capped at 1,000 rows for a dropdown
 * nobody reads past). A directory a person actually SCROLLS THROUGH is
 * the one place an unbounded org genuinely needs real pagination rather
 * than either shortcut — the cursor is a user id (`directory.list`'s own
 * doc: creation-ordered, a total order with no ties), and a "Load more"
 * button at the bottom appends the next page rather than an auto-loading
 * `onEndReached`, matching web's own choice not to spend network on a
 * scroll nobody asked for.
 *
 * Nothing here re-derives authorization (CLAUDE.md §8.2): `member:read`
 * decides who sees rows, and a caller without it gets an empty first page,
 * never an error card.
 */
export default function PeopleScreen() {
  const paddingTop = useTopInset();

  const directory = useInfiniteQuery({
    queryKey: DIRECTORY_QUERY_KEY,
    queryFn: async ({ pageParam }: { pageParam: string | null }) =>
      wire(
        await apiClient.people.directory.list.query({
          ...(pageParam === null ? {} : { cursor: pageParam }),
          limit: 50,
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const rows = directory.data?.pages.flatMap((page) => page.members) ?? [];

  return (
    <View style={[styles.container, { paddingTop }]}>
      <Pressable
        style={styles.backButton}
        onPress={() => {
          router.back();
        }}
      >
        <Text style={styles.backButtonText}>← Back</Text>
      </Pressable>
      <Text style={styles.title}>People</Text>
      <Text style={styles.subtitle}>
        Everyone in this organization, with their profile, role, and who they report to.
      </Text>

      {directory.isPending && (
        <ActivityIndicator style={styles.loading} color={colors.accent.hex} />
      )}
      {directory.isError && (
        <Text style={styles.errorText}>
          {apiErrorOf(directory.error)?.error.message ?? 'Could not load the directory.'}
        </Text>
      )}
      {directory.isSuccess && rows.length === 0 && (
        <Text style={styles.emptyHint}>
          Members appear here as soon as they join the organization.
        </Text>
      )}

      <FlatList<DirectoryMember>
        data={rows}
        keyExtractor={(member) => member.userId}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => <PersonRow member={item} />}
        ListFooterComponent={
          directory.hasNextPage ? (
            <Pressable
              style={styles.loadMoreButton}
              disabled={directory.isFetchingNextPage}
              onPress={() => {
                void directory.fetchNextPage();
              }}
            >
              {directory.isFetchingNextPage ? (
                <ActivityIndicator color={colors.accent.hex} />
              ) : (
                <Text style={styles.loadMoreText}>Load more</Text>
              )}
            </Pressable>
          ) : null
        }
      />
    </View>
  );
}

function PersonRow({ member }: { readonly member: DirectoryMember }) {
  const label = directoryLabel(member);
  const ooo = oooStatus(member.oooFrom, member.oooUntil);

  return (
    <Pressable
      style={styles.row}
      onPress={() => {
        router.push(`/person/${member.userId}`);
      }}
    >
      <Avatar label={label} size={36} />
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.rowEmail} numberOfLines={1}>
          {member.email}
        </Text>
      </View>
      {ooo && (
        <View style={styles.oooBadge}>
          <Text style={styles.oooBadgeText}>OOO</Text>
        </View>
      )}
      <View style={styles.roleBadge}>
        <Text style={styles.roleBadgeText}>{member.role}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 4,
    marginLeft: 24,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
    paddingHorizontal: 24,
  },
  subtitle: {
    paddingHorizontal: 24,
    marginTop: 2,
    marginBottom: 10,
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  loading: {
    marginTop: 12,
  },
  errorText: {
    fontSize: 13,
    color: colors.danger.hex,
    paddingHorizontal: 24,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.inkFaint.hex,
    paddingHorizontal: 24,
  },
  list: {
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  rowText: {
    flex: 1,
    gap: 1,
  },
  rowName: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  rowEmail: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  oooBadge: {
    backgroundColor: colors.warning.hex + '26',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  oooBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.warning.hex,
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
  loadMoreButton: {
    alignSelf: 'center',
    marginTop: 14,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  loadMoreText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
});
