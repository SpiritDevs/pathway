/**
 * Last-owner protection. Every path that can strip ownership — removing an owner, locking a
 * membership, leaving a company — funnels through here so a company can never end up unadministered.
 *
 * @module ownership
 */

export type OwnershipChangeRejection = "last-owner-protected";

/**
 * Owner set after `removing` is applied, given the owners that are currently effective. A
 * membership that is locked or has left is not an effective owner, so the caller passes only
 * active owner memberships.
 */
export function remainingOwners(
  activeOwnerMembershipIds: readonly string[],
  removing: readonly string[],
): readonly string[] {
  const removed = new Set(removing);
  return activeOwnerMembershipIds.filter((membershipId) => !removed.has(membershipId));
}

export function wouldRemoveLastOwner(
  activeOwnerMembershipIds: readonly string[],
  removing: readonly string[],
): boolean {
  return remainingOwners(activeOwnerMembershipIds, removing).length === 0;
}

export function checkOwnershipChange(
  activeOwnerMembershipIds: readonly string[],
  removing: readonly string[],
): OwnershipChangeRejection | null {
  return wouldRemoveLastOwner(activeOwnerMembershipIds, removing) ? "last-owner-protected" : null;
}
