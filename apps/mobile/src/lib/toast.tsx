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

  const bgColor =
    msg.kind === 'success' ? '#22c55e' : msg.kind === 'error' ? colors.danger.hex : colors.ink.hex;

  return (
    <Animated.View
      style={[styles.toast, { backgroundColor: bgColor, opacity, transform: [{ translateY }] }]}
    >
      <Pressable style={styles.inner} onPress={onDismiss}>
        <Text style={styles.text} numberOfLines={2}>
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
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
});
