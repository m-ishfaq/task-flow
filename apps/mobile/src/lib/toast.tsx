import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import { colors, radiusCard } from '@taskflow/tokens';

interface ToastMessage {
  readonly id: number;
  readonly text: string;
  readonly kind: 'success' | 'error' | 'info';
}

type ToastListener = (msg: ToastMessage) => void;

const listeners = new Set<ToastListener>();
let nextId = 1;

/** Imperative API — call from anywhere, no provider needed. */
export const toast = {
  success: (text: string) => {
    emit({ id: nextId++, text, kind: 'success' });
  },
  error: (text: string) => {
    emit({ id: nextId++, text, kind: 'error' });
  },
  info: (text: string) => {
    emit({ id: nextId++, text, kind: 'info' });
  },
};

function emit(msg: ToastMessage) {
  listeners.forEach((fn) => {
    fn(msg);
  });
}

/** Drop this once anywhere in the tree (e.g. the root layout). Renders toasts above everything. */
export function ToastHost() {
  const [messages, setMessages] = useState<readonly ToastMessage[]>([]);

  useEffect(() => {
    const handler: ToastListener = (msg) => {
      setMessages((prev) => [...prev, msg]);
      setTimeout(() => {
        setMessages((prev) => prev.filter((m) => m.id !== msg.id));
      }, 3000);
    };
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  return (
    <>
      {messages.map((msg) => (
        <Toast
          key={msg.id}
          msg={msg}
          onDismiss={() => {
            setMessages((prev) => prev.filter((m) => m.id !== msg.id));
          }}
        />
      ))}
    </>
  );
}

function Toast({ msg, onDismiss }: { readonly msg: ToastMessage; readonly onDismiss: () => void }) {
  const translateY = useRef(new Animated.Value(80)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: 0, duration: 220, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
    ]).start();
  }, [opacity, translateY]);

  /* Found during the warm-dark rebuild's own raw-color-literal audit
     (ai/design-rebuild-warm-dark.md §4): the success branch was a bare
     '#22c55e' literal that had drifted from `colors.success.hex`
     ('#3bb974'), and the info/default branch used `colors.ink.hex` — the
     TEXT ink token, near-white by design in this dark-first app — as a
     BACKGROUND, which combined with the text's own former literal '#fff'
     made every info toast invisible (near-white on near-white). Each
     background now pairs with the ink actually verified (real WCAG math,
     not eyeballed) to read against it: `success` is light (L=70%) and
     needs a DARK ink (`surface.hex` measures 7.74:1); `danger` is mid
     (L=55%) and needs its own paired light ink (`dangerInk.hex`, 5.02:1);
     info/default uses a dark neutral surface (`surfaceRaised.hex`) with
     the app's ordinary light `ink.hex` (14.72:1) — the same
     dark-surface-plus-light-ink pairing every other screen in this app
     already uses. */
  const bgColor =
    msg.kind === 'success'
      ? colors.success.hex
      : msg.kind === 'error'
        ? colors.danger.hex
        : colors.surfaceRaised.hex;
  const textColor =
    msg.kind === 'success'
      ? colors.surface.hex
      : msg.kind === 'error'
        ? colors.dangerInk.hex
        : colors.ink.hex;

  return (
    <Animated.View
      style={[styles.toast, { backgroundColor: bgColor, opacity, transform: [{ translateY }] }]}
    >
      <Pressable style={styles.inner} onPress={onDismiss}>
        <Text style={[styles.text, { color: textColor }]} numberOfLines={2}>
          {msg.text}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    bottom: 90,
    left: 16,
    right: 16,
    borderRadius: radiusCard + 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.18,
    shadowRadius: 6,
    elevation: 6,
    zIndex: 9999,
  },
  inner: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  text: {
    /* No color here — always overridden per-kind above (see `textColor`). */
    fontSize: 14,
    fontWeight: '500',
  },
});
