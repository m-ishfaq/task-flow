import { Redirect } from 'expo-router';
import { useSession } from '../src/lib/use-session.js';

/**
 * The auth gate's second half (ai/phase-14-mobile.md §7).
 *
 * Only reachable once the root layout has taken `status` out of `'restoring'`
 * (it renders a splash and no `<Slot />` until then), so this only ever has to
 * decide between the two settled states. Where `(app)` sends someone from here
 * is the ORG gate's job, not this route's — this file answers exactly one
 * question: "does this device hold a session".
 */
export default function Index() {
  const status = useSession((state) => state.status);
  return <Redirect href={status === 'authenticated' ? '/home' : '/sign-in'} />;
}
