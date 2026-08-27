import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { colors } from '@taskflow/tokens';
import { useTopInset } from '../../src/lib/use-top-inset.js';
import { RuleEditor } from '../../src/lib/automation-editor.js';
import { AUTOMATIONS_QUERY_KEY, type AutomationSummary } from '../../src/lib/automation.js';

/**
 * Create/edit a rule — a flat (non-dynamic) sibling of `account.tsx` and
 * `org-settings.tsx` under `(app)/`, taking an OPTIONAL `automationId`
 * search param rather than a `[dynamic]` segment, because create mode has
 * no id to put in one. `automations.tsx`'s "+ New rule" button pushes here
 * with no params; a `RuleRow`'s "Edit" button (shown only when
 * `canEditOnMobile` says yes) pushes here with one.
 *
 * ## No `automation.get` route, so this reads the LIST's own cache
 *
 * The automation router has `list`/`create`/`update`/`setEnabled`/`delete`/
 * `runs` — no single-rule read. Re-fetching a page to find one row would
 * work but is pure overhead: whoever navigates here just tapped "Edit" on
 * a row `automations.tsx`'s own `useInfiniteQuery` already pulled down
 * under `AUTOMATIONS_QUERY_KEY`, and that data is sitting in the SAME
 * `QueryClient` this screen shares. `queryClient.getQueryData` walks that
 * cached `InfiniteData` shape directly — no network call, and it can only
 * ever miss if the cache was cleared between the tap and this screen
 * mounting, which the error state below handles honestly rather than
 * crashing on a `find` that returned `undefined`.
 */
export default function AutomationEditorScreen() {
  const paddingTop = useTopInset();
  const params = useLocalSearchParams<{ automationId?: string }>();
  const queryClient = useQueryClient();

  const initial = findCachedRule(
    queryClient.getQueryData(AUTOMATIONS_QUERY_KEY),
    params.automationId,
  );
  const notFound = params.automationId !== undefined && initial === undefined;

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
      <Text style={styles.title}>
        {params.automationId === undefined ? 'New automation' : 'Edit automation'}
      </Text>

      {notFound ? (
        <Text style={styles.errorText}>
          Could not find this rule — go back to Automations and try again.
        </Text>
      ) : (
        <RuleEditor
          {...(initial === undefined ? {} : { initial })}
          onDone={() => {
            router.back();
          }}
          onCancel={() => {
            router.back();
          }}
        />
      )}
    </View>
  );
}

function findCachedRule(
  cached: unknown,
  automationId: string | undefined,
): AutomationSummary | undefined {
  if (automationId === undefined) return undefined;
  const data = cached as InfiniteData<{ automations: readonly AutomationSummary[] }> | undefined;
  return data?.pages
    .flatMap((page) => page.automations)
    .find((rule) => rule.automationId === automationId);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    backgroundColor: colors.surface.hex,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.3,
    marginBottom: 8,
  },
  errorText: {
    fontSize: 13,
    color: colors.danger.hex,
    marginTop: 12,
  },
});
