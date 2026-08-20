import { Redirect, Slot } from 'expo-router';
import { useSession } from '../../src/lib/use-session.js';

/**
 * Guards every unauthenticated-only screen (ai/phase-14-mobile.md §7): once a
 * session exists, sign-in has nothing left to offer — bouncing straight to
 * `/home` is what stops a signed-in user from landing back on the sign-in form
 * via a stale deep link or the hardware back button.
 */
export default function AuthLayout() {
  const status = useSession((state) => state.status);
  if (status === 'authenticated') return <Redirect href="/home" />;
  return <Slot />;
}
