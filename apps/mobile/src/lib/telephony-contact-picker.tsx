import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient } from './app-session.js';
import { Avatar } from './avatar.js';
import { PHONE_CONTACTS_QUERY_KEY, type PhoneContact } from './telephony.js';

/**
 * Choosing WHO to call or text — the mobile counterpart of
 * `apps/web/src/features/telephony/contact-picker.tsx`.
 *
 * A destination is an E.164 string and always has been (`calls.place`/
 * `messages.send` both take `to`, never a user id), so this wraps a
 * free-text field rather than replacing it with a select — picking a
 * colleague FILLS the field, typing a number nobody in the org owns is
 * equally valid, and the field's own contents stay the single source of
 * truth for what gets dialled. The picker button opens a bottom-sheet
 * `Modal`, mirroring `org-settings.tsx`'s `RolePickerModal` shape rather
 * than a popover — this app has no anchored-popover primitive, and every
 * other picker here already uses this pattern.
 *
 * The list is `people.directory.list` filtered to members with a work
 * phone, walked page by page here rather than exposed as a server route —
 * see this file's own `PHONE_CONTACTS_QUERY_KEY` comment in `telephony.ts`.
 * A caller without `member:read` gets an empty list (FORBIDDEN, refused
 * once and not retried below) and the picker button simply does not
 * render — the field still works, since dialling a typed number never
 * needed the directory at all.
 */

const CONTACT_PAGE_LIMIT = 100;
const CONTACT_PAGE_CAP = 10;

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

export function TelephonyContactPicker({
  value,
  onChange,
  placeholder = '+14155550100',
}: {
  /** The E.164 destination — this component owns none of it. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
}): React.JSX.Element {
  const contacts = useQuery({
    queryKey: PHONE_CONTACTS_QUERY_KEY,
    queryFn: async (): Promise<readonly PhoneContact[]> => {
      const found: PhoneContact[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < CONTACT_PAGE_CAP; page += 1) {
        const result = wire(
          await apiClient.people.directory.list.query({
            ...(cursor === undefined ? {} : { cursor }),
            limit: CONTACT_PAGE_LIMIT,
          }),
        );

        for (const member of result.members) {
          // `?? ''` would put an empty string in the To field for a member
          // whose number was cleared — an enabled Call button dialling nothing.
          if (member.workPhone === null || member.workPhone === '') continue;
          found.push({
            userId: member.userId,
            label: member.displayName ?? member.email,
            email: member.email,
            phone: member.workPhone,
          });
        }

        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }

      return found;
    },
    staleTime: 60_000,
    retry: false,
  });

  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');

  const people = contacts.data ?? [];

  const typed = digitsOf(value);
  const matched =
    typed === '' ? undefined : people.find((person) => digitsOf(person.phone) === typed);

  const needle = query.trim().toLowerCase();
  const filtered =
    needle === ''
      ? people
      : people.filter(
          (person) =>
            person.label.toLowerCase().includes(needle) ||
            person.email.toLowerCase().includes(needle) ||
            digitsOf(person.phone).includes(digitsOf(needle)),
        );

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.inkFaint.hex}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="phone-pad"
        />
        {people.length > 0 && (
          <Pressable
            style={styles.pickerButton}
            accessibilityLabel="Choose a person"
            onPress={() => {
              setQuery('');
              setPickerOpen(true);
            }}
          >
            <Text style={styles.pickerButtonText}>👤 ▾</Text>
          </Pressable>
        )}
      </View>

      {matched !== undefined && (
        <View style={styles.matchedRow}>
          <Avatar label={matched.label} size={16} />
          <Text style={styles.matchedText} numberOfLines={1}>
            {matched.label}
          </Text>
        </View>
      )}

      <Modal
        visible={pickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setPickerOpen(false);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setPickerOpen(false);
          }}
        >
          <Pressable style={styles.modalCard} onPress={() => undefined}>
            <Text style={styles.modalTitle}>Choose a person</Text>
            {people.length > 8 && (
              <TextInput
                style={styles.modalSearchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Search people…"
                placeholderTextColor={colors.inkFaint.hex}
                autoCapitalize="none"
              />
            )}
            {filtered.length === 0 ? (
              <Text style={styles.emptyHint}>No matches.</Text>
            ) : (
              <ScrollableList>
                {filtered.map((person) => (
                  <Pressable
                    key={person.userId}
                    style={styles.modalRow}
                    onPress={() => {
                      onChange(person.phone);
                      setPickerOpen(false);
                    }}
                  >
                    <Avatar label={person.label} size={20} />
                    <View style={styles.modalRowText}>
                      <Text style={styles.modalRowName} numberOfLines={1}>
                        {person.label}
                      </Text>
                      <Text style={styles.modalRowPhone} numberOfLines={1}>
                        {person.phone}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollableList>
            )}
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setPickerOpen(false);
              }}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/** A capped-height scroll region for the picker list — its own tiny
 *  component only so the `maxHeight` style lives in one place rather than
 *  duplicated at every caller. */
function ScrollableList({ children }: { readonly children: React.ReactNode }) {
  return <View style={styles.modalList}>{children}</View>;
}

const styles = StyleSheet.create({
  wrap: {
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  pickerButton: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  pickerButtonText: {
    fontSize: 13,
    color: colors.inkMuted.hex,
  },
  matchedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  matchedText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    flexShrink: 1,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 6,
    borderTopRightRadius: radiusCard + 6,
    padding: 20,
    gap: 8,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  modalSearchInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  emptyHint: {
    fontSize: 13,
    color: colors.inkFaint.hex,
    paddingVertical: 8,
  },
  modalList: {
    maxHeight: 320,
    gap: 2,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  modalRowText: {
    flex: 1,
    gap: 1,
  },
  modalRowName: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  modalRowPhone: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  modalCancel: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
