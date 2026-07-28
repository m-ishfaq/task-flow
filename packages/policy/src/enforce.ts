import { errors } from '@taskflow/contracts';
import { can, type Decision, type Subject, type Target } from './decide.js';
import { isPermission, resourceOf, type Permission } from './permissions.js';

/**
 * Turns a denial into the right HTTP failure.
 *
 * The interesting decision is 404 vs 403. Answering "403 Forbidden" tells the
 * caller the resource EXISTS — which, across tenants, confirms another
 * organization's data and lets an attacker enumerate ids through a permission
 * check rather than a data leak (§8.7).
 *
 * So: if the subject cannot even read this kind of resource, the resource is
 * invisible and the answer is 404. If they can read it but not perform this
 * action, 403 is honest and more useful — they can see the thing and are being
 * told they may not change it.
 */
export function enforce(subject: Subject, permission: Permission, target?: Target): Decision {
  const decision = can(subject, permission, target);
  if (decision.allowed) return decision;

  throw denialFor(subject, permission, target);
}

function denialFor(subject: Subject, permission: Permission, target?: Target): Error {
  const readPermission = `${resourceOf(permission)}:read`;

  // Not every resource type has a `:read` permission (there is no `sms:read` on
  // an outbound send path, for instance). When there is nothing to compare
  // against, the safer answer is the one that reveals less.
  if (!isPermission(readPermission)) {
    return errors.notFound();
  }

  const visible = can(subject, readPermission, target).allowed;

  return visible
    ? errors.forbidden('You do not have permission to perform this action.')
    : errors.notFound();
}
