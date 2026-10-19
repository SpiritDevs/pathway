import { useAtomValue } from "@effect/atom-react";
import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { MembershipEntity } from "@spiritdevs/client-runtime/sync";
import type { IssueAssignee } from "@spiritdevs/contracts";
import type { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { activeCompanyIdAtom, scopedCompanyRegistryReplicasAtom } from "~/cloud/activeCompany";
import { companyRegistryMembershipIdsAtom } from "~/cloud/companyRegistryReplica";

export interface IssueMemberOption {
  /** Present for replica-backed directories; optional only for legacy/test callers. */
  readonly companyId?: CompanyId;
  readonly membershipId: MembershipId;
  readonly label: string;
}

export interface CompanyIssueMemberDirectory {
  readonly companyId: CompanyId;
  readonly currentMembershipId: MembershipId | null;
  readonly names: ReadonlyMap<string, string>;
  readonly assignableMembers: ReadonlyArray<IssueMemberOption>;
}

export interface IssueMemberDirectory {
  readonly currentMembershipId: MembershipId | null;
  readonly currentMembershipIds: ReadonlyMap<CompanyId, MembershipId>;
  readonly names: ReadonlyMap<string, string>;
  readonly assignableMembers: ReadonlyArray<IssueMemberOption>;
  readonly byCompany: ReadonlyMap<CompanyId, CompanyIssueMemberDirectory>;
  readonly companyIdsByMembershipId: ReadonlyMap<string, ReadonlySet<CompanyId>>;
}

const isMembershipEntity = Schema.is(MembershipEntity);

function companyIssueMemberDirectoryFromReplica(
  companyId: CompanyId,
  replica: CompanyRegistryReplicaState | null,
  currentMembershipId: MembershipId | null,
): CompanyIssueMemberDirectory {
  const names = new Map<string, string>();
  const assignableMembers: IssueMemberOption[] = [];
  for (const entity of replica?.view.values() ?? []) {
    if (!isMembershipEntity(entity)) continue;
    const displayName = entity.displayNameSnapshot.trim() || entity.emailSnapshot;
    const label = entity.state === "left" ? `${displayName} (departed)` : displayName;
    names.set(entity.id, label);
    if (entity.state === "active") {
      assignableMembers.push({ companyId, membershipId: entity.id, label });
    }
  }
  assignableMembers.sort((left, right) => {
    if (left.membershipId === currentMembershipId) return -1;
    if (right.membershipId === currentMembershipId) return 1;
    return left.label.localeCompare(right.label);
  });
  return { companyId, currentMembershipId, names, assignableMembers };
}

export function issueMemberDirectoryFromReplicas(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
  currentMembershipIds: ReadonlyMap<CompanyId, MembershipId>,
  selectedCompanyId: CompanyId | null,
): IssueMemberDirectory {
  const byCompany = new Map<CompanyId, CompanyIssueMemberDirectory>();
  const companyIdsByMembershipId = new Map<string, Set<CompanyId>>();
  const names = new Map<string, string>();
  const ambiguousNames = new Set<string>();
  const assignableMembers: IssueMemberOption[] = [];
  const scopedCurrentMembershipIds = new Map<CompanyId, MembershipId>();

  for (const [companyId, replica] of replicas) {
    const currentMembershipId = currentMembershipIds.get(companyId) ?? null;
    if (currentMembershipId !== null) {
      scopedCurrentMembershipIds.set(companyId, currentMembershipId);
    }
    const directory = companyIssueMemberDirectoryFromReplica(
      companyId,
      replica,
      currentMembershipId,
    );
    byCompany.set(companyId, directory);
    assignableMembers.push(...directory.assignableMembers);
    for (const [membershipId, label] of directory.names) {
      const owners = companyIdsByMembershipId.get(membershipId) ?? new Set<CompanyId>();
      owners.add(companyId);
      companyIdsByMembershipId.set(membershipId, owners);
      if (owners.size === 1) names.set(membershipId, label);
      else {
        names.delete(membershipId);
        ambiguousNames.add(membershipId);
      }
    }
  }

  for (const membershipId of ambiguousNames) names.delete(membershipId);
  assignableMembers.sort(
    (left, right) =>
      left.label.localeCompare(right.label) ||
      (left.companyId ?? "").localeCompare(right.companyId ?? "") ||
      left.membershipId.localeCompare(right.membershipId),
  );
  const selected = selectedCompanyId === null ? null : (byCompany.get(selectedCompanyId) ?? null);
  return {
    currentMembershipId: selected?.currentMembershipId ?? null,
    currentMembershipIds: scopedCurrentMembershipIds,
    names: selected?.names ?? names,
    assignableMembers: selected?.assignableMembers ?? assignableMembers,
    byCompany,
    companyIdsByMembershipId,
  };
}

export function issueMemberDirectoryForCompany(
  directory: IssueMemberDirectory,
  companyId: CompanyId,
): CompanyIssueMemberDirectory | null {
  return directory.byCompany.get(companyId) ?? null;
}

/** Compatibility helper for callers and tests that already hold one company replica. */
export function issueMemberDirectoryFromReplica(
  replica: CompanyRegistryReplicaState | null,
  currentMembershipId: MembershipId | null,
): IssueMemberDirectory {
  const companyId = "legacy-company" as CompanyId;
  return issueMemberDirectoryFromReplicas(
    replica === null ? new Map() : new Map([[companyId, replica]]),
    currentMembershipId === null ? new Map() : new Map([[companyId, currentMembershipId]]),
    replica === null ? null : companyId,
  );
}

export function issueMemberName(
  directory: Pick<IssueMemberDirectory, "names">,
  membershipId: string,
): string {
  return directory.names.get(membershipId) ?? "Unknown member";
}

export function issueAssigneeDisplayName(
  directory: Pick<IssueMemberDirectory, "names">,
  assignee: IssueAssignee | null,
): string {
  if (assignee === null) return "Unassigned";
  if (assignee.kind === "user") return "You";
  if (assignee.kind === "member") return issueMemberName(directory, assignee.membershipId);
  return assignee.provider;
}

export const activeIssueMemberDirectoryAtom = Atom.make((get): IssueMemberDirectory => {
  const companyId = get(activeCompanyIdAtom);
  return issueMemberDirectoryFromReplicas(
    get(scopedCompanyRegistryReplicasAtom),
    get(companyRegistryMembershipIdsAtom),
    companyId,
  );
}).pipe(Atom.withLabel("cloud-sync:active-issue-member-directory"));

export function useIssueMemberDirectory(): IssueMemberDirectory {
  return useAtomValue(activeIssueMemberDirectoryAtom);
}
