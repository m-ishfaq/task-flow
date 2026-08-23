import { Fragment, type ReactNode } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { colors } from '@taskflow/tokens';
import { sanitizeRichText, type SanitizedMark, type SanitizedNode } from './rich-text.js';

/**
 * The second pass of §6.4's native renderer — see `rich-text.ts`'s header
 * for the split. Everything reaching `renderBlock`/`renderInline` below has
 * already passed `sanitizeRichText`'s whitelist walk, so this file does no
 * validation of its own: it is a plain `switch` on `SanitizedNode['type']`,
 * exactly the shape §6.4 specifies ("a switch on node type... it never
 * touches an HTML parser"). An unrecognized type cannot actually reach here
 * — the sanitizer already dropped it — but the `default: return null` case
 * is kept anyway as the same defensive floor the rest of this codebase
 * applies at a trust boundary even when a caller "can't" send the bad case.
 *
 * Marks are applied innermost-first by nesting `<Text>` — React Native's
 * documented way to combine inline styles — with `link` applied outermost
 * so its `onPress` wraps every other mark's styling. `Linking.openURL` is
 * only ever called with a `href` that survived `MarkSchema`'s scheme check
 * inside the sanitizer; nothing here re-parses or re-validates it, because
 * by the time a `link` mark exists on a `SanitizedMark` it already has.
 */

export function RichTextView({ document }: { document: unknown }): ReactNode {
  const doc = sanitizeRichText(document);
  if (!doc?.content?.length) return null;
  return (
    <View style={styles.root}>
      {doc.content.map((node, index) => (
        <Fragment key={index}>{renderBlock(node)}</Fragment>
      ))}
    </View>
  );
}

function renderBlock(node: SanitizedNode): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <Text style={styles.paragraph}>{renderInlineChildren(node)}</Text>;

    case 'heading': {
      const level = typeof node.attrs?.['level'] === 'number' ? node.attrs['level'] : 1;
      return (
        <Text style={[styles.paragraph, headingStyle(level)]}>{renderInlineChildren(node)}</Text>
      );
    }

    case 'blockquote':
      return (
        <View style={styles.blockquote}>
          {(node.content ?? []).map((child, index) => (
            <Fragment key={index}>{renderBlock(child)}</Fragment>
          ))}
        </View>
      );

    case 'codeBlock':
      return (
        <View style={styles.codeBlock}>
          <Text style={styles.code}>{flattenText(node)}</Text>
        </View>
      );

    case 'horizontalRule':
      return <View style={styles.hr} />;

    case 'bulletList':
      return (
        <View style={styles.list}>
          {(node.content ?? []).map((item, index) => (
            <ListItemRow key={index} marker="•">
              {item}
            </ListItemRow>
          ))}
        </View>
      );

    case 'orderedList': {
      const start = typeof node.attrs?.['start'] === 'number' ? node.attrs['start'] : 1;
      return (
        <View style={styles.list}>
          {(node.content ?? []).map((item, index) => (
            <ListItemRow key={index} marker={`${String(start + index)}.`}>
              {item}
            </ListItemRow>
          ))}
        </View>
      );
    }

    case 'taskList':
      return (
        <View style={styles.list}>
          {(node.content ?? []).map((item, index) => (
            <ListItemRow key={index} marker={item.attrs?.['checked'] === true ? '☑' : '☐'}>
              {item}
            </ListItemRow>
          ))}
        </View>
      );

    default:
      // `doc`, `listItem`, `taskItem` are only ever reached as a direct
      // child handled by their own container above; any other type was
      // already excluded by the sanitizer.
      return null;
  }
}

function ListItemRow({ marker, children }: { marker: string; children: SanitizedNode }): ReactNode {
  return (
    <View style={styles.listRow}>
      <Text style={styles.listMarker}>{marker}</Text>
      <View style={styles.listContent}>
        {(children.content ?? []).map((child, index) => (
          <Fragment key={index}>{renderBlock(child)}</Fragment>
        ))}
      </View>
    </View>
  );
}

function renderInlineChildren(node: SanitizedNode): ReactNode {
  return (node.content ?? []).map((child, index) => (
    <Fragment key={index}>{renderInline(child)}</Fragment>
  ));
}

function renderInline(node: SanitizedNode): ReactNode {
  switch (node.type) {
    case 'text':
      return applyMarks(node.text ?? '', node.marks ?? []);

    case 'hardBreak':
      return '\n';

    case 'mention':
      return <Text style={styles.mention}>@{labelOf(node)}</Text>;

    case 'pageLink':
      return <Text style={styles.mention}>{labelOf(node)}</Text>;

    default:
      return null;
  }
}

/**
 * `mention`/`pageLink`'s `label` is required and string-typed by
 * `NODE_ATTRIBUTES` — see `richtext.ts` — so a node of either type that
 * reached `sanitizeNode` always has one; this only exists because
 * `SanitizedNode['attrs']` stays a structural `Record<string, unknown>`
 * rather than a per-type union, the same trade `RichTextNode`'s own header
 * makes for the identical reason.
 */
function labelOf(node: SanitizedNode): string {
  const label = node.attrs?.['label'];
  return typeof label === 'string' ? label : '';
}

function applyMarks(text: string, marks: readonly SanitizedMark[]): ReactNode {
  const link = marks.find((mark) => mark.type === 'link');
  const style: object[] = [];
  if (marks.some((mark) => mark.type === 'bold')) style.push(styles.bold);
  if (marks.some((mark) => mark.type === 'italic')) style.push(styles.italic);
  if (marks.some((mark) => mark.type === 'code')) style.push(styles.inlineCode);
  const decorations: string[] = [];
  if (marks.some((mark) => mark.type === 'strike')) decorations.push('line-through');
  if (marks.some((mark) => mark.type === 'underline')) decorations.push('underline');
  if (decorations.length > 0) {
    style.push({ textDecorationLine: decorations.join(' ') as 'line-through' | 'underline' });
  }
  if (link) style.push(styles.link);

  const href = typeof link?.attrs?.['href'] === 'string' ? link.attrs['href'] : undefined;

  return (
    <Text style={style} onPress={href !== undefined ? () => void Linking.openURL(href) : undefined}>
      {text}
    </Text>
  );
}

function flattenText(node: SanitizedNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(flattenText).join('');
}

function headingStyle(level: number): object {
  const sizes: Record<number, number> = { 1: 22, 2: 19, 3: 17, 4: 16, 5: 15, 6: 15 };
  return { fontSize: sizes[level] ?? 15, fontWeight: '700' };
}

const styles = StyleSheet.create({
  root: {
    gap: 8,
  },
  paragraph: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.ink.hex,
  },
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  inlineCode: {
    fontFamily: 'monospace',
    backgroundColor: colors.surfaceHover.hex,
  },
  link: {
    color: colors.accent.hex,
    textDecorationLine: 'underline',
  },
  mention: {
    color: colors.accent.hex,
    fontWeight: '600',
  },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.line.hex,
    paddingLeft: 10,
    gap: 8,
  },
  codeBlock: {
    backgroundColor: colors.surfaceHover.hex,
    borderRadius: 6,
    padding: 10,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: 13,
    color: colors.ink.hex,
  },
  hr: {
    height: 1,
    backgroundColor: colors.line.hex,
  },
  list: {
    gap: 4,
  },
  listRow: {
    flexDirection: 'row',
    gap: 8,
  },
  listMarker: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    minWidth: 16,
  },
  listContent: {
    flex: 1,
    gap: 4,
  },
});
