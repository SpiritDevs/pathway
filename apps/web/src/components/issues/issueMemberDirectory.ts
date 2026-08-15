import { useAtomValue } from "@effect/atom-react";
import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { MembershipEntity } from "@spiritdevs/client-runtime/sync";
import type { IssueAssignee } from "@spiritdevs/contracts";
import type { MembershipId } from "@spiritdevs/contracts/company";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { activeCompanyReplicaRoutingAtom } from "~/cloud/activeCompany";
import {
  companyRegistryMembershipIdsAtom,
  companyRegistryReplicasAtom,
} from "~/cloud/companyRegistryReplica";

export interface IssueMemberOption {
  readonly membershipId: MembershipId;
  readonly label: string;
}

export interface IssueMemberDirectory {
  readonly currentMembershipId: MembershipId | null;
  readonly names: ReadonlyMap<string, string>;
  readonly assignableMembers: ReadonlyArray<IssueMemberOption>;
}

const isMembershipEntity = Schema.is(MembershipEntity);

export function issueMemberDirectoryFromReplica(
  replica: CompanyRegistryReplicaState | null,
  currentMembershipId: MembershipId | null,
): IssueMemberDirectory {
  const names = new Map<string, string>();
  const assignableMembers: IssueMemberOption[] = [];
  for (const entity of replica?.view.values() ?? []) {
    if (!isMembershipEntity(entity)) continue;
    const displayName = entity.displayNameSnapshot.trim() || entity.emailSnapshot;
    const label = entity.state === "left" ? `${displayName} (departed)` : displayName;
    names.set(entity.id, label);
    if (entity.state === "active") assignableMembers.push({ membershipId: entity.id, label });
  }
  assignableMembers.sort((left, right) => {
    if (left.membershipId === currentMembershipId) return -1;
    if (right.membershipId === currentMembershipId) return 1;
    return left.label.localeCompare(right.label);
  });
  return { currentMembershipId, names, assignableMembers };
}

export function issueMemberName(
  directory: Pick<IssueMemberDirectory, "names">,
  membershipId: string,
): string {
  return directory.names.get(membershipId) ?? "Unknown member";
}

export function issueAssigneeDisplayName(
  directory: IssueMemberDirectory,
  assignee: IssueAssignee | null,
): string {
  if (assignee === null) return "Unassigned";
  if (assignee.kind === "user") return "You";
  if (assignee.kind === "member") return issueMemberName(directory, assignee.membershipId);
  return assignee.provider;
}

export const activeIssueMemberDirectoryAtom = Atom.make((get): IssueMemberDirectory => {
  const companyId = get(activeCompanyReplicaRoutingAtom);
  if (companyId === null) return issueMemberDirectoryFromReplica(null, null);
  return issueMemberDirectoryFromReplica(
    get(companyRegistryReplicasAtom).get(companyId) ?? null,
    get(companyRegistryMembershipIdsAtom).get(companyId) ?? null,
  );
}).pipe(Atom.withLabel("cloud-sync:active-issue-member-directory"));

export function useIssueMemberDirectory(): IssueMemberDirectory {
  return useAtomValue(activeIssueMemberDirectoryAtom);
}
