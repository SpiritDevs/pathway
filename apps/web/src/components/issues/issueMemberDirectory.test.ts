import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { MembershipId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import {
  issueAssigneeDisplayName,
  issueMemberDirectoryFromReplica,
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

describe("issueMemberDirectoryFromReplica", () => {
  it("names active and departed members while offering only active memberships", () => {
    const current = MembershipId.make("member-current");
    const replica: CompanyRegistryReplicaState = {
      view: new Map([
        ["membership:departed", membership("member-departed", "Grace", "left")],
        ["membership:other", membership("member-other", "Ada", "active")],
        ["membership:current", membership("member-current", "Corey", "active")],
      ]),
    };
    const directory = issueMemberDirectoryFromReplica(replica, current);

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
});
