import type { MembershipId } from "@spiritdevs/contracts/company";
import {
  companyDirectoryFromReplicaValues,
  deriveCurrentMemberPermissions,
} from "../settings/company/companySettings.logic";

/** Directory writes require a company-wide grant, including favorites and local imports. */
export function canManageContactsFromReplica(
  values: Iterable<unknown>,
  membershipId: MembershipId | null,
): boolean {
  const directory = companyDirectoryFromReplicaValues(values);
  if (
    !directory.company ||
    !membershipId ||
    !directory.memberships.some((member) => member.id === membershipId && member.state === "active")
  )
    return false;
  const permissions = deriveCurrentMemberPermissions({
    directory,
    membershipId,
    isOwner: directory.company.owners.some((owner) => owner.membershipId === membershipId),
  });
  return (
    permissions.status === "known" &&
    (permissions.isOwner || permissions.company.has("projects.manage"))
  );
}
