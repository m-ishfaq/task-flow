/**
 * @taskflow/policy — the one module that decides what anyone may do.
 *
 * Guardrail 7 (PLAN.md §2.1) makes `role === '...'` a lint error everywhere
 * else in the workspace, which is what forces every authorization question
 * through here. The point is not that inline checks are ugly; it is that they
 * are invisible to the matrix test, so they keep granting what the matrix has
 * since revoked.
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2).
 */

export {
  PERMISSIONS,
  RESOURCE_TYPES,
  isPermission,
  isReadOnly,
  resourceOf,
  type Permission,
  type ResourceType,
} from './permissions.js';

export {
  ROLES,
  ROLE_PERMISSIONS,
  roleGrants,
  bypassesRestrictions,
  isRole,
  type Role,
} from './roles.js';

export {
  isIndispensableRole,
  isDirectlyAssignable,
  isOwnershipTransferEligible,
  sameRole,
  DIRECTLY_ASSIGNABLE_ROLES,
} from './assignment.js';

export {
  RELATIONS,
  relationGrants,
  isRestrictive,
  isRelation,
  permissionsForRelation,
  formatTuple,
  type Relation,
  type RelationshipTuple,
  type ResourceRef,
} from './tuples.js';

export {
  can,
  allowed,
  couldGrant,
  formatTrace,
  type Decision,
  type PolicyLayer,
  type Subject,
  type Target,
  type TraceStep,
} from './decide.js';

export { enforce } from './enforce.js';
