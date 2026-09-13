import { StyleSheet } from 'react-native';
import { colors, radiusCard } from '@taskflow/tokens';

export const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
  },
  commentRow: {
    gap: 4,
  },
  commentBubble: {
    backgroundColor: colors.surfaceHover.hex + '60',
    borderRadius: radiusCard,
    padding: 12,
  },
  commentMeta: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  commentAuthor: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  commentTime: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  commentDeleted: {
    fontSize: 13,
    fontStyle: 'italic',
    color: colors.inkFaint.hex,
  },
  commentThread: {
    gap: 8,
  },
  commentReply: {
    gap: 4,
    marginLeft: 16,
    paddingLeft: 10,
    paddingVertical: 8,
    paddingRight: 8,
    borderLeftWidth: 2,
    borderLeftColor: colors.accent.hex + '60',
    backgroundColor: colors.surfaceSunken.hex + '80',
    borderRadius: radiusCard,
  },
  commentActions: {
    flexDirection: 'row',
    gap: 14,
  },
  commentActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  editRow: {
    gap: 6,
  },
  editInput: {
    borderWidth: 1,
    borderColor: colors.accent.hex,
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  editActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  editCancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  editSaveButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  editSaveText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  mentionList: {
    maxHeight: 180,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    marginTop: 4,
  },
  mentionRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  mentionRowText: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  composerRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-end',
    marginTop: 4,
  },
  composerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  content: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 12,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    backgroundColor: colors.surface.hex,
  },
  backButton: {
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  reference: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    fontVariant: ['tabular-nums'],
  },
  titleRow: {
    gap: 8,
  },
  titleInput: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.ink.hex,
    padding: 0,
  },
  saveButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  saveButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  dateRow: {
    flexDirection: 'row',
    gap: 12,
  },
  dateField: {
    flex: 1,
    gap: 4,
  },
  dateLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  descriptionInput: {
    minHeight: 80,
    textAlignVertical: 'top',
  },
  // Content container for `ChipScroll`'s `ScrollView` — `alignItems:
  // 'flex-start'`, not the old `priorityRow`'s `flexWrap: 'wrap'`, is what
  // stops each chip stretching to the frame's height (`board/[boardId]
  // .tsx`'s `tabStrip`, mirrored here — see `ChipScroll`'s own header).
  chipScroll: {
    alignItems: 'flex-start',
    gap: 6,
  },
  // The SCROLL VIEW's own frame, as opposed to its content — without
  // `flexGrow`/`flexShrink: 0` a horizontal ScrollView with no explicit
  // size sizes itself to fill the remaining flex space of the column
  // it sits in, one more time reusing `board/[boardId].tsx`'s own fix
  // rather than rediscovering it.
  chipScrollFrame: {
    flexGrow: 0,
    flexShrink: 0,
  },
  priorityChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  priorityChipActive: {
    borderColor: colors.accent.hex + '60',
    backgroundColor: colors.accent.hex + '10',
  },
  priorityChipText: {
    fontSize: 13,
    color: colors.ink.hex,
  },
  priorityChipDisabled: {
    opacity: 0.6,
  },
  // The card tile behind every `Section` — reuses `card-row.tsx`'s own
  // `card` style (border + `surfaceRaised`, one step lighter than this
  // screen's `surface` background) rather than inventing a second "this is
  // one distinct grouped thing" visual language. Was `sprintSection`, a
  // bare `{ gap: 6 }` with no visual boundary at all — the direct cause of
  // "we cannot distinguish what is what" (2026-08-22 device feedback).
  section: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 14,
    gap: 8,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.inkFaint.hex,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: colors.surfaceHover.hex + '80',
  },
  badgeOverdue: {
    backgroundColor: colors.danger.hex + '20',
    borderWidth: 1,
    borderColor: colors.danger.hex + '30',
  },
  swatch: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.inkMuted.hex,
  },
  badgeOverdueText: {
    color: colors.danger.hex,
  },
  badgeDoneText: {
    color: colors.success.hex,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
  error: {
    color: colors.danger.hex,
    fontSize: 14,
  },
  emptyHint: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  checklistGroup: {
    gap: 4,
    marginBottom: 8,
  },
  checklistHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  checklistName: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  checklistCount: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  checklistDeleteButton: {
    marginLeft: 'auto',
  },
  checklistDeleteText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  checklistItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 4,
    paddingVertical: 2,
  },
  checklistBox: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceSunken.hex,
  },
  checklistBoxDone: {
    backgroundColor: colors.accent.hex,
    borderColor: colors.accent.hex,
  },
  checklistBoxCheck: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.accentInk.hex,
  },
  checklistItemText: {
    flex: 1,
    fontSize: 13,
    color: colors.ink.hex,
  },
  checklistItemTextDone: {
    color: colors.inkFaint.hex,
    textDecorationLine: 'line-through',
  },
  checklistItemRemove: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    paddingHorizontal: 4,
  },
  checklistAddItemText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.hex,
    paddingLeft: 4,
    paddingVertical: 4,
  },
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  attachmentInfo: {
    flex: 1,
    gap: 2,
  },
  attachmentName: {
    fontSize: 13,
    color: colors.ink.hex,
  },
  attachmentStatus: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  attachmentStatusDanger: {
    color: colors.danger.hex,
  },
  attachmentStatusWarning: {
    color: colors.warning.hex,
  },
  assigneeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  assigneeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 8,
    backgroundColor: colors.surfaceHover.hex,
  },
  assigneeChipText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
    maxWidth: 120,
  },
  addChipButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
  },
  addChipButtonText: {
    fontSize: 14,
    color: colors.inkMuted.hex,
  },
  labelChip: {
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  labelChipOff: {
    backgroundColor: colors.surfaceHover.hex,
  },
  labelChipText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  labelChipTextOn: {
    color: '#ffffff',
    fontWeight: '600',
  },
  addCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addCardInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  addCardButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  addCardButtonText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay.hex + '99',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard,
    borderTopRightRadius: radiusCard,
    padding: 20,
    gap: 4,
    maxHeight: '80%',
  },
  modalTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
    marginBottom: 8,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
    marginBottom: 8,
  },
  pickerList: {
    marginBottom: 8,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  pickerRowText: {
    flex: 1,
    fontSize: 14,
    color: colors.ink.hex,
  },
  pickerCheck: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.accent.hex,
  },
  modalCancel: {
    paddingVertical: 14,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  modalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  modalPrimaryButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  modalPrimaryButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  modalSecondaryButton: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  modalSecondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  fieldRow: {
    gap: 4,
    marginBottom: 8,
  },
  fieldName: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  fieldInputWrap: {
    minHeight: 28,
    justifyContent: 'center',
  },
  addFieldForm: {
    gap: 8,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    padding: 10,
  },
});
