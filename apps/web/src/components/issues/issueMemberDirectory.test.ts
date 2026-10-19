import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import {
  issueAssigneeDisplayName,
  issueMemberDirectoryForCompany,
  issueMemberDirectoryFromReplica,
  issueMemberDirectoryFromReplicas,
  issueMemberName,
} from "./issueMemberDirectory";

const membership = (
  id: string,
  displayNameSnapshot: string,
  state: "active" | "locked" | "left",
) => ({
  entityKind: "membership" as const,
  id: MembershipId.make(id),
  userId: `user-${id}`,
  state,
  displayNameSnapshot,
  emailSnapshot: `${id}@example.com`,
  invitedByMembershipId: null,
  joinedAt: 1,
  createdAt: 1,
  updatedAt: 1,
});

const COMPANY_A = CompanyId.make("company-a");
const COMPANY_B = CompanyId.make("company-b");

const replica = (...members: ReturnType<typeof membership>[]): CompanyRegistryReplicaState => ({
  view: new Map(members.map((member) => [`membership:${member.id}`, member])),
});

describe("issueMemberDirectoryFromReplica", () => {
  it("names active and departed members while offering only active memberships", () => {
    const current = MembershipId.make("member-current");
    const directory = issueMemberDirectoryFromReplica(
      replica(
        membership("member-departed", "Grace", "left"),
        membership("member-other", "Ada", "active"),
        membership("member-current", "Corey", "active"),
      ),
      current,
    );

    expect(directory.assignableMembers.map((member) => member.membershipId)).toEqual([
      current,
      "member-other",
    ]);
    expect(issueMemberName(directory, "member-departed")).toBe("Grace (departed)");
    expect(issueMemberName(directory, "missing")).toBe("Unknown member");
    expect(
      issueAssigneeDisplayName(directory, {
        kind: "member",
        membershipId: MembershipId.make("member-departed"),
      }),
    ).toBe("Grace (departed)");
  });

  it("aggregates All-company members while retaining authoritative company directories", () => {
    const memberA = MembershipId.make("member-a");
    const memberB = MembershipId.make("member-b");
    const directory = issueMemberDirectoryFromReplicas(
      new Map([
        [COMPANY_A, replica(membership(memberA, "Ada", "active"))],
        [COMPANY_B, replica(membership(memberB, "Grace", "active"))],
      ]),
      new Map([
        [COMPANY_A, memberA],
        [COMPANY_B, memberB],
      ]),
      null,
    );

    expect(directory.currentMembershipId).toBeNull();
    expect(directory.currentMembershipIds).toEqual(
      new Map([
        [COMPANY_A, memberA],
        [COMPANY_B, memberB],
      ]),
    );
    expect(directory.assignableMembers).toEqual([
      { companyId: COMPANY_A, membershipId: memberA, label: "Ada" },
      { companyId: COMPANY_B, membershipId: memberB, label: "Grace" },
    ]);
    expect(issueMemberDirectoryForCompany(directory, COMPANY_B)?.assignableMembers).toEqual([
      { companyId: COMPANY_B, membershipId: memberB, label: "Grace" },
    ]);
  });

  it("does not silently resolve a duplicate membership id across companies", () => {
    const duplicate = MembershipId.make("member-duplicate");
    const directory = issueMemberDirectoryFromReplicas(
      new Map([
        [COMPANY_A, replica(membership(duplicate, "Ada A", "active"))],
        [COMPANY_B, replica(membership(duplicate, "Ada B", "active"))],
      ]),
      new Map(),
      null,
    );

    expect(issueMemberName(directory, duplicate)).toBe("Unknown member");
    expect(directory.companyIdsByMembershipId.get(duplicate)).toEqual(
      new Set([COMPANY_A, COMPANY_B]),
    );
    expect(issueMemberDirectoryForCompany(directory, COMPANY_A)?.names.get(duplicate)).toBe(
      "Ada A",
    );
    expect(issueMemberDirectoryForCompany(directory, COMPANY_B)?.names.get(duplicate)).toBe(
      "Ada B",
    );
  });
});
